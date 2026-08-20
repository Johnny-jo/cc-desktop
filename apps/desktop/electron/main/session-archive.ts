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

/** First paint / each "load older" page. */
export const TRANSCRIPT_PAGE = 40;

export type TranscriptPage = {
  items: ChatItem[];
  total: number;
  /** Older rows exist before this page. */
  hasMore: boolean;
  /** Newer rows exist after this page. */
  hasNewer: boolean;
};

/** Slice a transcript for the renderer sliding window. */
export function pageTranscriptItems(
  all: ChatItem[],
  opts?: { beforeId?: string; afterId?: string; limit?: number },
): TranscriptPage {
  const limit = opts?.limit && opts.limit > 0 ? opts.limit : TRANSCRIPT_PAGE;
  const total = all.length;

  if (opts?.afterId) {
    const idx = all.findIndex((i) => i.id === opts.afterId);
    if (idx < 0) {
      return { items: [], total, hasMore: total > 0, hasNewer: total > 0 };
    }
    const start = idx + 1;
    const end = Math.min(total, start + limit);
    return {
      items: all.slice(start, end),
      total,
      hasMore: start > 0,
      hasNewer: end < total,
    };
  }

  let end = total;
  if (opts?.beforeId) {
    const idx = all.findIndex((i) => i.id === opts.beforeId);
    if (idx < 0) {
      return { items: [], total, hasMore: total > 0, hasNewer: false };
    }
    end = idx;
  }
  const start = Math.max(0, end - limit);
  return {
    items: all.slice(start, end),
    total,
    hasMore: start > 0,
    hasNewer: end < total,
  };
}

function stripStreaming(item: ChatItem): ChatItem {
  if (item.kind === "text") {
    return { ...item, streaming: false };
  }
  return item;
}

/** Merge a renderer window into the on-disk transcript without dropping unread history. */
export function mergeTranscriptItems(
  disk: ChatItem[],
  incoming: ChatItem[],
): ChatItem[] {
  if (incoming.length === 0) return disk;
  if (disk.length === 0) return incoming.map(stripStreaming);
  const byId = new Map<string, ChatItem>();
  for (const item of disk) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, stripStreaming(item));
  const diskIds = new Set(disk.map((i) => i.id));
  const out = disk.map((i) => byId.get(i.id) ?? i);
  for (const item of incoming) {
    if (!diskIds.has(item.id)) out.push(stripStreaming(item));
  }
  return out;
}

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
        ...(s.contextUsage &&
        typeof s.contextUsage === "object" &&
        Number(s.contextUsage.usedTokens) >= 0 &&
        Number(s.contextUsage.limitTokens) > 0
          ? {
              contextUsage: {
                usedTokens: Number(s.contextUsage.usedTokens) || 0,
                limitTokens: Number(s.contextUsage.limitTokens) || 0,
                ratio: Number(s.contextUsage.ratio) || 0,
                source:
                  s.contextUsage.source === "cpa" ||
                  s.contextUsage.source === "builtin" ||
                  s.contextUsage.source === "override" ||
                  s.contextUsage.source === "default"
                    ? s.contextUsage.source
                    : "default",
                modelId: String(s.contextUsage.modelId ?? ""),
                updatedAt: Number(s.contextUsage.updatedAt) || Date.now(),
              },
            }
          : {}),
        ...(s.hiddenFromList ? { hiddenFromList: true } : {}),
        ...(s.pinned ? { pinned: true } : {}),
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
          ...(s.contextUsage ? { contextUsage: s.contextUsage } : {}),
          ...(s.hiddenFromList ? { hiddenFromList: true } : {}),
          ...(s.pinned ? { pinned: true } : {}),
        }))
        .sort((a, b) => Number(b.pinned ?? 0) - Number(a.pinned ?? 0) || b.updatedAt - a.updatedAt),
    };
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify(payload, null, 2), "utf8");
  }

  /** Remove a session from the index and delete its transcript / changes files. */
  remove(sessionId: string): void {
    const list = this.loadIndex().filter((s) => s.id !== sessionId);
    this.saveIndex(list);
    for (const file of [this.transcriptPath(sessionId), this.changesPath(sessionId)]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best effort
      }
    }
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
      return data.items.map(stripStreaming);
    } catch {
      return [];
    }
  }

  /**
   * Tail (or the page ending just before `beforeId`) for incremental UI restore.
   * Disk still holds the full transcript.
   */
  loadItemsPage(
    sessionId: string,
    opts?: { beforeId?: string; afterId?: string; limit?: number },
  ): TranscriptPage {
    return pageTranscriptItems(this.loadItems(sessionId), opts);
  }

  saveItems(sessionId: string, items: ChatItem[]): void {
    const file = this.transcriptPath(sessionId);
    const payload: TranscriptFile = {
      version: 1,
      sessionId,
      items: items.map(stripStreaming),
    };
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload), "utf8");
  }

  /** Persist a renderer window / live tail without wiping older disk rows. */
  mergeSaveItems(sessionId: string, incoming: ChatItem[]): void {
    const merged = mergeTranscriptItems(this.loadItems(sessionId), incoming);
    this.saveItems(sessionId, merged);
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
            ? c.events.map((e, i) => ({
                id:
                  typeof e.id === "string" && e.id
                    ? e.id
                    : `legacy-${i}-${Number(e.at) || 0}`,
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
