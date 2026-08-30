import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChatItem,
  FileChange,
  RoomTimelineItem,
} from "@claude-desktop/shared";

const DATABASE_FILE = "cc-desktop.sqlite3";
const ROOM_HISTORY_LIMIT = 50;
const ROOM_ITEM_LIMIT = 400;

type DatabaseConstructor = new (location: string) => DatabaseSync;
type RoomLike = {
  roomId: string;
  updatedAt: number;
  items: RoomTimelineItem[];
  [key: string]: unknown;
};

type RoomRow = {
  room_id: string;
  metadata_json: string;
};

type TimelineRow = {
  item_id: string;
  item_json: string;
};

type SessionLike = {
  id: string;
  updatedAt: number;
  pinned?: boolean;
  [key: string]: unknown;
};

type SessionRow = {
  summary_json: string;
};

type SessionItemRow = {
  ordinal: number;
  item_json: string;
};

function searchableChatText(item: ChatItem): string {
  const row = item as unknown as Record<string, unknown>;
  return [row.text, row.thinking, row.summary, row.name]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

/**
 * Main-process SQLite owner. `node:sqlite` is loaded lazily so the existing
 * Node 20 Vitest runner can keep exercising the JSON compatibility path;
 * Electron 43+ always supplies Node 24 and therefore opens this database.
 */
export class AppDatabase {
  static open(userDataDir: string): AppDatabase | null {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      const requireFromApp = createRequire(
        path.join(userDataDir, "cc-desktop-sqlite-loader.cjs"),
      );
      const sqlite = requireFromApp("node:sqlite") as {
        DatabaseSync: DatabaseConstructor;
      };
      return new AppDatabase(
        new sqlite.DatabaseSync(path.join(userDataDir, DATABASE_FILE)),
      );
    } catch {
      return null;
    }
  }

  private closed = false;

  private constructor(private readonly db: DatabaseSync) {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_archive (
        room_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS room_archive_updated
        ON room_archive(updated_at DESC);
      CREATE TABLE IF NOT EXISTS room_timeline (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_at INTEGER NOT NULL,
        item_text TEXT NOT NULL,
        item_json TEXT NOT NULL,
        UNIQUE(room_id, item_id),
        FOREIGN KEY(room_id) REFERENCES room_archive(room_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS room_timeline_room_order
        ON room_timeline(room_id, ordinal);
      CREATE TABLE IF NOT EXISTS mod_kv (
        room_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(room_id, namespace, key)
      );
      CREATE TABLE IF NOT EXISTS session_archive (
        session_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_archive_order
        ON session_archive(pinned DESC, updated_at DESC);
      CREATE TABLE IF NOT EXISTS session_transcript (
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        item_text TEXT NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY(session_id, ordinal),
        UNIQUE(session_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS session_transcript_item
        ON session_transcript(session_id, item_id);
      CREATE TABLE IF NOT EXISTS session_changes (
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        change_json TEXT NOT NULL,
        PRIMARY KEY(session_id, path)
      );
      CREATE INDEX IF NOT EXISTS session_changes_order
        ON session_changes(session_id, ordinal);
      PRAGMA user_version = 2;
    `);
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM app_meta WHERE key = ?")
      .get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  loadSessions<T extends SessionLike>(): T[] {
    const rows = this.db
      .prepare(
        `SELECT summary_json FROM session_archive
         ORDER BY pinned DESC, updated_at DESC`,
      )
      .all() as unknown as SessionRow[];
    const sessions: T[] = [];
    for (const row of rows) {
      try {
        sessions.push(JSON.parse(row.summary_json) as T);
      } catch {
        // Ignore a corrupt row without preventing the rest of the history.
      }
    }
    return sessions;
  }

  hasSession(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 AS found FROM session_archive WHERE session_id = ? LIMIT 1",
        )
        .get(sessionId),
    );
  }

  upsertSession<T extends SessionLike>(session: T): void {
    this.db
      .prepare(
        `INSERT INTO session_archive(session_id, updated_at, pinned, summary_json)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           pinned = excluded.pinned,
           summary_json = excluded.summary_json`,
      )
      .run(
        session.id,
        session.updatedAt,
        session.pinned ? 1 : 0,
        JSON.stringify(session),
      );
  }

  replaceSessions<T extends SessionLike>(sessions: T[]): void {
    const incoming = new Set(sessions.map((session) => session.id));
    this.transaction(() => {
      for (const session of sessions) this.upsertSession(session);
      const rows = this.db
        .prepare("SELECT session_id FROM session_archive")
        .all() as unknown as Array<{ session_id: string }>;
      const remove = this.db.prepare(
        "DELETE FROM session_archive WHERE session_id = ?",
      );
      for (const row of rows) {
        if (!incoming.has(row.session_id)) remove.run(row.session_id);
      }
    });
  }

  removeSession(sessionId: string): void {
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM session_archive WHERE session_id = ?")
        .run(sessionId);
      this.db
        .prepare("DELETE FROM session_transcript WHERE session_id = ?")
        .run(sessionId);
      this.db
        .prepare("DELETE FROM session_changes WHERE session_id = ?")
        .run(sessionId);
    });
  }

  hasSessionItems(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 AS found FROM session_transcript WHERE session_id = ? LIMIT 1",
        )
        .get(sessionId),
    );
  }

  loadSessionItems(sessionId: string): ChatItem[] {
    const rows = this.db
      .prepare(
        `SELECT ordinal, item_json FROM session_transcript
         WHERE session_id = ? ORDER BY ordinal`,
      )
      .all(sessionId) as unknown as SessionItemRow[];
    return this.parseSessionItems(rows);
  }

  loadSessionItemsPage(
    sessionId: string,
    opts?: { beforeId?: string; afterId?: string; limit?: number },
  ): {
    items: ChatItem[];
    total: number;
    hasMore: boolean;
    hasNewer: boolean;
  } {
    const countRow = this.db
      .prepare(
        "SELECT COUNT(*) AS total FROM session_transcript WHERE session_id = ?",
      )
      .get(sessionId) as { total?: number } | undefined;
    const total = Number(countRow?.total) || 0;
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 40;
    let start = 0;
    let end = total;

    if (opts?.afterId) {
      const boundary = this.db
        .prepare(
          `SELECT ordinal FROM session_transcript
           WHERE session_id = ? AND item_id = ?`,
        )
        .get(sessionId, opts.afterId) as { ordinal?: number } | undefined;
      if (!Number.isInteger(boundary?.ordinal)) {
        return { items: [], total, hasMore: total > 0, hasNewer: total > 0 };
      }
      start = Number(boundary!.ordinal) + 1;
      end = Math.min(total, start + limit);
    } else {
      if (opts?.beforeId) {
        const boundary = this.db
          .prepare(
            `SELECT ordinal FROM session_transcript
             WHERE session_id = ? AND item_id = ?`,
          )
          .get(sessionId, opts.beforeId) as { ordinal?: number } | undefined;
        if (!Number.isInteger(boundary?.ordinal)) {
          return { items: [], total, hasMore: total > 0, hasNewer: false };
        }
        end = Number(boundary!.ordinal);
      }
      start = Math.max(0, end - limit);
    }

    const rows = this.db
      .prepare(
        `SELECT ordinal, item_json FROM session_transcript
         WHERE session_id = ? AND ordinal >= ? AND ordinal < ?
         ORDER BY ordinal`,
      )
      .all(sessionId, start, end) as unknown as SessionItemRow[];
    return {
      items: this.parseSessionItems(rows),
      total,
      hasMore: start > 0,
      hasNewer: end < total,
    };
  }

  saveSessionItems(
    sessionId: string,
    items: ChatItem[],
    firstChanged = 0,
  ): void {
    let start = Math.max(0, Math.min(firstChanged, items.length));
    if (start > 0) {
      const prefix = this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM session_transcript
           WHERE session_id = ? AND ordinal < ?`,
        )
        .get(sessionId, start) as { total?: number } | undefined;
      if (Number(prefix?.total) !== start) start = 0;
    }

    this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM session_transcript WHERE session_id = ? AND ordinal >= ?",
        )
        .run(sessionId, start);
      const insert = this.db.prepare(
        `INSERT INTO session_transcript(
           session_id, ordinal, item_id, item_text, item_json
         ) VALUES(?, ?, ?, ?, ?)`,
      );
      for (let ordinal = start; ordinal < items.length; ordinal += 1) {
        const item = items[ordinal]!;
        insert.run(
          sessionId,
          ordinal,
          item.id,
          searchableChatText(item),
          JSON.stringify(item),
        );
      }
    });
  }

  loadSessionChanges(sessionId: string): FileChange[] {
    const rows = this.db
      .prepare(
        `SELECT change_json FROM session_changes
         WHERE session_id = ? ORDER BY ordinal`,
      )
      .all(sessionId) as unknown as Array<{ change_json: string }>;
    const changes: FileChange[] = [];
    for (const row of rows) {
      try {
        changes.push(JSON.parse(row.change_json) as FileChange);
      } catch {
        // Skip a corrupt change row.
      }
    }
    return changes;
  }

  hasSessionChanges(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 AS found FROM session_changes WHERE session_id = ? LIMIT 1",
        )
        .get(sessionId),
    );
  }

  saveSessionChanges(sessionId: string, changes: FileChange[]): void {
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM session_changes WHERE session_id = ?")
        .run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO session_changes(
           session_id, ordinal, path, updated_at, change_json
         ) VALUES(?, ?, ?, ?, ?)`,
      );
      changes.forEach((change, ordinal) => {
        insert.run(
          sessionId,
          ordinal,
          change.path,
          change.updatedAt,
          JSON.stringify(change),
        );
      });
    });
  }

  loadRooms<T extends RoomLike>(): T[] {
    const rows = this.db
      .prepare(
        "SELECT room_id, metadata_json FROM room_archive ORDER BY updated_at DESC LIMIT ?",
      )
      .all(ROOM_HISTORY_LIMIT) as unknown as RoomRow[];
    const rooms: T[] = [];
    for (const row of rows) {
      const room = this.hydrateRoom<T>(row);
      if (room) rooms.push(room);
    }
    return rooms;
  }

  loadRoom<T extends RoomLike>(roomId: string): T | null {
    const row = this.db
      .prepare(
        "SELECT room_id, metadata_json FROM room_archive WHERE room_id = ?",
      )
      .get(roomId) as RoomRow | undefined;
    return row ? this.hydrateRoom<T>(row) : null;
  }

  saveRoom<T extends RoomLike>(room: T): void {
    const normalizedItems = room.items.slice(-ROOM_ITEM_LIMIT);
    const { items: _items, ...metadata } = room;
    const metadataJson = JSON.stringify(metadata);
    const existingRows = this.db
      .prepare(
        "SELECT item_id, item_json FROM room_timeline WHERE room_id = ?",
      )
      .all(room.roomId) as unknown as TimelineRow[];
    const existing = new Map(
      existingRows.map((row) => [row.item_id, row.item_json]),
    );
    const incoming = new Set(normalizedItems.map((item) => item.id));

    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO room_archive(room_id, updated_at, metadata_json)
           VALUES(?, ?, ?)
           ON CONFLICT(room_id) DO UPDATE SET
             updated_at = excluded.updated_at,
             metadata_json = excluded.metadata_json`,
        )
        .run(room.roomId, room.updatedAt, metadataJson);

      const deleteItem = this.db.prepare(
        "DELETE FROM room_timeline WHERE room_id = ? AND item_id = ?",
      );
      for (const itemId of existing.keys()) {
        if (!incoming.has(itemId)) deleteItem.run(room.roomId, itemId);
      }

      const upsertItem = this.db.prepare(
        `INSERT INTO room_timeline(room_id, item_id, item_at, item_text, item_json)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(room_id, item_id) DO UPDATE SET
           item_at = excluded.item_at,
           item_text = excluded.item_text,
           item_json = excluded.item_json`,
      );
      for (const item of normalizedItems) {
        const itemJson = JSON.stringify(item);
        if (existing.get(item.id) === itemJson) continue;
        upsertItem.run(room.roomId, item.id, item.at, item.text, itemJson);
      }

      const staleRooms = this.db
        .prepare(
          "SELECT room_id FROM room_archive ORDER BY updated_at DESC LIMIT -1 OFFSET ?",
        )
        .all(ROOM_HISTORY_LIMIT) as unknown as Array<{ room_id: string }>;
      const deleteRoom = this.db.prepare(
        "DELETE FROM room_archive WHERE room_id = ?",
      );
      for (const stale of staleRooms) deleteRoom.run(stale.room_id);
    });
  }

  removeRoom(roomId: string): void {
    this.db
      .prepare("DELETE FROM room_archive WHERE room_id = ?")
      .run(roomId);
  }

  loadModKv(roomId: string): Record<string, Record<string, string>> {
    const rows = this.db
      .prepare(
        "SELECT namespace, key, value FROM mod_kv WHERE room_id = ? ORDER BY namespace, key",
      )
      .all(roomId) as unknown as Array<{
      namespace: string;
      key: string;
      value: string;
    }>;
    const out: Record<string, Record<string, string>> = {};
    for (const row of rows) {
      (out[row.namespace] ??= {})[row.key] = row.value;
    }
    return out;
  }

  replaceModKv(
    roomId: string,
    data: Record<string, Record<string, string>>,
  ): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM mod_kv WHERE room_id = ?").run(roomId);
      const insert = this.db.prepare(
        "INSERT INTO mod_kv(room_id, namespace, key, value, updated_at) VALUES(?, ?, ?, ?, ?)",
      );
      const now = Date.now();
      for (const [namespace, bag] of Object.entries(data)) {
        for (const [key, value] of Object.entries(bag)) {
          insert.run(roomId, namespace, key, value, now);
        }
      }
    });
  }

  setModKv(roomId: string, namespace: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO mod_kv(room_id, namespace, key, value, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(room_id, namespace, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(roomId, namespace, key, value, Date.now());
  }

  removeModKv(roomId: string, namespace: string, key: string): void {
    this.db
      .prepare(
        "DELETE FROM mod_kv WHERE room_id = ? AND namespace = ? AND key = ?",
      )
      .run(roomId, namespace, key);
  }

  deleteModKv(roomId: string): void {
    this.db.prepare("DELETE FROM mod_kv WHERE room_id = ?").run(roomId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private parseSessionItems(rows: SessionItemRow[]): ChatItem[] {
    const items: ChatItem[] = [];
    for (const row of rows) {
      try {
        items.push(JSON.parse(row.item_json) as ChatItem);
      } catch {
        // Skip a corrupt item while keeping the remaining page available.
      }
    }
    return items;
  }

  private hydrateRoom<T extends RoomLike>(row: RoomRow): T | null {
    try {
      const metadata = JSON.parse(row.metadata_json) as Omit<T, "items">;
      const itemRows = this.db
        .prepare(
          "SELECT item_json FROM room_timeline WHERE room_id = ? ORDER BY ordinal",
        )
        .all(row.room_id) as unknown as Array<{ item_json: string }>;
      const items = itemRows
        .map((itemRow) => {
          try {
            return JSON.parse(itemRow.item_json) as RoomTimelineItem;
          } catch {
            return null;
          }
        })
        .filter((item): item is RoomTimelineItem => item !== null);
      return { ...metadata, items } as T;
    } catch {
      return null;
    }
  }

  private transaction(run: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original SQLite error.
      }
      throw error;
    }
  }
}
