import { createHash } from "node:crypto";
import type { ChatItem } from "@claude-desktop/shared";
import { describe, expect, it } from "vitest";
import { compressContext } from "./context-compressor";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const body = "READ_BODY_SENTINEL " + "unchanged source ".repeat(24);
function read(id: string): ChatItem {
  return { kind: "tool", id, tool: { id, name: "Read", summary: "source.ts", status: "done", resultPreview: body,
    summaryRead: { format: 1, scope: "query-epoch", inputHash: hash("args"), targetVersion: hash("version"),
      resultHash: hash("full output, including its tail"), previewHash: hash(body) } } };
}
const user = (id: string, text = id): ChatItem => ({ kind: "text", id, role: "user", text });
const passed: ChatItem = { kind: "tool", id: "verify", tool: { id: "verify", name: "Bash", summary: "run tests", status: "done", resultPreview: "ALL TESTS PASSED" } };
const recent = [user("recent-1"), read("recent-read-1"), user("recent-2"), read("recent-read-2"), user("recent-3"), read("recent-read-3")];

describe("summary-only duplicate read projection", () => {
  it("reduces only old summary input, keeps recent turns and the original records, and reports actual text input", async () => {
    const items = [user("old"), read("read-1"), read("read-2"), read("read-3"), passed, ...recent];
    const original = JSON.stringify(items);
    const inputs: string[] = [];
    const result = await compressContext(items, { summarize: async text => { inputs.push(text); return "The checks passed."; } }, { deduplicateTools: true });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].split(body)).toHaveLength(2);
    expect(inputs[0]).toContain("call read-2");
    expect(inputs[0]).toContain("call read-3");
    expect(inputs[0]).toContain("ALL TESTS PASSED");
    expect(inputs[0]).not.toContain("recent-read");
    expect(result.items.slice(1)).toEqual(recent);
    expect(result.compressedCount).toBe(5);
    expect(JSON.stringify(items)).toBe(original);
    expect(result.summaryStats).toMatchObject({ calls: 1, deduplicatedToolResults: 2,
      inputTextBytes: Buffer.byteLength(inputs[0]), savedPreviewBytes: expect.any(Number) });
    expect(result.summaryStats!.savedPreviewBytes).toBeGreaterThan(0);
  });

  it.each([undefined, false])("preserves every preview when optimization is %s", async enabled => {
    const inputs: string[] = [];
    const result = await compressContext([user("old"), read("a"), read("b"), read("c"), passed, ...recent],
      { summarize: async text => { inputs.push(text); return "summary"; } }, { deduplicateTools: enabled });
    expect(inputs.join("\n").split(body)).toHaveLength(4);
    expect(result.summaryStats).toBeUndefined();
  });

  it("keeps the latest terminal read even if that validation is older than the retained discussion", async () => {
    const inputs: string[] = [];
    const result = await compressContext([user("old"), read("a"), read("b"), read("latest-validation"), user("new-1"), user("new-2"), user("new-3")],
      { summarize: async text => { inputs.push(text); return "summary"; } }, { deduplicateTools: true });
    expect(inputs[0].split(body)).toHaveLength(3);
    expect(inputs[0]).toContain("call latest-validation");
    expect(result.summaryStats?.deduplicatedToolResults).toBe(1);
  });

  it("never references an anchor that only appeared in an earlier summary batch", async () => {
    const inputs: string[] = [];
    const items = [user("first", "a".repeat(1100)), read("a"), user("second", "b".repeat(1100)), read("b"), passed,
      user("later"), read("newer")];
    const result = await compressContext(items, { summarize: async text => { inputs.push(text); return "brief summary"; } },
      { deduplicateTools: true, contextLimit: 4000, recentBudget: 0 });
    expect(inputs.length).toBeGreaterThan(1);
    const first = inputs.find(text => text.includes("call a"));
    const second = inputs.find(text => text.includes("call b"));
    expect(first).toContain(body);
    expect(second).toContain(body);
    expect(first).not.toBe(second);
    expect(result.summaryStats?.deduplicatedToolResults).toBe(0);
    expect(result.summaryStats?.calls).toBe(inputs.length);
  });

  it("keeps oversized split units as raw text so a reference cannot outlive a sliced anchor", async () => {
    const inputs: string[] = [];
    const items = [user("large", "界".repeat(3000)), read("a"), read("b"), passed, user("later"), read("newer")];
    const original = JSON.stringify(items);
    const result = await compressContext(items, { summarize: async text => { inputs.push(text); return "summary"; } },
      { deduplicateTools: true, contextLimit: 4000, recentBudget: 0 });
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.join("")).not.toContain("Same complete read");
    expect(inputs.join("")).not.toContain("�");
    expect(result.summaryStats?.deduplicatedToolResults).toBe(0);
    expect(JSON.stringify(items)).toBe(original);
  });

  it.each(["q0", "long-first-call-" + "x".repeat(180)])("does not reject duplicate-heavy input before reduced batches fit, including long anchor IDs", async firstId => {
    const inputs: string[] = [];
    const items = Array.from({ length: 46 }, (_, index) => {
      const item = read(index === 0 ? firstId : "q" + index);
      if (item.kind !== "tool") throw Error("missing read");
      item.tool.resultPreview = body.slice(0, 200);
      item.tool.summaryRead!.previewHash = hash(item.tool.resultPreview);
      return [user("u" + index, "check"), item];
    }).flat();
    const result = await compressContext(items, { summarize: async text => { inputs.push(text); return "summary"; } },
      { deduplicateTools: true, contextLimit: 2300, recentBudget: 0 });
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.length).toBeLessThanOrEqual(12);
    expect(result.summaryStats?.deduplicatedToolResults).toBeGreaterThan(0);
    for (const input of inputs) for (const reference of input.matchAll(/Same complete read as call ([^;]+);/g)) {
      expect(input).toContain(`(call ${reference[1]})`);
      expect(input).toContain(body.slice(0, 200));
    }
  });

  it("rejects oversized distinct reads before spending when no duplicate result can be shortened", async () => {
    const inputs: string[] = [];
    const items = Array.from({ length: 46 }, (_, index) => {
      const item = read("q" + index);
      if (item.kind !== "tool") throw Error("missing read");
      item.tool.resultPreview = body.slice(0, 200);
      item.tool.summaryRead!.previewHash = hash(item.tool.resultPreview);
      item.tool.summaryRead!.inputHash = hash("different args " + index);
      return [user("u" + index, "check"), item];
    }).flat();
    await expect(compressContext(items, { summarize: async text => { inputs.push(text); return "summary"; } },
      { deduplicateTools: true, contextLimit: 2300, recentBudget: 0 })).rejects.toThrow("Summary request limit exceeded");
    expect(inputs).toHaveLength(0);
  });
});
