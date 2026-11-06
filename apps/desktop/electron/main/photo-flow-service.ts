import fs from "node:fs/promises";
import path from "node:path";
import type { PhotoFlowImage } from "@claude-desktop/shared";

export const PHOTO_FLOW_LIMITS = {
  interval: 24 * 60 * 60 * 1000,
  retry: 60 * 60 * 1000,
  batch: 12,
  count: 48,
  bytes: 20 * 1024 * 1024,
  imageBytes: 512 * 1024,
} as const;

type Entry = Omit<PhotoFlowImage, "src"> & { bytes: number; addedAt: number };
type Manifest = { version: 1; lastSuccess: number; lastAttempt: number; nextPage: number; images: Entry[] };
type Deps = {
  userDataDir: string;
  fetch: typeof fetch;
  validateImage: (bytes: Buffer) => boolean;
  onChanged?: () => void;
  now?: () => number;
};
const emptyManifest = (): Manifest => ({ version: 1, lastSuccess: 0, lastAttempt: 0, nextPage: 1, images: [] });
const validId = (id: unknown): id is string => typeof id === "string" && /^\d{1,10}$/.test(id);
const sourceUrl = (value: unknown): string | undefined => {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && ["unsplash.com", "www.unsplash.com"].includes(url.hostname)
      && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
};

/** Single owner of the cache and schedule. No renderer-provided URLs or paths. */
export class PhotoFlowService {
  private readonly dir: string;
  private readonly now: () => number;
  private manifest = emptyManifest();
  private readonly ready: Promise<void>;
  private enabled = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private pending?: Promise<void>;

  constructor(private readonly deps: Deps) {
    this.dir = path.join(deps.userDataDir, "photo-flow");
    this.now = deps.now ?? Date.now;
    this.ready = this.load();
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    clearTimeout(this.timer);
    if (!enabled) this.controller?.abort();
    else this.schedule(15_000);
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    clearTimeout(this.timer);
    this.controller?.abort();
  }

  async getImages(): Promise<PhotoFlowImage[]> {
    await this.ready;
    if (!this.enabled) return [];
    const images = await Promise.all(this.manifest.images.map(async entry => {
      try {
        if ((await fs.stat(this.imagePath(entry.id))).size > PHOTO_FLOW_LIMITS.imageBytes) return null;
        const bytes = await fs.readFile(this.imagePath(entry.id));
        if (!this.validImage(bytes) || bytes.length !== entry.bytes) return null;
        const { bytes: _size, addedAt: _time, ...image } = entry;
        return { ...image, src: `data:image/jpeg;base64,${bytes.toString("base64")}` };
      } catch { return null; }
    }));
    return this.enabled ? images.filter((image): image is PhotoFlowImage => image !== null) : [];
  }

  /** Also used by isolated acceptance checks; respects enablement and due times. */
  async refreshIfDue(): Promise<void> {
    await this.ready;
    if (!this.enabled || this.disposed) return;
    if (this.pending) return this.pending;
    const now = this.now();
    if ((this.manifest.lastSuccess && now - this.manifest.lastSuccess < PHOTO_FLOW_LIMITS.interval)
      || (this.manifest.lastAttempt && now - this.manifest.lastAttempt < PHOTO_FLOW_LIMITS.retry)) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.pending = this.refresh(signal).catch(() => {
      // Keep the previous pool; the persisted attempt time bounds retries.
    }).finally(() => {
      this.pending = undefined;
      this.controller = undefined;
    });
    return this.pending;
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    if (!this.enabled || this.disposed) return;
    this.timer = setTimeout(() => {
      void this.refreshIfDue().finally(() => this.schedule(60_000));
    }, delay);
    this.timer.unref?.();
  }

  private imagePath(id: string): string { return path.join(this.dir, `${id}.jpg`); }

  private validImage(bytes: Buffer): boolean {
    return bytes.length > 4 && bytes.length <= PHOTO_FLOW_LIMITS.imageBytes
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && this.deps.validateImage(bytes);
  }

  private async load(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const stat = await fs.stat(path.join(this.dir, "manifest.json"));
      if (stat.size > 128 * 1024) throw new Error("Invalid manifest size");
      const raw = JSON.parse(await fs.readFile(path.join(this.dir, "manifest.json"), "utf8"));
      if (raw.version !== 1 || !Array.isArray(raw.images)) throw new Error("Invalid manifest");
      const now = this.now();
      const time = (value: unknown) => typeof value === "number" && Number.isFinite(value)
        && value > 0 ? Math.min(value, now) : 0;
      const ids = new Set<string>();
      const images: Entry[] = [];
      let total = 0;
      for (const entry of raw.images.slice(0, PHOTO_FLOW_LIMITS.count)) {
        if (!entry || !validId(entry.id) || ids.has(entry.id)) continue;
        try {
          const stat = await fs.stat(this.imagePath(entry.id));
          if (stat.size > PHOTO_FLOW_LIMITS.imageBytes || total + stat.size > PHOTO_FLOW_LIMITS.bytes) continue;
          const bytes = await fs.readFile(this.imagePath(entry.id));
          if (!this.validImage(bytes)) continue;
          images.push({ id: entry.id, portrait: entry.portrait === true, position: "50% 50%",
            author: typeof entry.author === "string" ? entry.author.slice(0, 160) : undefined,
            sourceUrl: sourceUrl(entry.sourceUrl), bytes: bytes.length, addedAt: time(entry.addedAt) });
          ids.add(entry.id);
          total += bytes.length;
        } catch { /* Skip deleted or corrupt files and retain valid ones. */ }
      }
      this.manifest = { version: 1, images,
        lastSuccess: images.length ? time(raw.lastSuccess) : 0,
        lastAttempt: time(raw.lastAttempt),
        nextPage: Number.isInteger(raw.nextPage) && raw.nextPage > 0 && raw.nextPage <= 100 ? raw.nextPage : 1 };
    } catch { /* First run or a corrupt manifest falls back to bundled photos. */ }
    await this.cleanup().catch(() => undefined);
  }

  private async save(manifest: Manifest): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const temp = path.join(this.dir, "manifest.tmp");
    await fs.writeFile(temp, JSON.stringify(manifest), "utf8");
    await fs.rename(temp, path.join(this.dir, "manifest.json"));
    this.manifest = manifest;
  }

  private async cleanup(): Promise<void> {
    const keep = new Set(this.manifest.images.map(entry => `${entry.id}.jpg`));
    for (const name of await fs.readdir(this.dir)) {
      if (/^\d{1,10}\.jpg$/.test(name) && !keep.has(name)) {
        await fs.unlink(path.join(this.dir, name)).catch(() => undefined);
      }
    }
  }

  private async request(url: string, limit: number, image: boolean, signal: AbortSignal): Promise<Buffer> {
    const timeout = AbortSignal.timeout(15_000);
    const combined = AbortSignal.any([signal, timeout]);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const target = new URL(url);
      if (target.protocol !== "https:" || !["picsum.photos", "fastly.picsum.photos"].includes(target.hostname)
        || target.username || target.password || (target.port && target.port !== "443")) throw new Error("Invalid photo host");
      const response = await this.deps.fetch(target.href, { signal: combined, redirect: "manual",
        headers: { Accept: image ? "image/jpeg" : "application/json" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Missing redirect location");
        url = new URL(location, target).href;
        continue;
      }
      const type = response.headers.get("content-type")?.split(";")[0].trim();
      if (!response.ok || type !== (image ? "image/jpeg" : "application/json")
        || Number(response.headers.get("content-length")) > limit || !response.body) {
        await response.body?.cancel();
        throw new Error("Invalid photo response");
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          combined.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new Error("Photo response too large");
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return Buffer.concat(chunks);
    }
    throw new Error("Too many redirects");
  }

  private async refresh(signal: AbortSignal): Promise<void> {
    await this.save({ ...this.manifest, lastAttempt: this.now() });
    signal.throwIfAborted();
    let page = this.manifest.nextPage;
    const list = async () => JSON.parse((await this.request(
      `https://picsum.photos/v2/list?page=${page}&limit=100`, 128 * 1024, false, signal)).toString("utf8")) as unknown;
    let raw = await list();
    if (Array.isArray(raw) && raw.length === 0 && page > 1) { page = 1; raw = await list(); }
    if (!Array.isArray(raw)) throw new Error("Invalid photo list");
    const ids = new Set(this.manifest.images.map(entry => entry.id));
    const downloaded: { entry: Entry; bytes: Buffer }[] = [];
    // Bound failed candidates too, so an unavailable CDN cannot trigger a request storm.
    let attempts = 0;
    for (const item of raw.slice(0, 100)) {
      signal.throwIfAborted();
      if (!item || !validId(item.id) || ids.has(item.id)
        || !Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width <= 0 || item.height <= 0) continue;
      if (downloaded.length >= PHOTO_FLOW_LIMITS.batch || attempts++ >= PHOTO_FLOW_LIMITS.batch * 2) break;
      try {
        const portrait = item.height > item.width;
        const bytes = await this.request(`https://picsum.photos/id/${item.id}/${portrait ? "470/600" : "600/470"}.jpg`,
          PHOTO_FLOW_LIMITS.imageBytes, true, signal);
        if (!this.validImage(bytes)) continue;
        downloaded.push({ entry: { id: item.id, portrait, position: "50% 50%", bytes: bytes.length,
          addedAt: this.now(), author: typeof item.author === "string" ? item.author.slice(0, 160) : undefined,
          sourceUrl: sourceUrl(item.url) }, bytes });
        ids.add(item.id);
      } catch { signal.throwIfAborted(); }
    }
    if (!downloaded.length) throw new Error("No new photos available");
    signal.throwIfAborted();
    let images = [...downloaded.map(item => item.entry), ...this.manifest.images].slice(0, PHOTO_FLOW_LIMITS.count);
    let total = 0;
    images = images.filter(entry => { total += entry.bytes; return total <= PHOTO_FLOW_LIMITS.bytes; });
    try {
      for (const item of downloaded) {
        signal.throwIfAborted();
        if (images.includes(item.entry)) await fs.writeFile(this.imagePath(item.entry.id), item.bytes);
      }
      signal.throwIfAborted();
      await this.save({ ...this.manifest, images, lastSuccess: this.now(), nextPage: page >= 100 ? 1 : page + 1 });
    } finally { await this.cleanup(); }
    if (this.enabled && !signal.aborted) this.deps.onChanged?.();
  }
}
