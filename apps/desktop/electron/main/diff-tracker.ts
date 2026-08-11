import {
  buildEditHunk,
  buildWriteHunk,
  changesToArray,
  upsertFileChange,
  type FileChange,
} from "@claude-desktop/shared";

export type DiffTrackerDeps = {
  /** Optional DI to read previous file content for Write; throw/fail → status A */
  readFile?: (path: string) => string;
  now?: () => number;
};

/**
 * Detect shell redirects that create/overwrite a file, e.g.:
 *   cat > foo.ts <<'EOF' ...
 *   cat > path/file.md <<EOF
 *   tee path/file.ts <<'EOF'
 * Returns absolute-ish path string as given in the command.
 */
export function parseBashWriteTarget(command: string): string | null {
  const cmd = command.trim();
  // cat/tee > file << ...
  const heredoc = cmd.match(
    /(?:^|[;&|\n])\s*(?:cat|tee)\s+>\s*['"]?([^\s'"]+)['"]?\s*<</,
  );
  if (heredoc?.[1]) return heredoc[1];

  // echo ... > file  (single redirect, not >>)
  const echoRedir = cmd.match(
    /(?:^|[;&|\n])\s*echo\s+[\s\S]*?[^>]>\s*['"]?([^\s'"]+)['"]?\s*$/,
  );
  if (echoRedir?.[1]) return echoRedir[1];

  // printf ... > file
  const printfRedir = cmd.match(
    /(?:^|[;&|\n])\s*printf\s+[\s\S]*?[^>]>\s*['"]?([^\s'"]+)['"]?\s*$/,
  );
  if (printfRedir?.[1]) return printfRedir[1];

  return null;
}

export class DiffTracker {
  private readonly sessions = new Map<string, Map<string, FileChange>>();
  private readonly readFile?: DiffTrackerDeps["readFile"];
  private readonly now: () => number;
  /**
   * Called the first time a file is touched within a session (before the
   * change event is recorded) — used by the main process to snapshot the
   * file's pre-session content for rollback.
   */
  onFirstWrite?: (sessionId: string, path: string) => void;

  constructor(deps: DiffTrackerDeps = {}) {
    this.readFile = deps.readFile;
    this.now = deps.now ?? (() => Date.now());
  }

  private notifyFirstWrite(
    sessionId: string,
    map: Map<string, FileChange>,
    path: string,
  ): void {
    if (map.has(path)) return;
    try {
      this.onFirstWrite?.(sessionId, path);
    } catch {
      // snapshot failure must not break diff tracking
    }
  }

  onToolUse(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    if (toolName === "Edit" || toolName === "Write") {
      this.onEditOrWrite(sessionId, toolName, input);
      return;
    }
    if (toolName === "Bash") {
      this.onBashWrite(sessionId, input);
    }
  }

  private onEditOrWrite(
    sessionId: string,
    toolName: "Edit" | "Write",
    input: Record<string, unknown>,
  ): void {
    const path = String(input.file_path ?? input.path ?? "");
    if (!path) return;

    const at = this.now();
    let map = this.sessions.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessions.set(sessionId, map);
    }
    this.notifyFirstWrite(sessionId, map, path);

    if (toolName === "Edit") {
      const oldString = String(input.old_string ?? "");
      const newString = String(input.new_string ?? "");
      const hunk = buildEditHunk({ path, oldString, newString });
      this.sessions.set(
        sessionId,
        upsertFileChange(map, {
          path,
          tool: "Edit",
          hunk,
          at,
          status: "M",
        }),
      );
      return;
    }

    // Write
    const nextContent = String(input.content ?? "");
    let previousContent: string | null = null;
    if (this.readFile) {
      try {
        previousContent = this.readFile(path);
      } catch {
        previousContent = null;
      }
    }
    const status = previousContent == null ? "A" : "M";
    const hunk = buildWriteHunk({ path, previousContent, nextContent });
    this.sessions.set(
      sessionId,
      upsertFileChange(map, {
        path,
        tool: "Write",
        hunk,
        at,
        status,
      }),
    );
  }

  /**
   * When the model writes via Bash (cat/tee heredoc, echo > file), still
   * surface a change entry. Prefer reading disk content after the tool runs;
   * at tool_use time we only know the path — use empty previous if unread.
   */
  private onBashWrite(
    sessionId: string,
    input: Record<string, unknown>,
  ): void {
    const command = String(input.command ?? "");
    const path = parseBashWriteTarget(command);
    if (!path) return;

    const at = this.now();
    let map = this.sessions.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessions.set(sessionId, map);
    }
    this.notifyFirstWrite(sessionId, map, path);

    let previousContent: string | null = null;
    let nextContent = "";
    if (this.readFile) {
      try {
        // At tool_use time file may still be old; best-effort snapshot.
        previousContent = this.readFile(path);
      } catch {
        previousContent = null;
      }
    }

    // Extract heredoc body if present for a better hunk before disk updates.
    const heredocBody = command.match(/<<['"]?(\w+)['"]?\n([\s\S]*?)\n\1/);
    if (heredocBody?.[2] != null) {
      nextContent = heredocBody[2];
    } else if (previousContent != null) {
      // Will refresh from disk on list if needed; mark as touch.
      nextContent = previousContent;
    }

    const status = previousContent == null ? "A" : "M";
    const hunk = buildWriteHunk({
      path,
      previousContent: status === "A" ? null : previousContent,
      nextContent:
        nextContent ||
        (status === "A"
          ? "# written via Bash (content not captured)\n"
          : previousContent ?? ""),
    });
    // Annotate that this came from Bash so UI can show source.
    const annotated = `${hunk}\n# via Bash`;
    this.sessions.set(
      sessionId,
      upsertFileChange(map, {
        path,
        tool: "Bash",
        hunk: annotated,
        at,
        status,
      }),
    );
  }

  /**
   * After Bash completes, re-read disk for paths already tracked via Bash
   * so hunks reflect real content.
   */
  refreshBashWritesFromDisk(sessionId: string): void {
    if (!this.readFile) return;
    const map = this.sessions.get(sessionId);
    if (!map) return;
    let next = map;
    for (const [path, change] of map) {
      const fromBash = change.events.some((e) => e.tool === "Bash");
      if (!fromBash) continue;
      let content: string;
      try {
        content = this.readFile(path);
      } catch {
        continue;
      }
      const status = change.status;
      const prevForHunk =
        status === "A" ? null : change.events.length > 1 ? null : null;
      const hunk = buildWriteHunk({
        path,
        previousContent: prevForHunk,
        nextContent: content,
      });
      next = upsertFileChange(next, {
        path,
        tool: "Bash",
        hunk: `${hunk}\n# via Bash (disk)`,
        at: this.now(),
        status,
      });
    }
    this.sessions.set(sessionId, next);
  }

  list(sessionId: string): FileChange[] {
    const map = this.sessions.get(sessionId);
    if (!map) return [];
    return changesToArray(map);
  }

  /** True when the session has tracked changes for the file. */
  has(sessionId: string, path: string): boolean {
    return this.sessions.get(sessionId)?.has(path) ?? false;
  }

  /** Remove one file from the session's change set (e.g. after rollback). */
  remove(sessionId: string, path: string): void {
    const map = this.sessions.get(sessionId);
    if (!map) return;
    if (!map.has(path)) return;
    const next = new Map(map);
    next.delete(path);
    this.sessions.set(sessionId, next);
  }

  /** Restore a full change set from disk (overwrites in-memory map for session). */
  hydrate(sessionId: string, changes: FileChange[]): void {
    const map = new Map<string, FileChange>();
    for (const c of changes) {
      if (!c?.path) continue;
      map.set(c.path, {
        path: c.path,
        status: c.status === "A" || c.status === "M" ? c.status : "M",
        hunks: c.hunks ?? "",
        updatedAt: c.updatedAt ?? Date.now(),
        events: Array.isArray(c.events) ? [...c.events] : [],
      });
    }
    this.sessions.set(sessionId, map);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
