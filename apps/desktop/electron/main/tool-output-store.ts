import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { ChatItem } from "@claude-desktop/shared";

export const MAX_PAGE_CHARS = 4000;
const limits = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxItemBytes: 512 * 1024,
  maxSessionBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  now: Date.now,
};

/** A host-private database. Its filename never crosses the MCP boundary. */
export class ToolOutputStore {
  private db?: DatabaseSync;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private readonly limits: typeof limits;

  constructor(private readonly file = ":memory:", overrides: Partial<typeof limits> = {}) {
    this.limits = { ...limits, ...overrides };
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    const req = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
    const { DatabaseSync: Sqlite } = req("node:sqlite") as typeof import("node:sqlite");
    const db = new Sqlite(this.file);
    try {
      db.exec(`PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS tool_output (
          handle TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, expires INTEGER NOT NULL,
          size INTEGER NOT NULL, body TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tool_output_owner ON tool_output(session_id, expires)`);
      db.prepare("DELETE FROM tool_output WHERE expires <= ?").run(this.limits.now());
      this.expiryTimer = setInterval(() => {
        try { db.prepare("DELETE FROM tool_output WHERE expires <= ?").run(this.limits.now()); }
        catch { /* Readers also enforce expiry independently of housekeeping. */ }
      }, 60 * 60 * 1000);
      this.expiryTimer.unref();
      this.db = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private exists() { return !!this.db || (this.file !== ":memory:" && existsSync(this.file)); }

  /** Only cards retained by the host confer authority. A summary mentioning a handle does not. */
  retained(session: string, items: ChatItem[]): Map<string, string> {
    const granted = new Map<string, string>();
    if (!this.exists()) return granted;
    const cards = items.flatMap(item => item.kind === "tool" && item.tool.status === "done" && item.tool.outputHandle
      ? [{ handle: item.tool.outputHandle, call: item.tool.id }] : []);
    if (!cards.length) return granted;
    const live = this.open().prepare(
      "SELECT handle, tool_use_id FROM tool_output WHERE session_id = ? AND expires > ?",
    ).all(session, this.limits.now());
    const owned = new Map(live.map(row => [row.handle, row.tool_use_id]));
    for (const card of cards) if (owned.get(card.handle) === card.call) granted.set(card.handle, card.call);
    return granted;
  }

  save(session: string, call: string, text: string): string | undefined {
    const size = Buffer.byteLength(text);
    if (size > this.limits.maxItemBytes || !size) return;
    const db = this.open();
    const now = this.limits.now();
    const handle = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM tool_output WHERE expires <= ?").run(now);
      const result = db.prepare(`INSERT INTO tool_output (handle, session_id, tool_use_id, expires, size, body)
        SELECT ?, ?, ?, ?, ?, ? WHERE
          (SELECT COALESCE(SUM(size), 0) FROM tool_output WHERE session_id = ?) <= ? AND
          (SELECT COALESCE(SUM(size), 0) FROM tool_output) <= ?`).run(
        handle, session, call, now + this.limits.ttlMs, size, text,
        session, this.limits.maxSessionBytes - size, this.limits.maxTotalBytes - size,
      );
      db.exec("COMMIT");
      return result.changes ? handle : undefined;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  read(session: string, call: string, handle: string, offset: number, limit: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > MAX_PAGE_CHARS || !this.exists()) return;
    const row = this.open().prepare(
      "SELECT body FROM tool_output WHERE handle = ? AND session_id = ? AND tool_use_id = ? AND expires > ?",
    ).get(handle, session, call, this.limits.now());
    if (typeof row?.body !== "string" || offset > row.body.length) return;
    const end = Math.min(row.body.length, offset + limit);
    return { text: row.body.slice(offset, end), nextOffset: end < row.body.length ? end : null, totalChars: row.body.length };
  }

  remove(session: string) {
    if (this.exists()) this.open().prepare("DELETE FROM tool_output WHERE session_id = ?").run(session);
  }

  close() {
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    this.db?.close();
    this.db = undefined;
  }
}
