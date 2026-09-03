import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const ABSENT_MARKER = "__ABSENT__";
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const SNAPSHOT_TOTAL_MAX_BYTES = 256 * 1024 * 1024;
export const SNAPSHOT_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const SNAPSHOT_COMPRESSION_THRESHOLD_BYTES = 64 * 1024;

export type SnapshotStoreOptions = {
  retentionMs?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  compressionThresholdBytes?: number;
};

export type SnapshotCleanupResult = {
  removedSessions: number;
  removedEvents: number;
  removedBytes: number;
  remainingBytes: number;
};

type SnapshotPair = {
  sessionDir: string;
  eventId: string;
  snapshotPaths: string[];
  metaPath: string;
  bytes: number;
  mtimeMs: number;
  originalBytes?: number;
};

/**
 * Pre-edit content snapshots per write OPERATION, enabling per-step rollback.
 *
 * Every tracked write (Edit / Write / Bash redirect) snapshots the file's
 * on-disk content immediately before the tool runs, keyed by event id.
 * Restoring event N writes back the content captured before event N — i.e.
 * the file returns to its state after event N-1 (or is deleted when the
 * file did not exist before event N).
 *
 * Snapshots persist under userData/snapshots/<sessionId>/ as raw `.snap` or
 * compressed `.snap.gz` files with a JSON sidecar holding the path. Payloads
 * intentionally stay outside SQLite; startup retention and capacity pruning
 * keep this directory bounded.
 */
export class SnapshotStore {
  private readonly root: string;
  private readonly retentionMs: number;
  private readonly maxTotalBytes: number;
  private readonly maxFileBytes: number;
  private readonly compressionThresholdBytes: number;
  private estimatedBytes = 0;
  private capacityInitialized = false;

  constructor(userDataDir: string, options: SnapshotStoreOptions = {}) {
    this.root = path.join(userDataDir, "snapshots");
    this.retentionMs = options.retentionMs ?? SNAPSHOT_RETENTION_MS;
    this.maxTotalBytes = options.maxTotalBytes ?? SNAPSHOT_TOTAL_MAX_BYTES;
    this.maxFileBytes = options.maxFileBytes ?? SNAPSHOT_FILE_MAX_BYTES;
    this.compressionThresholdBytes =
      options.compressionThresholdBytes ??
      SNAPSHOT_COMPRESSION_THRESHOLD_BYTES;
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

  private compressedSnapPath(sessionId: string, eventId: string): string {
    return `${this.snapPath(sessionId, eventId)}.gz`;
  }

  private metaPath(sessionId: string, eventId: string): string {
    return path.join(this.dir(sessionId), `${this.safeEventId(eventId)}.json`);
  }

  /** True when a snapshot exists for this event. */
  has(sessionId: string, eventId: string): boolean {
    try {
      return (
        fs.existsSync(this.snapPath(sessionId, eventId)) ||
        fs.existsSync(this.compressedSnapPath(sessionId, eventId))
      );
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
      let data: Buffer;
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.size > this.maxFileBytes) return;
        data = fs.readFileSync(filePath);
      } catch {
        data = Buffer.from(ABSENT_MARKER, "utf8");
      }
      if (data.length > this.maxFileBytes) return;

      this.ensureCapacityInitialized();
      fs.mkdirSync(this.dir(sessionId), { recursive: true });
      let snapshotPath = this.snapPath(sessionId, eventId);
      let payload = data;
      let encoding: "raw" | "gzip" = "raw";
      if (data.length >= this.compressionThresholdBytes) {
        try {
          const compressed = gzipSync(data, { level: 6 });
          if (compressed.length < data.length) {
            snapshotPath = this.compressedSnapPath(sessionId, eventId);
            payload = compressed;
            encoding = "gzip";
          }
        } catch {
          // Compression is an optimization; raw snapshots remain valid.
        }
      }

      const metadata = JSON.stringify({
        path: filePath,
        encoding,
        originalBytes: data.length,
      });
      fs.writeFileSync(snapshotPath, payload);
      fs.writeFileSync(this.metaPath(sessionId, eventId), metadata, "utf8");
      this.estimatedBytes += payload.length + Buffer.byteLength(metadata, "utf8");
      this.enforceCapacity();
    } catch {
      // best-effort; rollback just won't be offered for this event
    }
  }

  /** Event ids with snapshots for a session. */
  list(sessionId: string): string[] {
    try {
      const dir = this.dir(sessionId);
      if (!fs.existsSync(dir)) return [];
      return [...new Set(fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".snap") || f.endsWith(".snap.gz"))
        .map((f) =>
          f.endsWith(".snap.gz")
            ? f.slice(0, -".snap.gz".length)
            : f.slice(0, -".snap".length),
        ))];
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
    const gzipPath = this.compressedSnapPath(sessionId, eventId);
    const rawPath = this.snapPath(sessionId, eventId);
    try {
      const compressed = fs.existsSync(gzipPath);
      const snap = compressed ? gzipPath : rawPath;
      if (!fs.existsSync(snap)) return false;
      const filePath = this.pathOf(sessionId, eventId);
      if (!filePath) return false;
      const stored = fs.readFileSync(snap);
      const data = compressed ? gunzipSync(stored) : stored;
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
    this.ensureCapacityInitialized();
    let removed = 0;
    for (const file of [
      this.snapPath(sessionId, eventId),
      this.compressedSnapPath(sessionId, eventId),
      this.metaPath(sessionId, eventId),
    ]) {
      try {
        removed += fs.statSync(file).size;
        fs.unlinkSync(file);
      } catch {
        // ignore each missing half independently
      }
    }
    this.estimatedBytes = Math.max(0, this.estimatedBytes - removed);
  }

  /** Drop all snapshots for a session. */
  dropAll(sessionId: string): void {
    try {
      this.ensureCapacityInitialized();
      const dir = this.dir(sessionId);
      const removed = this.directoryBytes(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      this.estimatedBytes = Math.max(0, this.estimatedBytes - removed);
    } catch {
      // ignore
    }
  }

  /**
   * Startup maintenance: remove snapshot directories for deleted sessions,
   * discard incomplete/expired/oversized pairs, then enforce the global cap.
   */
  cleanup(validSessionIds: ReadonlySet<string>, now = Date.now()): SnapshotCleanupResult {
    const validDirs = new Set(
      [...validSessionIds].map((sessionId) => this.safeId(sessionId)),
    );
    let removedSessions = 0;
    let removedEvents = 0;
    let removedBytes = 0;
    const pairs: SnapshotPair[] = [];

    try {
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionDir = path.join(this.root, entry.name);
        if (!validDirs.has(entry.name)) {
          const bytes = this.directoryBytes(sessionDir);
          fs.rmSync(sessionDir, { recursive: true, force: true });
          removedSessions += 1;
          removedBytes += bytes;
          continue;
        }

        for (const pair of this.readPairs(sessionDir)) {
          const expired =
            this.retentionMs >= 0 && pair.mtimeMs < now - this.retentionMs;
          const oversized =
            (pair.originalBytes ?? pair.bytes) > this.maxFileBytes;
          if (expired || oversized) {
            removedBytes += this.removePair(pair);
            removedEvents += 1;
          } else {
            pairs.push(pair);
          }
        }

        // readPairs removes incomplete files; drop an emptied session folder.
        try {
          if (fs.readdirSync(sessionDir).length === 0) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // Maintenance is best-effort and must never prevent app startup.
    }

    let remainingBytes = pairs.reduce((sum, pair) => sum + pair.bytes, 0);
    pairs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const pair of pairs) {
      if (remainingBytes <= this.maxTotalBytes) break;
      const bytes = this.removePair(pair);
      remainingBytes = Math.max(0, remainingBytes - bytes);
      removedBytes += bytes;
      removedEvents += 1;
    }
    this.estimatedBytes = remainingBytes;
    this.capacityInitialized = true;
    return { removedSessions, removedEvents, removedBytes, remainingBytes };
  }

  clearSession(sessionId: string): void {
    this.dropAll(sessionId);
  }

  private ensureCapacityInitialized(): void {
    if (this.capacityInitialized) return;
    this.estimatedBytes = this.directoryBytes(this.root);
    this.capacityInitialized = true;
  }

  private enforceCapacity(): void {
    if (this.estimatedBytes <= this.maxTotalBytes) return;
    const pairs: SnapshotPair[] = [];
    try {
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          pairs.push(...this.readPairs(path.join(this.root, entry.name)));
        }
      }
    } catch {
      return;
    }
    pairs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    this.estimatedBytes = pairs.reduce((sum, pair) => sum + pair.bytes, 0);
    for (const pair of pairs) {
      if (this.estimatedBytes <= this.maxTotalBytes) break;
      this.estimatedBytes = Math.max(
        0,
        this.estimatedBytes - this.removePair(pair),
      );
    }
  }

  /** Read usable event pairs and remove one-sided/colliding files. */
  private readPairs(sessionDir: string): SnapshotPair[] {
    const snapshots = new Map<string, string[]>();
    const metadata = new Map<string, string>();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".snap.gz")) {
        const id = entry.name.slice(0, -".snap.gz".length);
        const files = snapshots.get(id) ?? [];
        files.push(path.join(sessionDir, entry.name));
        snapshots.set(id, files);
      } else if (entry.name.endsWith(".snap")) {
        const id = entry.name.slice(0, -".snap".length);
        const files = snapshots.get(id) ?? [];
        files.push(path.join(sessionDir, entry.name));
        snapshots.set(id, files);
      } else if (entry.name.endsWith(".json")) {
        metadata.set(
          entry.name.slice(0, -".json".length),
          path.join(sessionDir, entry.name),
        );
      }
    }

    const pairs: SnapshotPair[] = [];
    const ids = new Set([...snapshots.keys(), ...metadata.keys()]);
    for (const eventId of ids) {
      const snapshotPaths = snapshots.get(eventId) ?? [];
      const metaPath = metadata.get(eventId);
      if (!snapshotPaths.length || !metaPath) {
        for (const file of [...snapshotPaths, ...(metaPath ? [metaPath] : [])]) {
          try {
            fs.rmSync(file, { force: true });
          } catch {
            // ignore
          }
        }
        continue;
      }
      try {
        const snapshotStats = snapshotPaths.map((file) => fs.statSync(file));
        const metaStat = fs.statSync(metaPath);
        let originalBytes: number | undefined;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
            originalBytes?: unknown;
          };
          if (typeof meta.originalBytes === "number") {
            originalBytes = meta.originalBytes;
          }
        } catch {
          // Old metadata only stored the path and remains compatible.
        }
        pairs.push({
          sessionDir,
          eventId,
          snapshotPaths,
          metaPath,
          bytes:
            metaStat.size +
            snapshotStats.reduce((sum, stat) => sum + stat.size, 0),
          mtimeMs: Math.max(
            metaStat.mtimeMs,
            ...snapshotStats.map((stat) => stat.mtimeMs),
          ),
          originalBytes,
        });
      } catch {
        // A concurrent delete or corrupt pair can be ignored until next pass.
      }
    }
    return pairs;
  }

  private removePair(pair: SnapshotPair): number {
    for (const file of [...pair.snapshotPaths, pair.metaPath]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
    }
    try {
      if (fs.readdirSync(pair.sessionDir).length === 0) {
        fs.rmSync(pair.sessionDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
    return pair.bytes;
  }

  private directoryBytes(dir: string): number {
    let total = 0;
    const pending = [dir];
    while (pending.length) {
      const current = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile()) {
          try {
            total += fs.statSync(file).size;
          } catch {
            // ignore races
          }
        }
      }
    }
    return total;
  }
}
