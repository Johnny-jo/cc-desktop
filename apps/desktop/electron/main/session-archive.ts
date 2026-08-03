import fs from "node:fs";
import path from "node:path";
import type { ChatItem, SessionSummary } from "@claude-desktop/shared";

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

  private transcriptPath(sessionId: string): string {
    // sanitize id for filesystem
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.root, `${safe}.json`);
  }
}
