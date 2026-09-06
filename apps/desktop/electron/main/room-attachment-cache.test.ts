import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROOM_ATTACHMENT_LIMITS,
  type Attachment,
  type RoomAttachmentRef,
} from "@claude-desktop/shared";
import { RoomAttachmentCache } from "./room-attachment-cache";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function reference(bytes: Buffer, overrides: Partial<RoomAttachmentRef> = {}): RoomAttachmentRef {
  return {
    id: randomUUID(),
    name: "notes.txt",
    size: bytes.length,
    mimeType: "text/plain",
    kind: "text",
    sha256: hash(bytes),
    ...overrides,
  };
}

function entryBytes(ref: RoomAttachmentRef): number {
  return ref.size + Buffer.byteLength(JSON.stringify(ref));
}

async function filesInside(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesInside(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

describe("RoomAttachmentCache", () => {
  let fixture: string;
  let root: string;

  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), "room-attachment-cache-test-"));
    root = path.join(fixture, "cache");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  async function source(name: string, bytes: Buffer): Promise<Attachment> {
    const sourcePath = path.join(fixture, name);
    await fs.writeFile(sourcePath, bytes);
    return { name, path: sourcePath, size: 0, mimeType: "image/svg+xml", kind: "image" };
  }

  function paths(roomId: string, ref: RoomAttachmentRef) {
    const dir = path.join(root, hash(roomId));
    return { dir, data: path.join(dir, `${ref.id}.bin`), metadata: path.join(dir, `${ref.id}.json`) };
  }

  it("copies actual UTF-8 bytes and preserves canonical metadata after source edits, deletion and restart", async () => {
    const bytes = Buffer.from("你好，room cache 🌍\n");
    const attachment = await source("笔记.txt", bytes);
    const roomId = "../../room\\with/path";
    const cache = new RoomAttachmentCache(root);
    const ref = await cache.importFile(roomId, attachment);

    expect(ref).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      name: attachment.name,
      size: bytes.length,
      mimeType: "text/plain",
      kind: "text",
      sha256: hash(bytes),
    });
    await fs.writeFile(attachment.path, "changed source");
    expect(await cache.read(roomId, ref)).toEqual(bytes);
    await fs.unlink(attachment.path);

    const restarted = new RoomAttachmentCache(root);
    expect(await restarted.read(roomId, ref)).toEqual(bytes);
    const local = await restarted.localAttachment(roomId, ref);
    expect(local).toEqual({
      name: attachment.name,
      path: paths(roomId, ref).data,
      size: bytes.length,
      mimeType: "text/plain",
      kind: "text",
    });
    expect(await fs.readFile(local.path)).toEqual(bytes);
    expect(JSON.parse(await fs.readFile(paths(roomId, ref).metadata, "utf8"))).toEqual(ref);
    expect(await filesInside(root)).toEqual([paths(roomId, ref).data, paths(roomId, ref).metadata].sort());
  });

  it.each([
    ["photo.PNG", "image/png", "image", png],
    ["photo.jpg", "image/jpeg", "image", Buffer.from("/9j/2Q==", "base64")],
    ["photo.jpeg", "image/jpeg", "image", Buffer.from("/9j/2Q==", "base64")],
    ["photo.gif", "image/gif", "image", Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")],
    ["photo.webp", "image/webp", "image", Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64")],
    ["manual.pdf", "application/pdf", "binary", Buffer.from("%PDF-1.7\n%%EOF\n")],
    ...["txt", "md", "ts", "tsx", "js", "json", "py", "html", "svg", "yaml", "rs", "cpp"].map(
      (ext) => [`code.${ext}`, "text/plain", "text", Buffer.from("const text = '你好';\n")] as const,
    ),
    ["payload.exe", "application/octet-stream", "binary", Buffer.from([0, 255, 254, 1])],
    ["photo.avif", "application/octet-stream", "binary", Buffer.from([0, 1, 2])],
    ["unknown", "application/octet-stream", "binary", Buffer.from("unknown")],
  ] as const)("infers room-safe MIME from %s, ignoring caller MIME, kind and size", async (name, mimeType, kind, bytes) => {
    const attachment = await source(name, bytes);
    attachment.size = Number.MAX_SAFE_INTEGER;
    const cache = new RoomAttachmentCache(root);
    const ref = await cache.importFile("room", attachment);
    expect(ref).toMatchObject({ name, size: bytes.length, mimeType, kind, sha256: hash(bytes) });
    expect(await cache.read("room", ref)).toEqual(bytes);
  });

  it("generates a fresh UUID for every import even for identical files", async () => {
    const attachment = await source("same.txt", Buffer.from("same"));
    const cache = new RoomAttachmentCache(root);
    const [first, second] = await Promise.all([
      cache.importFile("room", attachment), cache.importFile("room", attachment),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(first.sha256).toBe(second.sha256);
  });

  it("allows a user-selected source reached through a symlink directory", async () => {
    const realDir = path.join(fixture, "source-dir");
    const linkDir = path.join(fixture, "source-link");
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, "input.txt"), "linked content");
    await fs.symlink(realDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    const cache = new RoomAttachmentCache(root);
    const ref = await cache.importFile("room", {
      name: "input.txt", path: path.join(linkDir, "input.txt"), size: 0, mimeType: "forged/type", kind: "binary",
    });
    expect(await cache.read("room", ref)).toEqual(Buffer.from("linked content"));
  });

  it("rejects an actually oversized source even when its claimed size is zero", async () => {
    const attachment = await source("huge.txt", Buffer.alloc(ROOM_ATTACHMENT_LIMITS.fileBytes + 1));
    await expect(new RoomAttachmentCache(root).importFile("room", attachment)).rejects.toThrow(/size|limit/i);
    expect(await filesInside(root)).toEqual([]);
  });

  it("rejects directory sources", async () => {
    await expect(new RoomAttachmentCache(root).importFile("room", {
      name: "directory.txt", path: fixture, size: 0, mimeType: "text/plain", kind: "text",
    })).rejects.toThrow(/regular file|not a file/i);
    expect(await filesInside(root)).toEqual([]);
  });

  it.each(["grow", "shrink", "exceed-limit"] as const)("rejects a source that changes after fstat: %s", async (change) => {
    const bytes = change === "exceed-limit" ? Buffer.alloc(ROOM_ATTACHMENT_LIMITS.fileBytes) : Buffer.from("original");
    const attachment = await source("racy.txt", bytes);
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === attachment.path) {
        const originalStat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
          const stats = await originalStat();
          if (change === "shrink") await fs.truncate(attachment.path, 1);
          else await fs.appendFile(attachment.path, "!");
          return stats;
        });
      }
      return handle;
    });
    await expect(new RoomAttachmentCache(root).importFile("room", attachment)).rejects.toThrow(/changed|size|limit/i);
    expect(await filesInside(root)).toEqual([]);
  });

  it.each([0, ROOM_ATTACHMENT_LIMITS.fileBytes])("stores and reads boundary-sized content (%s bytes)", async (size) => {
    const bytes = Buffer.alloc(size, 7);
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root);
    await cache.store("room", ref, bytes);
    expect((await cache.read("room", ref)).equals(bytes)).toBe(true);
  });

  it.each([
    { sha256: "0".repeat(64) },
    { size: 99 },
    { size: -1 },
    { size: 0.5 },
    { size: ROOM_ATTACHMENT_LIMITS.fileBytes + 1 },
    { id: "../../escape" },
    { id: "..\\escape" },
    { id: "C:\\outside" },
    { name: "../escape.txt" },
    { name: "..\\escape.txt" },
    { name: "bad\u0000.txt" },
    { name: "x".repeat(201) },
    { mimeType: "text/html" },
    { kind: "image" },
    { path: "C:\\network-supplied-path.txt" },
  ])("rejects invalid or mismatched store references: %j", async (overrides) => {
    const bytes = Buffer.from("content");
    const ref = { ...reference(bytes), ...overrides } as RoomAttachmentRef;
    const cache = new RoomAttachmentCache(root);
    await expect(cache.store("room", ref, bytes)).rejects.toThrow(/invalid|mismatch|hash|metadata|size/i);
    expect(await filesInside(root)).toEqual([]);
  });

  it("rejects oversized received bytes independently of the reference size", async () => {
    const bytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.fileBytes + 1);
    await expect(new RoomAttachmentCache(root).store("room", reference(bytes, { size: 0 }), bytes)).rejects.toThrow(/size|limit/i);
    expect(await filesInside(root)).toEqual([]);
  });

  it("isolates references by room", async () => {
    const bytes = Buffer.from("private room bytes");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root);
    await cache.store("room-a", ref, bytes);
    await expect(cache.read("room-b", ref)).rejects.toThrow();
    await expect(cache.localAttachment("room-b", ref)).rejects.toThrow();
    expect(await cache.read("room-a", ref)).toEqual(bytes);
  });

  it.each([
    { name: "renamed.txt" },
    { mimeType: "application/json" },
    { name: "forged.png", mimeType: "image/png", kind: "image" },
    { kind: "binary" },
    { sha256: "0".repeat(64) },
    { size: 8 },
    { id: randomUUID() },
    { id: "../../escape" },
    { path: "C:\\network.txt" },
  ])("rejects reference tampering on read and localAttachment, including after restart: %j", async (overrides) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    await new RoomAttachmentCache(root).store("room", ref, bytes);
    const cache = new RoomAttachmentCache(root);
    const forged = { ...ref, ...overrides } as RoomAttachmentRef;
    await expect(cache.read("room", forged)).rejects.toThrow();
    await expect(cache.localAttachment("room", forged)).rejects.toThrow();
    expect(await cache.read("room", ref)).toEqual(bytes);
  });

  it.each(["same-size", "truncated", "missing", "metadata-name", "metadata-invalid", "metadata-large", "metadata-missing"])(
    "verifies actual cached data and sidecar before returning any path: %s", async (corruption) => {
      const bytes = Buffer.from("content");
      const ref = reference(bytes);
      await new RoomAttachmentCache(root).store("room", ref, bytes);
      const cached = paths("room", ref);
      if (corruption === "same-size") await fs.writeFile(cached.data, "changed");
      if (corruption === "truncated") await fs.truncate(cached.data, 1);
      if (corruption === "missing") await fs.unlink(cached.data);
      if (corruption === "metadata-name") await fs.writeFile(cached.metadata, JSON.stringify({ ...ref, name: "different.txt" }));
      if (corruption === "metadata-invalid") await fs.writeFile(cached.metadata, "{");
      if (corruption === "metadata-large") await fs.writeFile(cached.metadata, " ".repeat(64 * 1024));
      if (corruption === "metadata-missing") await fs.unlink(cached.metadata);
      const cache = new RoomAttachmentCache(root);
      await expect(cache.read("room", ref)).rejects.toThrow();
      await expect(cache.localAttachment("room", ref)).rejects.toThrow();
      if (corruption.startsWith("metadata-")) {
        await expect(cache.store("room", ref, bytes)).rejects.toThrow();
      }
    },
  );

  it.each(["missing", "same-size", "shorter", "longer", "oversized"])(
    "repairs only invalid data at full quota with an exactly matching sidecar after restart: %s", async (damage) => {
      const bytes = Buffer.from("content");
      const ref = reference(bytes);
      const maxBytes = entryBytes(ref);
      await new RoomAttachmentCache(root, { maxBytes }).store("room", ref, bytes);
      const cached = paths("room", ref);
      const sidecar = await fs.readFile(cached.metadata);
      const sidecarStat = await fs.stat(cached.metadata);
      if (damage === "missing") await fs.unlink(cached.data);
      if (damage === "same-size") await fs.writeFile(cached.data, "changed");
      if (damage === "shorter") await fs.truncate(cached.data, 1);
      if (damage === "longer") await fs.appendFile(cached.data, "garbage");
      if (damage === "oversized") await fs.writeFile(cached.data, Buffer.alloc(ROOM_ATTACHMENT_LIMITS.fileBytes + 1));

      const restarted = new RoomAttachmentCache(root, { maxBytes });
      await expect(restarted.read("room", ref)).rejects.toThrow();
      await restarted.store("room", { ...ref }, Buffer.from(bytes));
      expect(await restarted.read("room", ref)).toEqual(bytes);
      expect(await restarted.localAttachment("room", ref)).toMatchObject({ path: cached.data, size: bytes.length });
      expect(await fs.readFile(cached.metadata)).toEqual(sidecar);
      expect(await fs.stat(cached.metadata)).toMatchObject({ ino: sidecarStat.ino, mtimeMs: sidecarStat.mtimeMs });
      expect(await filesInside(root)).toEqual([cached.data, cached.metadata].sort());
      await expect(restarted.store("room", reference(Buffer.alloc(0)), Buffer.alloc(0))).rejects.toThrow(/quota/i);
    },
  );

  it.each([
    { name: "other.txt" },
    { id: randomUUID() },
    { sha256: "0".repeat(64) },
    { name: "other.png", mimeType: "image/png", kind: "image" },
  ])("rejects repair behind a mismatched sidecar without overwriting it: %j", async (overrides) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root);
    await cache.store("room", ref, bytes);
    const cached = paths("room", ref);
    const damaged = Buffer.from("changed");
    const sidecar = Buffer.from(JSON.stringify({ ...ref, ...overrides }));
    await fs.writeFile(cached.data, damaged);
    await fs.writeFile(cached.metadata, sidecar);
    await expect(cache.store("room", ref, bytes)).rejects.toThrow(/metadata.*mismatch/i);
    expect(await fs.readFile(cached.data)).toEqual(damaged);
    expect(await fs.readFile(cached.metadata)).toEqual(sidecar);
    expect(await filesInside(root)).toEqual([cached.data, cached.metadata].sort());
  });

  it("charges repair growth while retaining other published entries and files", async () => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const other = reference(bytes);
    const maxBytes = entryBytes(ref) + entryBytes(other);
    const cache = new RoomAttachmentCache(root, { maxBytes });
    await cache.store("room", ref, bytes);
    await cache.store("other-room", other, bytes);
    const cached = paths("room", ref);
    const otherPaths = paths("other-room", other);
    const otherStat = await fs.stat(otherPaths.data);
    await fs.truncate(cached.data, 1);
    const extra = path.join(root, "existing-file");
    await fs.writeFile(extra, "!");

    await expect(cache.store("room", ref, bytes)).rejects.toThrow(/quota/i);
    expect(await fs.readFile(cached.data)).toEqual(bytes.subarray(0, 1));
    expect(await fs.readFile(extra, "utf8")).toBe("!");
    expect(await cache.read("other-room", other)).toEqual(bytes);

    await fs.unlink(extra);
    await cache.store("room", ref, bytes);
    expect(await cache.read("room", ref)).toEqual(bytes);
    expect(await cache.read("other-room", other)).toEqual(bytes);
    expect(await fs.stat(otherPaths.data)).toMatchObject({ ino: otherStat.ino, mtimeMs: otherStat.mtimeMs });
    expect(await filesInside(root)).toHaveLength(4);
  });

  it.each(["partial-write", "rename"])("cleans only repair temps on %s failure and permits another retry", async (failure) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const other = reference(bytes);
    const cache = new RoomAttachmentCache(root, { maxBytes: entryBytes(ref) + entryBytes(other) });
    await cache.store("room", ref, bytes);
    await cache.store("other-room", other, bytes);
    const cached = paths("room", ref);
    const damaged = Buffer.from("changed");
    await fs.writeFile(cached.data, damaged);
    const sidecar = await fs.readFile(cached.metadata);
    const publishedFiles = await filesInside(root);
    if (failure === "partial-write") {
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith(".tmp")) {
          const originalWrite = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
            await originalWrite("partial");
            throw new Error("injected repair write failure");
          });
        }
        return handle;
      });
    } else {
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("injected repair rename failure"));
    }
    await expect(cache.store("room", ref, bytes)).rejects.toThrow(/injected repair/);
    expect(await filesInside(root)).toEqual(publishedFiles);
    expect(await fs.readFile(cached.data)).toEqual(damaged);
    expect(await fs.readFile(cached.metadata)).toEqual(sidecar);
    expect(await cache.read("other-room", other)).toEqual(bytes);
    vi.restoreAllMocks();
    await cache.store("room", ref, bytes);
    expect(await cache.read("room", ref)).toEqual(bytes);
    expect(await filesInside(root)).toEqual(publishedFiles);
  });

  it("holds concurrent readers and retries until the single repair rename publishes verified bytes", async () => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const maxBytes = entryBytes(ref);
    const cache = new RoomAttachmentCache(root, { maxBytes });
    await cache.store("room", ref, bytes);
    const cached = paths("room", ref);
    await fs.writeFile(cached.data, "changed");
    let reached!: () => void;
    let release!: () => void;
    const committing = new Promise<void>((resolve) => { reached = resolve; });
    const permitted = new Promise<void>((resolve) => { release = resolve; });
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] !== cached.data) throw new Error("Repair must not rewrite the matching sidecar");
      reached();
      await permitted;
      return originalRename(...args);
    });
    const repair = cache.store("room", ref, bytes);
    try {
      await Promise.race([committing, repair.then(() => { throw new Error("Repair did not rename data atomically"); })]);
      expect(await fs.readFile(cached.data, "utf8")).toBe("changed");
      const concurrent = new RoomAttachmentCache(root, { maxBytes });
      let readerSettled = false;
      const read = concurrent.read("room", ref).finally(() => { readerSettled = true; });
      const operations = Promise.all([read, concurrent.store("room", ref, bytes), repair]);
      // Give the reader time to reach the held root lock while the old bytes are still invalid.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const wasHeld = !readerSettled;
      release();
      const [readBytes] = await operations;
      expect(wasHeld).toBe(true);
      expect(readBytes).toEqual(bytes);
      expect(await filesInside(root)).toEqual([cached.data, cached.metadata].sort());
    } finally {
      release();
      await repair.catch(() => {});
    }
  });

  it("discards only the owned room pair and releases its disk quota after restart", async () => {
    const bytes = Buffer.from("content");
    const attachment = await source("notes.txt", bytes);
    const maxBytes = entryBytes(reference(bytes)) * 2 + 3;
    const cache = new RoomAttachmentCache(root, { maxBytes });
    const ref = await cache.importFile("room", attachment);
    await cache.store("other-room", ref, bytes);
    const cached = paths("room", ref);
    const unrelated = path.join(cached.dir, "unrecognized.json");
    const partial = path.join(cached.dir, `${ref.id}.unrecognized.tmp`);
    await fs.writeFile(unrelated, "{}");
    await fs.writeFile(partial, "!");
    const next = reference(bytes);
    await expect(cache.store("room", next, bytes)).rejects.toThrow(/quota/i);

    await new RoomAttachmentCache(root, { maxBytes }).discard("room", ref);
    await expect(cache.read("room", ref)).rejects.toThrow();
    await expect(cache.localAttachment("room", ref)).rejects.toThrow();
    expect(await cache.read("other-room", ref)).toEqual(bytes);
    expect(await fs.readFile(attachment.path)).toEqual(bytes);
    expect(await fs.readFile(unrelated, "utf8")).toBe("{}");
    expect(await fs.readFile(partial, "utf8")).toBe("!");
    expect(await fs.readdir(cached.dir)).toEqual(expect.arrayContaining(["unrecognized.json", path.basename(partial)]));
    await cache.store("room", next, bytes);
    expect(await cache.read("room", next)).toEqual(bytes);
    expect(await filesInside(root)).toHaveLength(6);
  });

  it("treats missing entries and repeated concurrent discards as no-ops without creating directories", async () => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root);
    await expect(cache.discard("room", ref)).resolves.toBeUndefined();
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await cache.store("room", ref, bytes);
    await expect(cache.discard("absent-room", ref)).resolves.toBeUndefined();
    await expect(fs.lstat(paths("absent-room", ref).dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(cache.discard("room", reference(bytes))).resolves.toBeUndefined();
    expect(await cache.read("room", ref)).toEqual(bytes);
    await Promise.all([
      cache.discard("room", ref), new RoomAttachmentCache(root).discard("room", ref),
    ]);
    await expect(cache.discard("room", ref)).resolves.toBeUndefined();
    expect(await filesInside(root)).toEqual([]);
    expect((await fs.lstat(paths("room", ref).dir)).isDirectory()).toBe(true);
  });

  it.each([
    { id: "../../outside" },
    { id: "..\\outside" },
    { name: "../outside.txt" },
    { name: "different.txt" },
    { name: "different.png", mimeType: "image/png", kind: "image" },
    { sha256: "0".repeat(64) },
    { size: 1 },
    { path: "C:\\network-selected-file.txt" },
  ])("rejects an invalid or mismatched discard reference without deleting anything: %j", async (overrides) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root);
    await cache.store("room", ref, bytes);
    const originalFiles = await filesInside(root);
    const sidecar = await fs.readFile(paths("room", ref).metadata);
    await expect(cache.discard("room", { ...ref, ...overrides } as RoomAttachmentRef)).rejects.toThrow(/invalid|mismatch/i);
    expect(await filesInside(root)).toEqual(originalFiles);
    expect(await cache.read("room", ref)).toEqual(bytes);
    expect(await fs.readFile(paths("room", ref).metadata)).toEqual(sidecar);
  });

  it.each(["missing", "malformed", "different-id"])("refuses to discard data with a %s sidecar", async (damage) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root);
    await cache.store("room", ref, bytes);
    const cached = paths("room", ref);
    if (damage === "missing") await fs.unlink(cached.metadata);
    if (damage === "malformed") await fs.writeFile(cached.metadata, "{");
    if (damage === "different-id") await fs.writeFile(cached.metadata, JSON.stringify({ ...ref, id: randomUUID() }));
    const files = await filesInside(root);
    const sidecar = damage === "missing" ? undefined : await fs.readFile(cached.metadata);
    await expect(cache.discard("room", ref)).rejects.toThrow();
    expect(await filesInside(root)).toEqual(files);
    expect(await fs.readFile(cached.data)).toEqual(bytes);
    if (sidecar) expect(await fs.readFile(cached.metadata)).toEqual(sidecar);
  });

  it.each(["missing", "corrupt"])("discards an owned matching sidecar even with %s data", async (damage) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root, { maxBytes: entryBytes(ref) });
    await cache.store("room", ref, bytes);
    if (damage === "missing") await fs.unlink(paths("room", ref).data);
    else await fs.writeFile(paths("room", ref).data, "changed");
    await expect(cache.read("room", ref)).rejects.toThrow();
    await cache.discard("room", ref);
    expect(await filesInside(root)).toEqual([]);
    await cache.store("room", ref, bytes);
    expect(await cache.read("room", ref)).toEqual(bytes);
  });

  it.each(["data", "metadata"] as const)("rejects a symlink at the discard %s path and preserves both targets", async (location) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root);
    await cache.store("room", ref, bytes);
    const cached = paths("room", ref);
    const outside = path.join(fixture, "outside");
    await fs.mkdir(outside);
    const sentinel = path.join(outside, "keep.txt");
    await fs.writeFile(sentinel, "keep");
    await fs.unlink(cached[location]);
    await fs.symlink(outside, cached[location], process.platform === "win32" ? "junction" : "dir");
    await expect(cache.discard("room", ref)).rejects.toThrow(/regular file|symlink/i);
    expect((await fs.lstat(cached[location])).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(sentinel, "utf8")).toBe("keep");
    const retained = location === "data" ? cached.metadata : cached.data;
    expect(await fs.readFile(retained)).toEqual(location === "data" ? Buffer.from(JSON.stringify(ref)) : bytes);
  });

  it.each(["data", "metadata"] as const)("keeps discard retryable when unlinking %s fails", async (location) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root, { maxBytes: entryBytes(ref) });
    await cache.store("room", ref, bytes);
    const cached = paths("room", ref);
    const originalUnlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === cached[location]) throw new Error("injected discard unlink failure");
      return originalUnlink(file);
    });
    await expect(cache.discard("room", ref)).rejects.toThrow(/injected discard/);
    expect(JSON.parse(await fs.readFile(cached.metadata, "utf8"))).toEqual(ref);
    if (location === "data") expect(await cache.read("room", ref)).toEqual(bytes);
    else expect(await filesInside(root)).toEqual([cached.metadata]);
    vi.restoreAllMocks();
    await cache.discard("room", ref);
    expect(await filesInside(root)).toEqual([]);
    await cache.store("room", ref, bytes);
    expect(await cache.read("room", ref)).toEqual(bytes);
  });

  it("holds the root lock through discarding both files before allowing another store", async () => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const maxBytes = entryBytes(ref);
    const cache = new RoomAttachmentCache(root, { maxBytes });
    await cache.store("room", ref, bytes);
    const cached = paths("room", ref);
    let reached!: () => void;
    let release!: () => void;
    const deletingSidecar = new Promise<void>((resolve) => { reached = resolve; });
    const permitted = new Promise<void>((resolve) => { release = resolve; });
    const originalUnlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === cached.metadata) {
        reached();
        await permitted;
      }
      return originalUnlink(file);
    });
    const discarding = cache.discard("room", ref);
    try {
      await Promise.race([deletingSidecar, discarding.then(() => { throw new Error("Discard did not remove its sidecar"); })]);
      expect(await filesInside(root)).toEqual([cached.metadata]);
      let stored = false;
      const storing = new RoomAttachmentCache(root, { maxBytes }).store("room", ref, bytes).then(() => { stored = true; });
      const operations = Promise.all([discarding, storing]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const wasHeld = !stored;
      release();
      await operations;
      expect(wasHeld).toBe(true);
      expect(await cache.read("room", ref)).toEqual(bytes);
      expect(await filesInside(root)).toEqual([cached.data, cached.metadata].sort());
    } finally {
      release();
      await discarding.catch(() => {});
    }
  });

  it("checks discard permission after a queued store and all awaited sidecar reads, immediately before deletion", async () => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root);
    const cached = paths("room", ref);
    let reached!: () => void;
    let release!: () => void;
    const publishing = new Promise<void>((resolve) => { reached = resolve; });
    const permitted = new Promise<void>((resolve) => { release = resolve; });
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === cached.metadata) {
        reached();
        await permitted;
      }
      return originalRename(...args);
    });
    let sidecarReadFinished = false;
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === cached.metadata) {
        const originalClose = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await originalClose();
          sidecarReadFinished = true;
        });
      }
      return handle;
    });
    let allowed = true;
    const canDiscard = vi.fn(() => {
      expect(sidecarReadFinished).toBe(true);
      return allowed;
    });
    const storing = cache.store("room", ref, bytes);
    let discarding: Promise<void> | undefined;
    try {
      await Promise.race([publishing, storing.then(() => { throw new Error("Store did not publish a sidecar"); })]);
      discarding = new RoomAttachmentCache(root).discard("room", ref, canDiscard);
      const operations = Promise.allSettled([storing, discarding]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const callsBeforeLock = canDiscard.mock.calls.length;
      allowed = false; // Main publishes/references the attachment while discard is waiting for the root lock.
      release();
      const results = await operations;
      expect(callsBeforeLock).toBe(0);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(canDiscard).toHaveBeenCalledTimes(1);
      expect(await cache.read("room", ref)).toEqual(bytes);
      expect(await filesInside(root)).toEqual([cached.data, cached.metadata].sort());

      sidecarReadFinished = false;
      allowed = true;
      await cache.discard("room", ref, canDiscard);
      expect(canDiscard).toHaveBeenCalledTimes(2);
      expect(await filesInside(root)).toEqual([]);
    } finally {
      release();
      await Promise.allSettled([storing, discarding]);
    }
  });

  it("allows an identical store at full quota without overwriting or charging it twice", async () => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root, { maxBytes: entryBytes(ref) });
    await cache.store("room", ref, bytes);
    const dataStat = await fs.stat(paths("room", ref).data);
    const sidecarStat = await fs.stat(paths("room", ref).metadata);
    await cache.store("room", { ...ref }, Buffer.from(bytes));
    expect(await cache.read("room", ref)).toEqual(bytes);
    expect(await fs.stat(paths("room", ref).data)).toMatchObject({ ino: dataStat.ino, mtimeMs: dataStat.mtimeMs });
    expect(await fs.stat(paths("room", ref).metadata)).toMatchObject({ ino: sidecarStat.ino, mtimeMs: sidecarStat.mtimeMs });
    expect(await filesInside(root)).toHaveLength(2);
  });

  it.each(["data", "metadata"])("refuses same-id replacement with different %s", async (change) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root);
    await cache.store("room", ref, bytes);
    const changedBytes = change === "data" ? Buffer.from("changed") : bytes;
    const changedRef = change === "data" ? { ...ref, sha256: hash(changedBytes) } : { ...ref, name: "other.txt" };
    await expect(cache.store("room", changedRef, changedBytes)).rejects.toThrow();
    expect(await cache.read("room", ref)).toEqual(bytes);
    expect(await filesInside(root)).toHaveLength(2);
  });

  it("counts JSON sidecar bytes against quota", async () => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    await expect(new RoomAttachmentCache(root, { maxBytes: entryBytes(ref) - 1 }).store("room", ref, bytes)).rejects.toThrow(/quota|full|limit/i);
    expect(await filesInside(root)).toEqual([]);
  });

  it("lazily counts existing nested files, including unrecognized and partial files", async () => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root, { maxBytes: entryBytes(ref) + 4 });
    const nested = path.join(root, "existing", "nested");
    await fs.mkdir(nested, { recursive: true });
    const existing = path.join(nested, "orphan.tmp");
    await fs.writeFile(existing, Buffer.alloc(5));
    await expect(cache.store("room", ref, bytes)).rejects.toThrow(/quota|full|limit/i);
    expect(await filesInside(root)).toEqual([existing]);
    expect(await fs.readFile(existing)).toEqual(Buffer.alloc(5));
  });

  it("counts persisted entries against quota after restart without evicting them", async () => {
    const bytes = Buffer.from("content");
    const first = reference(bytes);
    const second = reference(bytes);
    await new RoomAttachmentCache(root).store("room", first, bytes);
    const restarted = new RoomAttachmentCache(root, { maxBytes: entryBytes(first) + entryBytes(second) - 1 });
    await expect(restarted.store("room", second, bytes)).rejects.toThrow();
    expect(await restarted.read("room", first)).toEqual(bytes);
    expect(await filesInside(root)).toHaveLength(2);
  });

  it.each([false, true])("serializes concurrent quota reservations (separate instances: %s)", async (separateInstances) => {
    const bytes = Buffer.alloc(1024, 9);
    const refs = Array.from({ length: 8 }, () => reference(bytes));
    const maxBytes = entryBytes(refs[0]);
    const cache = new RoomAttachmentCache(root, { maxBytes });
    const results = await Promise.allSettled(refs.map((ref, index) => {
      const writer = separateInstances ? new RoomAttachmentCache(path.join(root, "."), { maxBytes }) : cache;
      return writer.store(`room-${index}`, ref, bytes);
    }));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect(await cache.read(`room-${winner}`, refs[winner])).toEqual(bytes);
    const files = await filesInside(root);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
    const sizes = await Promise.all(files.map(async (file) => (await fs.stat(file)).size));
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(maxBytes);
  });

  it("prevents competing same-id stores from mixing metadata and bytes", async () => {
    const firstBytes = Buffer.from("first");
    const secondBytes = Buffer.from("other");
    const first = reference(firstBytes);
    const second = { ...first, sha256: hash(secondBytes) };
    const cache = new RoomAttachmentCache(root);
    const results = await Promise.allSettled([
      cache.store("room", first, firstBytes),
      new RoomAttachmentCache(root).store("room", second, secondBytes),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const firstWon = results[0].status === "fulfilled";
    expect(await cache.read("room", firstWon ? first : second)).toEqual(firstWon ? firstBytes : secondBytes);
    expect(await filesInside(root)).toHaveLength(2);
  });

  it.each(["first-rename", "second-rename", "partial-write"] as const)("cleans failed atomic stores and releases quota: %s", async (failure) => {
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root, { maxBytes: entryBytes(ref) });
    if (failure === "partial-write") {
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith(".tmp")) {
          const originalWrite = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
            await originalWrite("partial");
            throw new Error("injected disk write failure");
          });
        }
        return handle;
      });
    } else {
      const originalRename = fs.rename.bind(fs);
      let renames = 0;
      vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
        renames++;
        if (renames === (failure === "first-rename" ? 1 : 2)) throw new Error("injected rename failure");
        return originalRename(...args);
      });
    }
    await expect(cache.store("room", ref, bytes)).rejects.toThrow(/injected/);
    expect(await filesInside(root)).toEqual([]);
    await expect(cache.read("room", ref)).rejects.toThrow();
    vi.restoreAllMocks();
    await cache.store("room", ref, bytes);
    expect(await cache.read("room", ref)).toEqual(bytes);
    expect(await filesInside(root)).toHaveLength(2);
  });

  it("takes ownership of store bytes and metadata before awaiting disk operations", async () => {
    const bytes = Buffer.from("content");
    const original = Buffer.from(bytes);
    const ref = reference(bytes);
    const originalRef = { ...ref };
    const cache = new RoomAttachmentCache(root);
    const storing = cache.store("room", ref, bytes);
    bytes.fill(0);
    ref.name = "mutated.txt";
    await storing;
    expect(await cache.read("room", originalRef)).toEqual(original);
  });

  it("does not follow symlink directories while scanning existing disk usage", async () => {
    const outside = path.join(fixture, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "large.bin"), Buffer.alloc(8192));
    await fs.mkdir(root);
    await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const cache = new RoomAttachmentCache(root, { maxBytes: entryBytes(ref) + 1024 });
    await cache.store("room", ref, bytes);
    expect(await cache.read("room", ref)).toEqual(bytes);
    expect((await fs.stat(path.join(outside, "large.bin"))).size).toBe(8192);
  });

  it.each(["root", "room"])("rejects a symlink at the cache %s instead of reading or writing outside it", async (location) => {
    const outside = path.join(fixture, "outside");
    await fs.mkdir(outside);
    const bytes = Buffer.from("content");
    const ref = reference(bytes);
    const target = location === "root" ? root : paths("room", ref).dir;
    if (location === "room") await fs.mkdir(root);
    await fs.symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(outside, `${ref.id}.bin`), bytes);
    await fs.writeFile(path.join(outside, `${ref.id}.json`), JSON.stringify(ref));
    const cache = new RoomAttachmentCache(root);
    await expect(cache.store("room", ref, bytes)).rejects.toThrow(/symlink|directory/i);
    await expect(cache.read("room", ref)).rejects.toThrow(/symlink|directory/i);
    await expect(cache.localAttachment("room", ref)).rejects.toThrow(/symlink|directory/i);
    await expect(cache.discard("room", ref)).rejects.toThrow(/symlink|directory/i);
    expect(await fs.readFile(path.join(outside, `${ref.id}.bin`))).toEqual(bytes);
    expect(await filesInside(outside)).toHaveLength(2);
  });
});
