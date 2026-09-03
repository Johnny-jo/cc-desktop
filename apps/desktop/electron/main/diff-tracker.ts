import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  buildEditHunk,
  buildWriteHunk,
  changesToArray,
  compactFileChange,
  newChangeEventId,
  truncateFileChange,
  upsertFileChange,
  type FileChange,
} from "@claude-desktop/shared";
import { resolveInside } from "./project-path";

export type DiffTrackerDeps = {
  /** Optional DI to read previous file content for Write; throw/fail → status A */
  readFile?: (path: string) => string;
  /** Optional DI for existence checks (markDeleted); defaults to fs.existsSync */
  fileExists?: (path: string) => boolean;
  now?: () => number;
};

/** Directories never walked during Bash post-scan (deps / build / VCS). */
const SCAN_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "release",
  ".next",
  ".cache",
  "coverage",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".idea",
  ".vscode",
  "vendor",
]);

/** Soft caps so huge repos stay snappy. */
const MAX_SCAN_FILES = 8000;
const MAX_GIT_PATHS = 200;
const MAX_MTIME_PATHS = 120;

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
  private readonly fileExists: (path: string) => boolean;
  private readonly now: () => number;
  /**
   * Per-session baseline for Bash post-scan: path → mtimeMs captured when
   * Bash tool_use is seen, compared after tool_result when git is unavailable.
   */
  private readonly bashBaselines = new Map<
    string,
    {
      cwd: string;
      at: number;
      mtimes: Map<string, number>;
      gen: number;
      mode: "git" | "mtime";
    }
  >();
  /** In-flight baseline walks, so refresh can wait without blocking the stream. */
  private readonly bashBaselineTasks = new Map<string, Promise<void>>();
  private readonly bashScanGen = new Map<string, number>();
  private bashScanSeq = 0;
  private readonly gitRepoChecks = new Map<string, Promise<boolean>>();
  /**
   * Called for EVERY tracked write operation BEFORE its change event is
   * recorded — the main process snapshots the file's current (pre-op)
   * content under the event id so the operation can be rolled back
   * individually.
   */
  onBeforeWrite?: (sessionId: string, path: string, eventId: string) => void;

  constructor(deps: DiffTrackerDeps = {}) {
    this.readFile = deps.readFile;
    this.fileExists =
      deps.fileExists ?? ((p: string) => fs.existsSync(p));
    this.now = deps.now ?? (() => Date.now());
  }

  private notifyBeforeWrite(
    sessionId: string,
    path: string,
    eventId: string,
  ): void {
    try {
      this.onBeforeWrite?.(sessionId, path, eventId);
    } catch {
      // snapshot failure must not break diff tracking
    }
  }

  onToolUse(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts?: { cwd?: string; toolUseId?: string },
  ): void {
    if (toolName === "Edit" || toolName === "Write") {
      this.onEditOrWrite(sessionId, toolName, input, opts?.toolUseId, opts?.cwd);
      return;
    }
    if (toolName === "Bash") {
      // One baseline per turn is enough. It is consumed by the single
      // end-of-turn refresh, instead of being replaced for every Bash call.
      if (
        opts?.cwd &&
        !this.bashBaselines.has(sessionId) &&
        !this.bashBaselineTasks.has(sessionId)
      ) {
        void this.captureBashBaseline(sessionId, opts.cwd);
      }
      this.onBashWrite(sessionId, input, opts?.cwd);
    }
  }

  /**
   * Snapshot mtimes under cwd so post-Bash scan can find files touched by
   * scripts (python writing yml, cp, etc.) when git is unavailable.
   */
  captureBashBaseline(sessionId: string, cwd: string): Promise<void> {
    if (!cwd) return Promise.resolve();
    this.bashScanSeq += 1;
    const gen = this.bashScanSeq;
    this.bashScanGen.set(sessionId, gen);
    const task = this.captureBashBaselineNow(sessionId, cwd, gen).catch(
      () => undefined,
    );
    this.bashBaselineTasks.set(sessionId, task);
    return task;
  }

  private async captureBashBaselineNow(
    sessionId: string,
    cwd: string,
    gen: number,
  ): Promise<void> {
    const root = path.resolve(cwd);
    const at = this.now();
    const git = await this.isGitRepository(root);
    const mtimes = git ? new Map<string, number>() : await walkMtimes(root);
    if ((this.bashScanGen.get(sessionId) ?? 0) !== gen) return;
    this.bashBaselines.set(sessionId, {
      cwd: root,
      at,
      mtimes,
      gen,
      mode: git ? "git" : "mtime",
    });
  }

  private isGitRepository(cwd: string): Promise<boolean> {
    const root = path.resolve(cwd);
    const cached = this.gitRepoChecks.get(root);
    if (cached) return cached;
    const check = new Promise<boolean>((resolve) => {
      execFile(
        "git",
        ["-C", root, "rev-parse", "--is-inside-work-tree"],
        { encoding: "utf8", timeout: 2000, windowsHide: true },
        (err, stdout) => resolve(!err && stdout.trim() === "true"),
      );
    });
    this.gitRepoChecks.set(root, check);
    return check;
  }

  private onEditOrWrite(
    sessionId: string,
    toolName: "Edit" | "Write",
    input: Record<string, unknown>,
    toolUseId?: string,
    cwd?: string,
  ): void {
    const path = resolveUnderCwd(cwd, String(input.file_path ?? input.path ?? ""));
    if (!path) return;

    const at = this.now();
    const eventId = newChangeEventId();
    this.notifyBeforeWrite(sessionId, path, eventId);
    let map = this.sessions.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessions.set(sessionId, map);
    }

    if (toolName === "Edit") {
      const oldString = String(input.old_string ?? "");
      const newString = String(input.new_string ?? "");
      const replaceAll = Boolean(
        input.replace_all ?? input.replaceAll ?? false,
      );
      // Read full file BEFORE the edit so line numbers are absolute file lines,
      // not relative to the old_string snippet (which always looked like "from 1").
      let previousContent: string | null = null;
      if (this.readFile) {
        try {
          previousContent = this.readFile(path);
        } catch {
          previousContent = null;
        }
      }
      const hunk = buildEditHunk({
        path,
        oldString,
        newString,
        previousContent,
        replaceAll,
      });
      this.sessions.set(
        sessionId,
        upsertFileChange(map, {
          id: eventId,
          path,
          tool: "Edit",
          hunk,
          at,
          status: "M",
          toolUseId,
        }),
      );
      return;
    }

    // Write
    // Cap content used for preview — full multi‑MB dumps freeze DiffView.
    const nextContent = capText(String(input.content ?? ""));
    let previousContent: string | null = null;
    if (this.readFile) {
      try {
        previousContent = capText(this.readFile(path));
      } catch {
        previousContent = null;
      }
    }
    const status = previousContent == null ? "A" : "M";
    const hunk = buildWriteHunk({ path, previousContent, nextContent });
    this.sessions.set(
      sessionId,
      upsertFileChange(map, {
        id: eventId,
        path,
        tool: "Write",
        hunk,
        at,
        status,
        toolUseId,
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
    cwd?: string,
  ): void {
    const command = String(input.command ?? "");
    const rawPath = parseBashWriteTarget(command);
    if (!rawPath) return;
    const filePath = resolveUnderCwd(cwd, rawPath);

    const at = this.now();
    const eventId = newChangeEventId();
    this.notifyBeforeWrite(sessionId, filePath, eventId);
    let map = this.sessions.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessions.set(sessionId, map);
    }

    let previousContent: string | null = null;
    let nextContent = "";
    if (this.readFile) {
      try {
        // At tool_use time file may still be old; best-effort snapshot.
        previousContent = this.readFile(filePath);
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
      path: filePath,
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
        id: eventId,
        path: filePath,
        tool: "Bash",
        hunk: annotated,
        at,
        status,
      }),
    );
  }

  /**
   * After Bash completes:
   * 1) re-read disk for paths already tracked via Bash
   * 2) scan the workspace (git status, else mtime baseline) for files the
   *    shell/scripts touched that Edit/Write never saw (e.g. python → yml)
   */
  async refreshBashWritesFromDisk(
    sessionId: string,
    cwd?: string,
  ): Promise<void> {
    const pending = this.bashBaselineTasks.get(sessionId);
    if (pending) {
      try {
        await pending;
      } catch {
        // baseline optional
      }
    }

    if (this.readFile) {
      const map = this.sessions.get(sessionId);
      if (map) {
        const next = new Map(map);
        for (const [filePath, change] of map) {
          const lastBash = [...change.events]
            .reverse()
            .find((event) => event.tool === "Bash");
          if (!lastBash) continue;
          let content: string;
          try {
            content = this.readFile(filePath);
          } catch {
            continue;
          }
          const hunk = `${buildWriteHunk({
            path: filePath,
            previousContent: change.status === "A" ? null : "",
            nextContent: content,
          })}\n# via Bash (disk)`;
          const events = change.events.map((event) =>
            event.id === lastBash.id ? { ...event, hunk } : event,
          );
          next.set(
            filePath,
            compactFileChange({
              ...change,
              hunks: hunk,
              events,
            }),
          );
        }
        this.sessions.set(sessionId, next);
      }
    }

    // Only walk the worktree when this turn actually ran Bash. Edit/Write
    // turns must not re-import the whole dirty tree as "this turn".
    const scanCwd =
      cwd || this.bashBaselines.get(sessionId)?.cwd || undefined;
    if (scanCwd && this.bashBaselines.has(sessionId)) {
      await this.scanWorkspaceAfterBash(sessionId, scanCwd);
    }
    this.bashBaselines.delete(sessionId);
    this.bashBaselineTasks.delete(sessionId);
  }

  /**
   * Discover files changed by Bash-side tools that DiffTracker never saw
   * at tool_use time (scripts, cp, PowerShell, etc.).
   * Prefer `git status --porcelain`; fall back to mtime baseline.
   * Skips paths already tracked via Edit/Write (those already have events).
   */
  async scanWorkspaceAfterBash(sessionId: string, cwd: string): Promise<number> {
    const root = path.resolve(cwd);
    if (!root || !fs.existsSync(root)) return 0;

    const discovered = await this.discoverChangedPaths(sessionId, root);
    if (!discovered.length) return 0;

    let added = 0;
    for (const item of discovered) {
      if (this.recordScannedPath(sessionId, item.abs, item.status)) {
        added += 1;
      }
    }
    return added;
  }

  private async discoverChangedPaths(
    sessionId: string,
    root: string,
  ): Promise<Array<{ abs: string; status: "A" | "M" }>> {
    const baseline = this.bashBaselines.get(sessionId);
    const fromGit = await listGitChangedPaths(root);

    // Prefer git when available, but never dump the whole dirty worktree:
    // - always include untracked (??) — typical for script-generated yml
    // - include modified/added only if mtime advanced past our Bash baseline
    //   (or baseline missing → skip tracked M to avoid noise)
    if (fromGit) {
      const out: Array<{ abs: string; status: "A" | "M" }> = [];
      let nowMtimes: Map<string, number> | null = null;
      if (baseline?.mode === "mtime" && baseline.cwd === root) {
        try {
          nowMtimes = await walkMtimes(root);
        } catch {
          nowMtimes = null;
        }
      }
      for (const item of fromGit) {
        if (baseline?.mode === "git" && baseline.cwd === root) {
          try {
            const st = await fs.promises.stat(item.abs);
            // Allow for coarse filesystem timestamp precision on Windows.
            if (st.mtimeMs >= baseline.at - 1_000) out.push(item);
          } catch {
            // Deleted/unreadable paths have no content to display.
          }
        } else if (item.status === "A") {
          out.push(item);
        } else if (nowMtimes && baseline) {
          const m = nowMtimes.get(item.abs);
          const prev = baseline.mtimes.get(item.abs);
          if (m != null && (prev == null || m > prev)) {
            out.push(item);
          }
        }
        if (out.length >= MAX_GIT_PATHS) break;
      }
      return out;
    }

    if (!baseline || baseline.cwd !== root || baseline.mode !== "mtime") {
      // No baseline and no git — avoid marking the whole tree.
      return [];
    }
    const nowMtimes = await walkMtimes(root);
    const out: Array<{ abs: string; status: "A" | "M" }> = [];
    for (const [abs, mtime] of nowMtimes) {
      const prev = baseline.mtimes.get(abs);
      if (prev == null) {
        out.push({ abs, status: "A" });
      } else if (mtime > prev) {
        out.push({ abs, status: "M" });
      }
      if (out.length >= MAX_MTIME_PATHS) break;
    }
    return out;
  }

  private findTrackedChange(
    sessionId: string,
    absPath: string,
  ): FileChange | undefined {
    const map = this.sessions.get(sessionId);
    if (!map) return undefined;
    const direct = map.get(absPath);
    if (direct) return direct;
    const normalized = path.normalize(absPath);
    const normalizedLc = normalized.toLowerCase();
    for (const [tracked, change] of map) {
      const trackedNorm = path.normalize(tracked);
      if (trackedNorm === normalized || trackedNorm.toLowerCase() === normalizedLc) {
        return change;
      }
    }
    return undefined;
  }

  /**
   * Record a path found by post-Bash scan. Returns false when skipped
   * (binary, already tracked, unreadable).
   */
  private recordScannedPath(
    sessionId: string,
    absPath: string,
    statusHint: "A" | "M",
  ): boolean {
    if (!this.readFile) return false;
    if (looksBinaryPath(absPath)) return false;

    const existing = this.findTrackedChange(sessionId, absPath);
    if (existing) {
      // Already in the session change set — never append a scan event that
      // would make a previous-turn file look new.
      return false;
    }

    let content: string;
    try {
      content = this.readFile(absPath);
    } catch {
      return false;
    }
    // NUL → binary; skip
    if (content.includes("\0")) return false;
    content = capText(content);

    const eventId = newChangeEventId();
    // Snapshot current content before we "record" — for brand-new files
    // onBeforeWrite will mark ABSENT so rollback deletes them.
    this.notifyBeforeWrite(sessionId, absPath, eventId);

    let map = this.sessions.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessions.set(sessionId, map);
    }

    const status: "A" | "M" = statusHint;
    // For scan-discovered files we don't have pre-bash content in memory;
    // treat as full-file write for the hunk (A = new file, M = whole content).
    const previousContent = status === "A" ? null : "";
    const hunk = buildWriteHunk({
      path: absPath,
      previousContent,
      nextContent: content,
    });
    this.sessions.set(
      sessionId,
      upsertFileChange(map, {
        id: eventId,
        path: absPath,
        tool: "Bash",
        hunk: `${hunk}\n# via Bash (workspace scan)`,
        at: this.now(),
        status,
      }),
    );
    return true;
  }

  list(sessionId: string): FileChange[] {
    const map = this.sessions.get(sessionId);
    if (!map) return [];
    return changesToArray(map);
  }

  /**
   * Sync file-existence state: tracked paths that vanished from disk become
   * status "D" (deleted); a "D" path that reappears flips back to "M"
   * (or "A" if this session only ever added it).
   * Status "A" is left alone while the file is missing — Write records the
   * change at tool_use time, before the bytes land on disk.
   * Returns true when any status changed.
   */
  markDeleted(sessionId: string, cwd?: string): boolean {
    const map = this.sessions.get(sessionId);
    if (!map) return false;
    let next: Map<string, FileChange> | null = null;
    for (const [filePath, change] of map) {
      let exists = true;
      try {
        exists = this.fileExists(resolveUnderCwd(cwd, filePath));
      } catch {
        exists = true; // check failed — keep previous status
      }
      if (!exists && change.status !== "D") {
        if (change.status === "A") continue;
        next = next ?? new Map(map);
        next.set(filePath, {
          ...change,
          status: "D",
          updatedAt: this.now(),
        });
      } else if (exists && change.status === "D") {
        const wasAdded = change.events.some((e) => e.tool === "Write" || e.tool === "Bash");
        next = next ?? new Map(map);
        next.set(filePath, {
          ...change,
          status: wasAdded && change.events.every((e) => e.tool !== "Edit") ? "A" : "M",
          updatedAt: this.now(),
        });
      }
    }
    if (next) {
      this.sessions.set(sessionId, next);
      return true;
    }
    return false;
  }

  /** True when the session has tracked changes for the file. */
  has(sessionId: string, path: string): boolean {
    return this.sessions.get(sessionId)?.has(path) ?? false;
  }

  /** Find the change entry containing an event (for rollback). */
  findByEvent(
    sessionId: string,
    eventId: string,
  ): { path: string; change: FileChange } | null {
    const map = this.sessions.get(sessionId);
    if (!map) return null;
    for (const [path, change] of map) {
      if (change.events.some((e) => e.id === eventId)) {
        return { path, change };
      }
    }
    return null;
  }

  /**
   * Drop the given event and all LATER events of its file (post-rollback:
   * the file no longer carries those operations). Removes the file entry
   * when no events remain.
   */
  truncateAt(sessionId: string, path: string, fromEventId: string): void {
    const map = this.sessions.get(sessionId);
    const change = map?.get(path);
    if (!map || !change) return;
    const next = new Map(map);
    const truncated = truncateFileChange(change, fromEventId);
    if (truncated) next.set(path, truncated);
    else next.delete(path);
    this.sessions.set(sessionId, next);
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
      map.set(c.path, compactFileChange({
        path: c.path,
        status:
          c.status === "A" || c.status === "M" || c.status === "D"
            ? c.status
            : "M",
        hunks: c.hunks ?? "",
        updatedAt: c.updatedAt ?? Date.now(),
        events: Array.isArray(c.events)
          ? c.events.map((e, i) => ({
              id:
                typeof e.id === "string" && e.id
                  ? e.id
                  : // Legacy archives (pre event-ids): synthesize stable ids.
                    `legacy-${i}-${Number(e.at) || 0}`,
              tool:
                e.tool === "Edit" || e.tool === "Write" || e.tool === "Bash"
                  ? e.tool
                  : "Write",
              at: Number(e.at) || Date.now(),
              hunk: String(e.hunk ?? ""),
              ...(typeof e.toolUseId === "string" && e.toolUseId
                ? { toolUseId: e.toolUseId }
                : {}),
            }))
          : [],
      }));
    }
    this.sessions.set(sessionId, map);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.bashBaselines.delete(sessionId);
    this.bashBaselineTasks.delete(sessionId);
    this.bashScanGen.delete(sessionId);
  }
}

function resolveUnderCwd(cwd: string | undefined, raw: string): string {
  if (!cwd) return raw;
  const inside = resolveInside(cwd, raw);
  if (inside) return inside;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(cwd, raw);
}

function looksBinaryPath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|7z|rar|gz|tar|exe|dll|so|dylib|wasm|mp4|mp3|woff2?|ttf|eot|bin|dat|lock)$/i.test(
    p,
  );
}

/** Cap text fed into hunk builders (~120KB / 800 lines). */
function capText(text: string, maxChars = 120_000, maxLines = 800): string {
  if (!text) return text;
  if (text.length <= maxChars && text.length < maxLines * 40) {
    // cheap path: small enough by char budget
    const n = countNewlines(text);
    if (n <= maxLines) return text;
  }
  const lines = text.split("\n");
  let out =
    lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : text;
  if (out.length > maxChars) out = out.slice(0, maxChars);
  if (out.length < text.length) {
    out += "\n# … truncated for change preview …\n";
  }
  return out;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n += 1;
  return n;
}

/**
 * `git status --porcelain` → absolute paths with A/M.
 * Returns null when git is missing or cwd is not a repo.
 */
export function listGitChangedPaths(
  cwd: string,
): Promise<Array<{ abs: string; status: "A" | "M" }> | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "status", "--porcelain", "-uall", "--no-renames"],
      {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        const results: Array<{ abs: string; status: "A" | "M" }> = [];
        for (const line of lines) {
          if (line.length < 4) continue;
          // XY<path>  or XY <path> — untracked is "?? path"
          const code = line.slice(0, 2);
          let filePart = line.slice(3).trim();
          // renames disabled; still strip quotes git may add
          if (
            (filePart.startsWith('"') && filePart.endsWith('"')) ||
            (filePart.startsWith("'") && filePart.endsWith("'"))
          ) {
            filePart = filePart.slice(1, -1);
          }
          if (!filePart || filePart.endsWith("/")) continue;
          // Skip deletes for now (no content to show)
          if (
            code.includes("D") &&
            !code.includes("A") &&
            !code.includes("M") &&
            code !== "??"
          ) {
            continue;
          }
          const status: "A" | "M" =
            code === "??" || code.includes("A") ? "A" : "M";
          const abs = path.resolve(cwd, filePart);
          if (looksBinaryPath(abs)) continue;
          results.push({ abs, status });
          if (results.length >= MAX_GIT_PATHS) break;
        }
        resolve(results);
      },
    );
  });
}

/** Walk of mtimes under cwd for Bash baseline comparison. Yields the event loop. */
export async function walkMtimes(cwd: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const root = path.resolve(cwd);
  const stack: string[] = [root];
  let count = 0;
  let steps = 0;
  while (stack.length && count < MAX_SCAN_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (count >= MAX_SCAN_FILES) break;
      const name = e.name;
      if (name === "." || name === "..") continue;
      if (e.isDirectory()) {
        if (SCAN_IGNORED_DIRS.has(name)) continue;
        if (name.startsWith(".") && name !== ".claude") continue;
        stack.push(path.join(dir, name));
        continue;
      }
      if (!e.isFile()) continue;
      if (name.startsWith(".")) continue;
      const abs = path.join(dir, name);
      if (looksBinaryPath(abs)) continue;
      try {
        const st = await fs.promises.stat(abs);
        out.set(abs, st.mtimeMs);
        count += 1;
      } catch {
        // ignore
      }
    }
    steps += 1;
    if (steps % 24 === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }
  return out;
}
