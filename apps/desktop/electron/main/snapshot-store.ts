import fs from "node:fs";
import path from "node:path";

const ABSENT_MARKER = "__ABSENT__";

/**
 * Pre-edit content snapshots per write OPERATION, enabling per-step rollback.
 *
 * Every tracked write (Edit / Write / Bash redirect) snapshots the file's
 * on-disk content immediately before the tool runs, keyed by event id.
 * Restoring event N writes back the content captured before event N — i.e.
 * the file returns to its state after event N-1 (or is deleted when the
 * file did not exist before event N).
 *
 * Snapshots persist under userData/snapshots/<sessionId>/ as
 * `<eventId>.snap` files with a JSON sidecar `<eventId>.json` holding the
 * file path, so rollback still works after an app restart. Large snapshot
 * payloads intentionally stay outside SQLite.
 */
export class SnapshotStore {
  private readonly root: string;

  constructor(userDataDir: string) {
    this.root = path.join(userDataDir, "snapshots");
    fs.mkdirSync(this.root, { recursive: true });
  }

  private safeId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private safeEventId(eventId: string): string {
    return eventId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private dir(sessionId: string): string {
    return path.join(this.root, this.safeId(sessionId));
  }

  private snapPath(sessionId: string, eventId: string): string {
    return path.join(this.dir(sessionId), `${this.safeEventId(eventId)}.snap`);
  }

  private metaPath(sessionId: string, eventId: string): string {
    return path.join(this.dir(sessionId), `${this.safeEventId(eventId)}.json`);
  }

  /** True when a snapshot exists for this event. */
  has(sessionId: string, eventId: string): boolean {
    try {
      return fs.existsSync(this.snapPath(sessionId, eventId));
    } catch {
      return false;
    }
  }

  /** File path recorded for an event snapshot (null when unknown). */
  pathOf(sessionId: string, eventId: string): string | null {
    try {
      const raw = fs.readFileSync(this.metaPath(sessionId, eventId), "utf8");
      const data = JSON.parse(raw) as { path?: unknown };
      return typeof data.path === "string" ? data.path : null;
    } catch {
      return null;
    }
  }

  /**
   * Snapshot filePath's current content under eventId. When the file does
   * not exist, an ABSENT marker is stored — restore then deletes the file.
   * No-op when a snapshot already exists for the event.
   */
  capture(sessionId: string, eventId: string, filePath: string): void {
    if (this.has(sessionId, eventId)) return;
    try {
      fs.mkdirSync(this.dir(sessionId), { recursive: true });
      let data: Buffer;
      try {
        data = fs.readFileSync(filePath);
      } catch {
        data = Buffer.from(ABSENT_MARKER, "utf8");
      }
      fs.writeFileSync(this.snapPath(sessionId, eventId), data);
      fs.writeFileSync(
        this.metaPath(sessionId, eventId),
        JSON.stringify({ path: filePath }),
        "utf8",
      );
    } catch {
      // best-effort; rollback just won't be offered for this event
    }
  }

  /** Event ids with snapshots for a session. */
  list(sessionId: string): string[] {
    try {
      const dir = this.dir(sessionId);
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".snap"))
        .map((f) => f.slice(0, -".snap".length));
    } catch {
      return [];
    }
  }

  /**
   * Restore the file recorded for eventId to its pre-op content. Returns
   * false when no snapshot exists. Deletes the file when it was absent
   * before the operation.
   */
  restore(sessionId: string, eventId: string): boolean {
    const snap = this.snapPath(sessionId, eventId);
    try {
      if (!fs.existsSync(snap)) return false;
      const filePath = this.pathOf(sessionId, eventId);
      if (!filePath) return false;
      const data = fs.readFileSync(snap);
      if (data.toString("utf8") === ABSENT_MARKER) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // already gone — that's the desired end state
        }
        return true;
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, data);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove one event snapshot after a successful restore. */
  drop(sessionId: string, eventId: string): void {
    try {
      fs.unlinkSync(this.snapPath(sessionId, eventId));
      fs.unlinkSync(this.metaPath(sessionId, eventId));
    } catch {
      // ignore
    }
  }

  /** Drop all snapshots for a session. */
  dropAll(sessionId: string): void {
    try {
      fs.rmSync(this.dir(sessionId), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  clearSession(sessionId: string): void {
    this.dropAll(sessionId);
  }
}
