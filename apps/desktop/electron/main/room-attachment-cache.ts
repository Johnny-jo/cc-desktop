import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  parseRoomAttachments,
  ROOM_ATTACHMENT_LIMITS,
  type Attachment,
  type RoomAttachmentRef,
} from "@claude-desktop/shared";

const METADATA_MAX_BYTES = 4096;
const IMAGE_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"],
]);
const TEXT_EXTENSIONS = new Set((
  ".txt .md .markdown .mdx .rst .csv .tsv .log .json .jsonc .jsonl .ndjson " +
  ".yaml .yml .toml .ini .cfg .conf .properties .xml .html .htm .svg " +
  ".css .scss .sass .less .js .jsx .mjs .cjs .ts .tsx .mts .cts .vue .svelte .astro " +
  ".py .pyw .rb .php .pl .r .sh .bash .zsh .fish .ps1 .psm1 .psd1 .bat .cmd " +
  ".c .h .cc .cpp .cxx .hpp .hh .hxx .cs .java .kt .kts .scala .go .rs " +
  ".swift .m .mm .lua .sql .graphql .gql .tex .diff .patch .ipynb"
).split(" "));

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inferType(name: string): Pick<RoomAttachmentRef, "mimeType" | "kind"> {
  const extension = path.extname(name).toLowerCase();
  const imageType = IMAGE_TYPES.get(extension);
  if (imageType) return { mimeType: imageType, kind: "image" };
  if (extension === ".pdf") return { mimeType: "application/pdf", kind: "binary" };
  // Room previews must not serve active markup, including HTML/SVG, as executable content.
  if (TEXT_EXTENSIONS.has(extension)) return { mimeType: "text/plain", kind: "text" };
  return { mimeType: "application/octet-stream", kind: "binary" };
}

function checkedRef(value: unknown): RoomAttachmentRef {
  const ref = parseRoomAttachments([value])?.[0];
  if (!ref) throw new Error("Invalid room attachment metadata");
  const inferred = inferType(ref.name);
  if (ref.mimeType !== inferred.mimeType || ref.kind !== inferred.kind) {
    throw new Error("Room attachment MIME/kind metadata mismatch");
  }
  return ref;
}

function verifyBytes(ref: RoomAttachmentRef, bytes: Buffer): void {
  if (bytes.length !== ref.size) throw new Error("Room attachment size mismatch");
  if (digest(bytes) !== ref.sha256) throw new Error("Room attachment SHA256 hash mismatch");
}

async function lstatIfPresent(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function requireDirectory(dir: string): Promise<void> {
  const stats = await fs.lstat(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Cache directory must be a real directory, not a symlink");
  }
}

/** Read at most the initial size plus one byte, even if a file grows during the read. */
async function boundedRead(filePath: string, limit: number, source = false): Promise<Buffer> {
  const entry = source ? undefined : await fs.lstat(filePath);
  if (entry && !entry.isFile()) throw new Error("Cached attachment must be a regular file, not a symlink");
  // User-selected source links are allowed. Cached files must never follow links.
  const flags = source ? constants.O_RDONLY : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Attachment source must be a regular file");
    if (entry && (entry.ino !== before.ino || entry.dev !== before.dev)) {
      throw new Error("Cached attachment changed while opening");
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit) {
      throw new Error("Attachment file size exceeds limit");
    }
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Attachment size or content changed while reading");
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

// All cache instances in the main process share a lock for each canonical root.
// Holding it through quota checking, staging, and commit reserves the entire entry.
const rootLocks = new Map<string, Promise<void>>();

async function withRootLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const previous = rootLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  rootLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (rootLocks.get(key) === current) rootLocks.delete(key);
  }
}

async function diskUsage(root: string, replacingData?: string): Promise<number> {
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    await requireDirectory(dir);
    for (const name of await fs.readdir(dir)) {
      const entryPath = path.join(dir, name);
      const entry = await fs.lstat(entryPath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(entryPath);
      // A repair replaces only this invalid regular file; its sidecar and all other files still count.
      else if (entryPath !== replacingData || !entry.isFile()) bytes += entry.size;
    }
  }
  return bytes;
}

function entryPaths(root: string, roomId: string, id: string) {
  const dir = path.join(root, digest(roomId));
  return { dir, data: path.join(dir, `${id}.bin`), metadata: path.join(dir, `${id}.json`) };
}

async function loadMetadata(files: ReturnType<typeof entryPaths>, ref: RoomAttachmentRef): Promise<RoomAttachmentRef> {
  const metadata = await boundedRead(files.metadata, METADATA_MAX_BYTES);
  const canonical = checkedRef(JSON.parse(metadata.toString("utf8")));
  // Parsing produces a fixed key order and rejects additional fields (including network paths).
  if (JSON.stringify(canonical) !== JSON.stringify(ref)) {
    throw new Error("Cached room attachment metadata mismatch");
  }
  return canonical;
}

async function loadEntry(root: string, roomId: string, ref: RoomAttachmentRef) {
  const files = entryPaths(root, roomId, ref.id);
  await requireDirectory(files.dir);
  const canonical = await loadMetadata(files, ref);
  const bytes = await boundedRead(files.data, ref.size);
  verifyBytes(canonical, bytes);
  return { ref: canonical, bytes, path: files.data };
}

async function writeEntry(files: ReturnType<typeof entryPaths>, bytes: Buffer, metadata?: Buffer): Promise<void> {
  const nonce = randomUUID();
  const dataTemp = `${files.data}.${nonce}.tmp`;
  const metadataTemp = `${files.metadata}.${nonce}.tmp`;
  const owned = new Set<string>();

  async function stage(filePath: string, contents: Buffer) {
    const handle = await fs.open(filePath, "wx", 0o600);
    owned.add(filePath);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  try {
    await stage(dataTemp, bytes);
    if (metadata) await stage(metadataTemp, metadata);
    await fs.rename(dataTemp, files.data);
    owned.delete(dataTemp);
    if (metadata) {
      owned.add(files.data);
      // New entries publish with their sidecar; an unsuccessful publication rolls back only our files.
      await fs.rename(metadataTemp, files.metadata);
      owned.delete(metadataTemp);
    }
    // Repairs already have a verified matching sidecar. The data rename is their only commit;
    // the published data must never be added to rollback cleanup or the sidecar rewritten.
  } catch (error) {
    const cleanup = await Promise.allSettled([...owned].map((file) => fs.unlink(file)));
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError([error, ...failures.map((result) => result.reason)], "Attachment write and cleanup failed");
    }
    throw error;
  }
}

export class RoomAttachmentCache {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(root: string, options?: { maxBytes?: number }) {
    const maxBytes = options?.maxBytes ?? ROOM_ATTACHMENT_LIMITS.cacheBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid attachment cache byte limit");
    this.root = path.resolve(root);
    this.maxBytes = Math.min(maxBytes, ROOM_ATTACHMENT_LIMITS.cacheBytes);
  }

  async importFile(roomId: string, attachment: Attachment): Promise<RoomAttachmentRef> {
    const name = attachment.name;
    if (typeof name !== "string" || !path.isAbsolute(attachment.path)) throw new Error("Invalid attachment source");
    const bytes = await boundedRead(attachment.path, ROOM_ATTACHMENT_LIMITS.fileBytes, true);
    const ref = checkedRef({
      id: randomUUID(), name, size: bytes.length, ...inferType(name), sha256: digest(bytes),
    });
    await this.store(roomId, ref, bytes);
    return ref;
  }

  async store(roomId: string, ref: RoomAttachmentRef, bytes: Buffer): Promise<void> {
    const canonical = checkedRef(ref);
    if (!Buffer.isBuffer(bytes) || bytes.length > ROOM_ATTACHMENT_LIMITS.fileBytes || bytes.length !== canonical.size) {
      throw new Error("Room attachment size mismatch or file limit exceeded");
    }
    // Own the inputs before yielding so caller mutations cannot alter verified data or metadata.
    const contents = Buffer.from(bytes);
    verifyBytes(canonical, contents);
    const metadata = Buffer.from(JSON.stringify(canonical));
    await this.locked(true, async (root) => {
      const files = entryPaths(root, roomId, canonical.id);
      if (!await lstatIfPresent(files.dir)) await fs.mkdir(files.dir);
      await requireDirectory(files.dir);
      const existingData = await lstatIfPresent(files.data);
      let newMetadata: Buffer | undefined = metadata;
      if (existingData || await lstatIfPresent(files.metadata)) {
        // Missing, malformed, or mismatched sidecars never authorize a repair.
        await loadMetadata(files, canonical);
        if (existingData) {
          if (!existingData.isFile()) throw new Error("Cached attachment must be a regular file, not a symlink");
          if (existingData.size === canonical.size) {
            // I/O errors propagate: inability to read a file is not proof that its contents are corrupt.
            const existingBytes = await boundedRead(files.data, canonical.size);
            if (existingBytes.length === canonical.size && digest(existingBytes) === canonical.sha256) {
              if (!existingBytes.equals(contents)) throw new Error("Existing attachment data mismatch");
              return;
            }
          }
        }
        newMetadata = undefined;
      }
      // Scan lazily on stores, under the reservation lock. Rescanning also accounts for files
      // left by an earlier process or introduced since this instance was constructed.
      const usedBytes = await diskUsage(root, newMetadata ? undefined : files.data);
      if (contents.length + (newMetadata?.length ?? 0) > this.maxBytes - usedBytes) {
        throw new Error("Room attachment cache quota is full");
      }
      await writeEntry(files, contents, newMetadata);
    });
  }

  async read(roomId: string, ref: RoomAttachmentRef): Promise<Buffer> {
    const canonical = checkedRef(ref);
    return this.locked(false, async (root) => (await loadEntry(root, roomId, canonical)).bytes);
  }

  async localAttachment(roomId: string, ref: RoomAttachmentRef): Promise<Attachment> {
    const canonical = checkedRef(ref);
    return this.locked(false, async (root) => {
      const verified = await loadEntry(root, roomId, canonical);
      return {
        path: verified.path,
        name: verified.ref.name,
        size: verified.ref.size,
        mimeType: verified.ref.mimeType,
        kind: verified.ref.kind,
      };
    });
  }

  /** Callers must restrict this to their own unpublished entries and guard all published/task references. */
  async discard(roomId: string, ref: RoomAttachmentRef, canDiscard?: () => boolean): Promise<void> {
    const canonical = checkedRef(ref);
    if (!await lstatIfPresent(this.root)) return;
    await this.locked(false, async (root) => {
      const files = entryPaths(root, roomId, canonical.id);
      if (!await lstatIfPresent(files.dir)) return;
      await requireDirectory(files.dir);
      const data = await lstatIfPresent(files.data);
      const metadata = await lstatIfPresent(files.metadata);
      if (!data && !metadata) return;

      // The sidecar proves ownership of this exact pair, including when the data is corrupt or missing.
      // An orphaned data file without matching metadata is not safe to remove.
      await loadMetadata(files, canonical);
      if (data && !data.isFile()) throw new Error("Cached attachment must be a regular file, not a symlink");
      // Keep the sidecar until the data is removed so a failed discard can be retried safely.
      // Recheck live caller state after all I/O, without yielding before the first unlink.
      if (canDiscard && !canDiscard()) return;
      if (data) await fs.unlink(files.data);
      await fs.unlink(files.metadata);
    });
  }

  private async locked<T>(create: boolean, operation: (root: string) => Promise<T>): Promise<T> {
    if (create && !await lstatIfPresent(this.root)) await fs.mkdir(this.root, { recursive: true });
    await requireDirectory(this.root);
    const root = await fs.realpath(this.root);
    return withRootLock(root, async () => {
      await requireDirectory(root);
      return operation(root);
    });
  }
}
