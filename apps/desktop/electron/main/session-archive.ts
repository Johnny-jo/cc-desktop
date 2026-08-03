import fs from "node:fs";
import path from "node:path";
import type { ChatItem, FileChange, SessionSummary } from "@claude-desktop/shared";

export type StoredSession = SessionSummary & {
  sdkSessionId?: string;
};

type IndexFile = {
  version: 1;
  sessions: StoredSession[];
};

type TranscriptFile = {
  version: 1;
  sessionId: string;
  items: ChatItem[];
};

type ChangesFile = {
  version: 1;
  sessionId: string;
  changes: FileChange[];
};

/**
 * Disk persistence for session list + per-session chat transcripts.
 * Lives under Electron userData/sessions/.
 */
export class SessionArchive {
  private readonly root: string;
  private readonly indexPath: string;

  constructor(userDataDir: string) {
    this.root = path.join(userDataDir, "sessions");
    this.indexPath = path.join(this.root, "index.json");
    fs.mkdirSync(this.root, { recursive: true });
  }

  loadIndex(): StoredSession[] {
    try {
      if (!fs.existsSync(this.indexPath)) return [];
      const raw = fs.readFileSync(this.indexPath, "utf8");
      const data = JSON.parse(raw) as IndexFile;
      if (!Array.isArray(data.sessions)) return [];
      return data.sessions.map((s) => ({
        id: String(s.id),
        title: String(s.title ?? "Session"),
        cwd: String(s.cwd ?? ""),
        updatedAt: Number(s.updatedAt) || Date.now(),
        status:
          s.status === "running" || s.status === "error" || s.status === "idle"
            ? s.status === "running"
              ? "idle" // never restore as running after restart
              : s.status
            : "idle",
        sdkSessionId:
          typeof s.sdkSessionId === "string" ? s.sdkSessionId : undefined,
        ...(s.usage && typeof s.usage === "object"
          ? {
              usage: {
                inputTokens: Number(s.usage.inputTokens) || 0,
                outputTokens: Number(s.usage.outputTokens) || 0,
                cacheReadTokens: Number(s.usage.cacheReadTokens) || 0,
                cacheCreationTokens: Number(s.usage.cacheCreationTokens) || 0,
                costUsd: Number(s.usage.costUsd) || 0,
                durationMs: Number(s.usage.durationMs) || 0,
                turns: Number(s.usage.turns) || 0,
              },
            }
          : {}),
      }));
    } catch {
      return [];
    }
  }

  saveIndex(sessions: StoredSession[]): void {
    const payload: IndexFile = {
      version: 1,
      sessions: sessions
        .map((s) => ({
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          updatedAt: s.updatedAt,
          status: s.status === "running" ? "idle" : s.status,
          ...(s.sdkSessionId ? { sdkSessionId: s.sdkSessionId } : {}),
          ...(s.usage ? { usage: s.usage } : {}),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    };
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify(payload, null, 2), "utf8");
  }

  upsertSummary(summary: StoredSession): void {
    const list = this.loadIndex();
    const idx = list.findIndex((s) => s.id === summary.id);
    const next: StoredSession = {
      ...summary,
      status: summary.status === "running" ? summary.status : summary.status,
    };
    if (idx >= 0) list[idx] = { ...list[idx], ...next };
    else list.unshift(next);
    this.saveIndex(list);
  }

  loadItems(sessionId: string): ChatItem[] {
    const file = this.transcriptPath(sessionId);
    try {
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, "utf8");
      const data = JSON.parse(raw) as TranscriptFile;
      if (!Array.isArray(data.items)) return [];
      // Drop streaming flags on load
      return data.items.map((item) => {
        if (item.kind === "text") {
          return { ...item, streaming: false };
        }
        return item;
      });
    } catch {
      return [];
    }
  }

  saveItems(sessionId: string, items: ChatItem[]): void {
    const file = this.transcriptPath(sessionId);
    const payload: TranscriptFile = {
      version: 1,
      sessionId,
      items: items.map((item) => {
        if (item.kind === "text") {
          const { streaming: _s, ...rest } = item;
          return { ...rest, streaming: false };
        }
        return item;
      }),
    };
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  }

  loadChanges(sessionId: string): FileChange[] {
    const file = this.changesPath(sessionId);
    try {
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, "utf8");
      const data = JSON.parse(raw) as ChangesFile;
      if (!Array.isArray(data.changes)) return [];
      return data.changes
        .filter((c) => c && typeof c.path === "string")
        .map((c) => ({
          path: String(c.path),
          status: c.status === "A" || c.status === "M" ? c.status : "M",
          hunks: String(c.hunks ?? ""),
          updatedAt: Number(c.updatedAt) || Date.now(),
          events: Array.isArray(c.events)
            ? c.events.map((e) => ({
                tool:
                  e.tool === "Edit" || e.tool === "Write" || e.tool === "Bash"
                    ? e.tool
                    : "Write",
                at: Number(e.at) || Date.now(),
                hunk: String(e.hunk ?? ""),
              }))
            : [],
        }));
    } catch {
      return [];
    }
  }

  saveChanges(sessionId: string, changes: FileChange[]): void {
    const file = this.changesPath(sessionId);
    const payload: ChangesFile = {
      version: 1,
      sessionId,
      changes,
    };
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  }

  private safeId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private transcriptPath(sessionId: string): string {
    return path.join(this.root, `${this.safeId(sessionId)}.json`);
  }

  private changesPath(sessionId: string): string {
    return path.join(this.root, `${this.safeId(sessionId)}.changes.json`);
  }
}
