import fs from "node:fs";
import path from "node:path";

/**
 * Pre-edit content snapshots per session, enabling change rollback.
 *
 * On the FIRST tracked write of a file within a session (Edit / Write /
 * Bash-redirect) we snapshot the file's original on-disk content. Restoring
 * writes that original content back (or deletes the file when it did not
 * exist before the session).
 *
 * Snapshots persist under userData/snapshots/<sessionId>/ so rollback still
 * works after an app restart, matching the session changes archive.
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

  private encodePath(p: string): string {
    return Buffer.from(p, "utf8").toString("base64url");
  }

  private decodePath(s: string): string {
    return Buffer.from(s, "base64url").toString("utf8");
  }

  private dir(sessionId: string): string {
    return path.join(this.root, this.safeId(sessionId));
  }

  private snapPath(sessionId: string, filePath: string): string {
    return path.join(this.dir(sessionId), `${this.encodePath(filePath)}.snap`);
  }

  /** True when a snapshot already exists for this session+file. */
  has(sessionId: string, filePath: string): boolean {
    try {
      return fs.existsSync(this.snapPath(sessionId, filePath));
    } catch {
      return false;
    }
  }

  /**
   * Record the pre-edit state of filePath for the session. No-op when a
   * snapshot already exists (first-write-wins: rollback returns the file to
   * its state before this session touched it).
   */
  capture(sessionId: string, filePath: string): void {
    if (this.has(sessionId, filePath)) return;
    try {
      fs.mkdirSync(this.dir(sessionId), { recursive: true });
      let data: Buffer;
      try {
        data = fs.readFileSync(filePath);
      } catch {
        // File did not exist before the session — restore will delete it.
        fs.writeFileSync(this.snapPath(sessionId, filePath), "__ABSENT__");
        return;
      }
      fs.writeFileSync(this.snapPath(sessionId, filePath), data);
    } catch {
      // best-effort; rollback just won't be offered for this file
    }
  }

  /** List file paths with snapshots for a session. */
  list(sessionId: string): string[] {
    try {
      const dir = this.dir(sessionId);
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".snap"))
        .map((f) => this.decodePath(f.slice(0, -".snap".length)));
    } catch {
      return [];
    }
  }

  /**
   * Restore one file to its pre-session state. Returns false when no
   * snapshot exists for the file. Deletes the file when it was absent
   * before the session.
   */
  restore(sessionId: string, filePath: string): boolean {
    const snap = this.snapPath(sessionId, filePath);
    try {
      if (!fs.existsSync(snap)) return false;
      const data = fs.readFileSync(snap);
      if (data.toString("utf8") === "__ABSENT__") {
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

  /** Restore every snapshotted file; returns per-file outcomes. */
  restoreAll(sessionId: string): { restored: string[]; failed: string[] } {
    const restored: string[] = [];
    const failed: string[] = [];
    for (const p of this.list(sessionId)) {
      if (this.restore(sessionId, p)) restored.push(p);
      else failed.push(p);
    }
    return { restored, failed };
  }

  /** Remove the snapshot after a successful restore (change is undone). */
  drop(sessionId: string, filePath: string): void {
    try {
      fs.unlinkSync(this.snapPath(sessionId, filePath));
    } catch {
      // ignore
    }
  }

  /** Drop all snapshots for a session (e.g. after restore-all). */
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
