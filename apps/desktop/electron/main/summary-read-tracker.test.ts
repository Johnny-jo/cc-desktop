import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSummaryReadTracker } from "./summary-read-tracker";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-read-proof-")); roots.push(root);
  const file = path.join(root, "source.txt"); fs.writeFileSync(file, "one\ntwo\nthree\n");
  let active = true;
  const tracker = createSummaryReadTracker({ root, isActive: () => active });
  const input = (id: string, args: Record<string, unknown> = { file_path: file }) => ({ tool_name: "Read", tool_use_id: id, tool_input: args });
  // Real vendor CLI + SDK 0.3.318 fixture: trailing empty lines count as lines.
  // Raw probe data: .tmp/summary-read-shape.json (isolated loopback provider).
  const response = (content = "one\ntwo\nthree\n") => ({ type: "text", file: { filePath: file, content, numLines: content.split("\n").length, startLine: 1, totalLines: content.split("\n").length } });
  const read = async (id: string, args = { file_path: file } as Record<string, unknown>, result: unknown = response()) => {
    await tracker.pre(input(id, args)); await tracker.post({ ...input(id, args), tool_response: result });
    return tracker.take(id, "visible preview", "visible preview");
  };
  return { root, file, tracker, input, response, read, deactivate: () => { active = false; } };
}

describe("summary Read proofs", () => {
  it("fingerprints complete hook results and binds the final preview without extra content reads", async () => {
    const f = fixture();
    const read = vi.spyOn(fs, "readFileSync"), asyncRead = vi.spyOn(fs.promises, "readFile");
    const a = await f.read("a"), b = await f.read("b");
    expect(a).toEqual(b); expect(a).toMatchObject({ format: 1, previewHash: hash("visible preview") });
    for (const field of ["inputHash", "targetVersion", "resultHash"] as const) expect(a?.[field]).toMatch(/^[a-f0-9]{64}$/);
    expect(read).not.toHaveBeenCalled(); expect(asyncRead).not.toHaveBeenCalled();
    expect(f.tracker.take("a", "visible preview", "visible preview")).toBeUndefined();
  });
  it("hashes all JSON parameters in stable key order and retains unknown response fields", async () => {
    const f = fixture();
    const a = await f.read("a", { file_path: f.file, extra: { z: 1, a: 2 } });
    const b = await f.read("b", { extra: { a: 2, z: 1 }, file_path: f.file });
    const c = await f.read("c", { file_path: f.file, extra: { z: 2, a: 2 } });
    expect(a?.inputHash).toBe(b?.inputHash); expect(a?.inputHash).not.toBe(c?.inputHash);
    const changed = await f.read("d", undefined, { ...f.response(), futureMetadata: "different" });
    expect(a?.resultHash).not.toBe(changed?.resultHash);
  });
  it("fingerprints the full result tail despite identical previews", async () => {
    const f = fixture(), a = await f.read("a", undefined, f.response("same prefix\nfirst tail"));
    const b = await f.read("b", undefined, f.response("same prefix\nsecond tail"));
    expect(a?.resultHash).not.toBe(b?.resultHash); expect(a?.previewHash).toBe(b?.previewHash);
  });
  it("accepts explicitly requested complete line ranges", async () => {
    const f = fixture(), result = f.response("two"); Object.assign(result.file, { startLine: 2, totalLines: 4 });
    expect(await f.read("a", { file_path: f.file, offset: 2, limit: 1 }, result)).toBeDefined();
    expect(await f.read("b", { file_path: f.file, offset: 2 }, { ...result, file: { ...result.file, content: "two\nthree\n", numLines: 3 } })).toBeDefined();
  });
  it.each([
    ["missing structure", "preview only"], ["non-text", { type: "image", file: { base64: "x" } }],
    ["missing content", { type: "text", file: { numLines: 4, startLine: 1, totalLines: 4 } }],
  ])("rejects %s", async (_label, result) => { const f = fixture(); expect(await f.read("a", undefined, result)).toBeUndefined(); });
  it.each(["truncatedByTokenCap", "truncated", "is_error", "partial", "preview", "error"])("rejects the %s signal", async flag => {
    const f = fixture(), result = f.response(); Object.assign(result.file, { [flag]: true });
    expect(await f.read("a", undefined, result)).toBeUndefined();
  });
  it("rejects incomplete ranges, wrong paths, multimodal and shortened placeholders", async () => {
    const f = fixture(), result = f.response();
    for (const response of [
      { ...result, file: { ...result.file, numLines: 1 } },
      { ...result, file: { ...result.file, totalLines: 10 } },
      { ...result, file: { ...result.file, startLine: 2 } },
      { ...result, file: { ...result.file, filePath: path.join(f.root, "other.txt") } },
      { ...result, content: [{ type: "image", data: "x" }] }, f.response("[Output truncated: preview only]"),
    ]) expect(await f.read("a", undefined, response)).toBeUndefined();
  });
  it("changes versions between reads and rejects file changes during a Read", async () => {
    const f = fixture(), a = await f.read("a");
    fs.writeFileSync(f.file, "different size"); const b = await f.read("b", undefined, f.response("different size"));
    expect(a?.targetVersion).not.toBe(b?.targetVersion);
    await f.tracker.pre(f.input("c")); fs.writeFileSync(f.file, "changed during Read");
    await f.tracker.post({ ...f.input("c"), tool_response: f.response("changed during Read") });
    expect(f.tracker.take("c", "preview", "preview")).toBeUndefined();
  });
  it("rotates scopes on unknown tools, writes and failed reads, rejecting pending results", async () => {
    const f = fixture(); let previous = await f.read("a");
    for (const name of ["Bash", "Write", "Glob", "mcp__server__read"]) {
      await f.tracker.pre(f.input("pending")); await f.tracker.pre({ tool_name: name, tool_use_id: "other", tool_input: {} });
      await f.tracker.post({ ...f.input("pending"), tool_response: f.response() });
      expect(f.tracker.take("pending", "preview", "preview")).toBeUndefined();
      const next = await f.read(name); expect(next?.scope).not.toBe(previous?.scope); previous = next;
    }
    await f.tracker.pre(f.input("failed")); await f.tracker.failure({ ...f.input("failed"), error: "permission denied" });
    expect((await f.read("after-failure"))?.scope).not.toBe(previous?.scope);
  });
  it("rejects outside paths, symlink escapes, non-files and inconsistent identities", async () => {
    const f = fixture(), outside = fixture(), link = path.join(f.root, "escape"); fs.symlinkSync(outside.root, link, "junction");
    for (const file of [outside.file, path.join(link, "source.txt"), f.root, path.join(f.root, "missing")]) {
      expect(await f.read("a", { file_path: file })).toBeUndefined();
    }
    await f.tracker.pre(f.input("b")); await f.tracker.post({ ...f.input("b"), tool_name: "mcp__Read", tool_response: f.response() });
    expect(f.tracker.take("b", "preview", "preview")).toBeUndefined();
  });
  it("rejects lexical escapes and Windows network/device paths before any metadata access", async () => {
    const f = fixture();
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => { throw new Error("Unexpected realpath"); });
    const stat = vi.spyOn(fs, "statSync").mockImplementation(() => { throw new Error("Unexpected stat"); });
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(() => { throw new Error("Unexpected lstat"); });
    for (const file of ["../outside.txt", path.resolve(f.root, "../outside.txt"),
      "\\\\fixture.invalid\\share\\source.txt", "//fixture.invalid/share/source.txt", "\\\\?\\C:\\source.txt", "\\\\.\\NUL", "\\??\\C:\\source.txt"]) {
      expect(await f.read("a", { file_path: file })).toBeUndefined();
      expect(realpath).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled(); expect(lstat).not.toHaveBeenCalled();
    }
  });
  it("rejects Windows network/device roots before any filesystem access", () => {
    const f = fixture();
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => { throw new Error("Unexpected realpath"); });
    const stat = vi.spyOn(fs, "statSync").mockImplementation(() => { throw new Error("Unexpected stat"); });
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(() => { throw new Error("Unexpected lstat"); });
    for (const root of ["\\\\fixture.invalid\\share", "//fixture.invalid/share", "\\\\?\\C:\\", "\\\\.\\C:\\", "\\??\\C:\\"]) {
      createSummaryReadTracker({ root, isActive: () => true });
      expect(realpath).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled(); expect(lstat).not.toHaveBeenCalled();
    }
    expect(f.root).toBeTruthy();
  });
  it("rejects all junction paths before realpath can follow their target", async () => {
    const f = fixture(), target = path.join(f.root, "target"), link = path.join(f.root, "link");
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, "file.txt"), "fixture"); fs.symlinkSync(target, link, "junction");
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => { throw new Error("Unexpected realpath through junction"); });
    const stat = vi.spyOn(fs, "statSync").mockImplementation(() => { throw new Error("Unexpected stat through junction"); });
    expect(await f.read("a", { file_path: path.join(link, "file.txt") })).toBeUndefined();
    expect(realpath).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
  });
  it("requires absolute input and response paths instead of assuming a hook cwd", async () => {
    const f = fixture();
    const call = { ...f.input("relative", { file_path: "source.txt" }), cwd: path.join(f.root, "child") };
    await f.tracker.pre(call); await f.tracker.post({ ...call, tool_response: f.response() });
    expect(f.tracker.take("relative", "preview", "preview")).toBeUndefined();
    await f.tracker.pre(f.input("relative-result"));
    await f.tracker.post({ ...f.input("relative-result"), tool_response: { ...f.response(), file: { ...f.response().file, filePath: "source.txt" } } });
    expect(f.tracker.take("relative-result", "preview", "preview")).toBeUndefined();
    expect(await f.read("absolute")).toBeDefined();
  });
  it("rejects child agents, MCP provenance, mismatched parameters, missing previews and unpaired posts", async () => {
    const f = fixture();
    for (const extra of [{ agent_id: "child" }, { mcp_server: { name: "read" } }]) {
      await f.tracker.pre({ ...f.input("a"), ...extra }); await f.tracker.post({ ...f.input("a"), ...extra, tool_response: f.response() });
      expect(f.tracker.take("a", "preview", "preview")).toBeUndefined();
    }
    await f.tracker.pre(f.input("b")); await f.tracker.post({ ...f.input("b", { file_path: f.file, limit: 1 }), tool_response: f.response() });
    expect(f.tracker.take("b", "preview", "preview")).toBeUndefined();
    await f.tracker.post({ ...f.input("unpaired"), tool_response: f.response() }); expect(f.tracker.take("unpaired", "preview", "preview")).toBeUndefined();
    await f.tracker.pre(f.input("missing-preview")); await f.tracker.post({ ...f.input("missing-preview"), tool_response: f.response() });
    expect(f.tracker.take("missing-preview", undefined)).toBeUndefined();
  });
  it("revokes cancelled, inactive and late results, including untaken completed ones", async () => {
    for (const revoke of ["cancel", "inactive", "explicit"] as const) {
      const f = fixture(), controller = new AbortController();
      await f.tracker.pre(f.input("a"), undefined, { signal: controller.signal });
      await f.tracker.post({ ...f.input("a"), tool_response: f.response() });
      if (revoke === "cancel") controller.abort(); else if (revoke === "inactive") f.deactivate(); else f.tracker.revoke();
      expect(f.tracker.take("a", "preview", "preview")).toBeUndefined();
      await f.tracker.post({ ...f.input("a"), tool_response: f.response() }); expect(f.tracker.take("a", "preview", "preview")).toBeUndefined();
    }
  });
  it("bounds pending and completed records, rejecting evicted late results", async () => {
    const f = fixture();
    for (let i = 0; i < 520; i++) await f.tracker.pre(f.input("pending" + i));
    await f.tracker.post({ ...f.input("pending0"), tool_response: f.response() }); expect(f.tracker.take("pending0", "preview", "preview")).toBeUndefined();
    for (let i = 0; i < 520; i++) { await f.tracker.pre(f.input("done" + i)); await f.tracker.post({ ...f.input("done" + i), tool_response: f.response() }); }
    expect(f.tracker.take("done0", "preview", "preview")).toBeUndefined(); expect(f.tracker.take("done519", "preview", "preview")).toBeDefined();
  });
  it("retains both hook cancellation signals until the final preview is bound", async () => {
    const f = fixture(), pre = new AbortController(), post = new AbortController();
    await f.tracker.pre(f.input("a"), undefined, { signal: pre.signal });
    await f.tracker.post({ ...f.input("a"), tool_response: f.response() }, undefined, { signal: post.signal });
    post.abort();
    expect(f.tracker.take("a", "preview", "preview")).toBeUndefined();
  });
  it("does not pair an ambiguous reused pending ID with a late result", async () => {
    const f = fixture(); await f.tracker.pre(f.input("a")); await f.tracker.pre(f.input("a"));
    await f.tracker.post({ ...f.input("a"), tool_response: f.response() });
    expect(f.tracker.take("a", "preview", "preview")).toBeUndefined();
  });
  it("rejects malformed JSON rather than silently dropping fields from its hash", async () => {
    const f = fixture(), cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const extra of [undefined, NaN, Infinity, BigInt(1), cyclic, new Date()]) {
      expect(await f.read("a", { file_path: f.file, extra })).toBeUndefined();
    }
    expect(await f.read("recovered")).toBeDefined();
  });
  it("rejects sparse arrays instead of hashing them as empty arrays", async () => {
    const f = fixture();
    expect(await f.read("dense", { file_path: f.file, extra: [] })).toBeDefined();
    expect(await f.read("sparse", { file_path: f.file, extra: Array(1) })).toBeUndefined();
    expect(await f.read("nested", { file_path: f.file, extra: [Array(2)] })).toBeUndefined();
    await f.tracker.pre(f.input("result"));
    await f.tracker.post({ ...f.input("result"), tool_response: { ...f.response(), unknown: Array(1) } });
    expect(f.tracker.take("result", "preview", "preview")).toBeUndefined();
  });
  it("hashes array order, binds exactly the supplied final preview and returns inert hooks", async () => {
    const f = fixture();
    const a = await f.read("a", { file_path: f.file, extra: ["a", "b"] });
    const b = await f.read("b", { file_path: f.file, extra: ["b", "a"] });
    expect(a?.inputHash).not.toBe(b?.inputHash);
    expect(await f.tracker.pre(f.input("c"))).toEqual({});
    expect(await f.tracker.post({ ...f.input("c"), tool_response: f.response() })).toEqual({});
    expect(f.tracker.take("c", "final revised preview", "final revised preview")?.previewHash).toBe(hash("final revised preview"));
    expect(await f.tracker.failure(f.input("missing"))).toEqual({});
  });
  it("binds the complete delivered result after all Post hooks, even when visible prefixes match", async () => {
    const f = fixture(), prefix = "p".repeat(200), results = [];
    for (const [id, tail] of [["a", "first tail"], ["b", "different tail"]]) {
      await f.tracker.pre(f.input(id)); await f.tracker.post({ ...f.input(id), tool_response: f.response() });
      results.push(f.tracker.take(id, prefix, prefix + tail));
    }
    expect(results[0]).toBeDefined(); expect(results[1]).toBeDefined();
    expect(results[0]?.previewHash).toBe(results[1]?.previewHash);
    expect(results[0]?.resultHash).not.toBe(results[1]?.resultHash);
  });
  it("rejects absent, changed-preview and non-text delivered results", async () => {
    const f = fixture();
    for (const delivered of [undefined, { text: "preview" }, [{ type: "image", text: "preview" }],
      [{ type: "text", text: "preview" }, { type: "image", data: "x" }], "different preview"]) {
      await f.tracker.pre(f.input("a")); await f.tracker.post({ ...f.input("a"), tool_response: f.response() });
      expect(f.tracker.take("a", "preview", delivered)).toBeUndefined();
    }
  });
  it("accepts only complete text blocks and matches the renderer's newline-joined preview", async () => {
    const f = fixture(), delivered = [{ type: "text", text: "one" }, { type: "text", text: "" }, { type: "text", text: "two" }];
    await f.tracker.pre(f.input("a")); await f.tracker.post({ ...f.input("a"), tool_response: f.response() });
    expect(f.tracker.take("a", "one\ntwo", delivered)).toBeDefined();
  });
  it("separates query scopes", async () => {
    const f = fixture(), other = createSummaryReadTracker({ root: f.root, isActive: () => true });
    await other.pre(f.input("a")); await other.post({ ...f.input("a"), tool_response: f.response() });
    expect(other.take("a", "preview", "preview")?.scope).not.toBe((await f.read("a"))?.scope);
  });
});


