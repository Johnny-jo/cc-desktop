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

export class DiffTracker {
  private readonly sessions = new Map<string, Map<string, FileChange>>();
  private readonly readFile?: DiffTrackerDeps["readFile"];
  private readonly now: () => number;

  constructor(deps: DiffTrackerDeps = {}) {
    this.readFile = deps.readFile;
    this.now = deps.now ?? (() => Date.now());
  }

  onToolUse(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    if (toolName !== "Edit" && toolName !== "Write") return;

    const path = String(input.file_path ?? input.path ?? "");
    if (!path) return;

    const at = this.now();
    let map = this.sessions.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessions.set(sessionId, map);
    }

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

  list(sessionId: string): FileChange[] {
    const map = this.sessions.get(sessionId);
    if (!map) return [];
    return changesToArray(map);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
