import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PHOTO_FLOW_LIMITS as limits, PhotoFlowService } from "./photo-flow-service";

const directories: string[] = [];
const services: PhotoFlowService[] = [];
const jpeg = (size = 100) => { const bytes = Buffer.alloc(size, 1); bytes.set([255, 216, 255]); return bytes; };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const photo = (id: number) => ({ id: String(id), width: 1000, height: 700, author: "Photographer", url: "https://unsplash.com/photos/example" });
const image = (size = 100) => new Response(jpeg(size), { headers: { "Content-Type": "image/jpeg" } });

async function setup(options: { size?: number; fetch?: typeof fetch } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "photo-flow-test-"));
  directories.push(dir);
  let now = 1_800_000_000_000;
  const fetcher = vi.fn(options.fetch ?? (async input => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? 1);
    return url.pathname === "/v2/list" ? json(Array.from({ length: 20 }, (_, i) => photo(page * 100 + i))) : image(options.size);
  }));
  const onChanged = vi.fn();
  const deps = { userDataDir: dir, fetch: fetcher, validateImage: () => true, now: () => now, onChanged };
  const create = () => { const service = new PhotoFlowService(deps); services.push(service); service.setEnabled(true); return service; };
  const service = create();
  return { dir, service, create, fetcher, onChanged, advance: (ms: number) => { now += ms; },
    manifest: async () => JSON.parse(await fs.readFile(path.join(dir, "photo-flow/manifest.json"), "utf8")) };
}

afterEach(async () => {
  services.splice(0).forEach(service => service.dispose());
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("photo flow cache and schedule", () => {
  it("downloads 12, deduplicates concurrent refreshes, and enforces 24h across restart", async () => {
    const s = await setup();
    await Promise.all([s.service.refreshIfDue(), s.service.refreshIfDue()]);
    expect(await s.service.getImages()).toHaveLength(12);
    expect(s.fetcher).toHaveBeenCalledTimes(13);
    expect(s.onChanged).toHaveBeenCalledTimes(1);
    s.service.dispose();
    const restarted = s.create();
    await restarted.refreshIfDue();
    expect(s.fetcher).toHaveBeenCalledTimes(13);
    expect(await restarted.getImages()).toHaveLength(12);
    s.advance(limits.interval);
    await restarted.refreshIfDue();
    expect(await restarted.getImages()).toHaveLength(24);
    expect((await s.manifest()).nextPage).toBe(3);
  });

  it("evicts oldest files after 48 photos", async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) { await s.service.refreshIfDue(); s.advance(limits.interval); }
    const photos = await s.service.getImages();
    expect(photos).toHaveLength(48);
    expect(photos.some(photo => photo.id === "100")).toBe(false);
    expect(photos[0].id).toBe("500");
    expect((await fs.readdir(path.join(s.dir, "photo-flow"))).filter(name => name.endsWith(".jpg"))).toHaveLength(48);
  });

  it("enforces the byte limit independently of the image count", async () => {
    const s = await setup({ size: limits.imageBytes });
    for (let i = 0; i < 4; i++) { await s.service.refreshIfDue(); s.advance(limits.interval); }
    const manifest = await s.manifest();
    expect(manifest.images).toHaveLength(40);
    expect(manifest.images.reduce((sum: number, entry: { bytes: number }) => sum + entry.bytes, 0)).toBe(limits.bytes);
    const files = await fs.readdir(path.join(s.dir, "photo-flow"));
    expect(files.filter(name => name.endsWith(".jpg"))).toHaveLength(40);
  });

  it("keeps old photos on failure, persists retry delay, and recovers later", async () => {
    const s = await setup();
    await s.service.refreshIfDue();
    const before = await s.service.getImages();
    s.advance(limits.interval);
    s.fetcher.mockRejectedValueOnce(new Error("offline"));
    await s.service.refreshIfDue();
    expect(await s.service.getImages()).toEqual(before);
    s.service.dispose();
    const restarted = s.create();
    const calls = s.fetcher.mock.calls.length;
    await restarted.refreshIfDue();
    expect(s.fetcher).toHaveBeenCalledTimes(calls);
    s.advance(limits.retry);
    await restarted.refreshIfDue();
    expect(await restarted.getImages()).toHaveLength(24);
  });

  it("never downloads when disabled; disabling aborts an active request", async () => {
    const s = await setup();
    s.service.setEnabled(false);
    await s.service.refreshIfDue();
    expect(s.fetcher).not.toHaveBeenCalled();
    let signal: AbortSignal | null | undefined;
    s.fetcher.mockImplementationOnce(async (_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    s.service.setEnabled(true);
    const refresh = s.service.refreshIfDue();
    await vi.waitFor(() => expect(signal).toBeDefined());
    s.service.setEnabled(false);
    await refresh;
    expect(signal?.aborted).toBe(true);
    expect(await s.service.getImages()).toEqual([]);
    expect((await s.manifest()).images).toEqual([]);
    s.advance(limits.retry);
    s.service.setEnabled(true);
    await s.service.refreshIfDue();
    expect(await s.service.getImages()).toHaveLength(12);
  });

  it("rejects unsafe redirects before contacting another host", async () => {
    const s = await setup({ fetch: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }) });
    await s.service.refreshIfDue();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(await s.service.getImages()).toEqual([]);
  });

  it("rejects non-images, oversized streams and duplicate IDs", async () => {
    let attempts = 0;
    const s = await setup({ fetch: async input => {
      if (String(input).includes("/v2/list")) return json([photo(1), photo(2), photo(3), photo(3)]);
      attempts++;
      if (attempts === 1) return new Response("<html>Error</html>", { headers: { "Content-Type": "text/html" } });
      if (attempts === 2) return image(limits.imageBytes + 1);
      return image();
    } });
    await s.service.refreshIfDue();
    expect((await s.service.getImages()).map(photo => photo.id)).toEqual(["3"]);
    expect(attempts).toBe(3);
  });

  it("wraps pagination and skips cached photos", async () => {
    const s = await setup();
    await s.service.refreshIfDue();
    s.advance(limits.interval);
    s.fetcher.mockImplementationOnce(async () => json([]));
    await s.service.refreshIfDue();
    expect(await s.service.getImages()).toHaveLength(20);
    expect((await s.manifest()).nextPage).toBe(2);
  });

  it("drops corrupt cache files and cleans orphan images on restart", async () => {
    const s = await setup();
    await s.service.refreshIfDue();
    s.service.dispose();
    await fs.writeFile(path.join(s.dir, "photo-flow/100.jpg"), "bad");
    await fs.writeFile(path.join(s.dir, "photo-flow/99999.jpg"), jpeg());
    const restarted = s.create();
    expect(await restarted.getImages()).toHaveLength(11);
    const files = await fs.readdir(path.join(s.dir, "photo-flow"));
    expect(files).not.toContain("100.jpg");
    expect(files).not.toContain("99999.jpg");
  });

  it("runs the scheduler and cancels it when disabled", async () => {
    const s = await setup();
    await s.service.getImages();
    s.service.setEnabled(false);
    vi.useFakeTimers();
    s.service.setEnabled(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await s.service.refreshIfDue();
    expect(await s.service.getImages()).toHaveLength(12);
    s.service.setEnabled(false);
    s.advance(limits.interval);
    await vi.advanceTimersByTimeAsync(limits.interval);
    expect(s.fetcher).toHaveBeenCalledTimes(13);
  });
});
