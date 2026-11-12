import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatItem, SummaryReadProof, ToolCardState } from "@claude-desktop/shared";
import { transcriptToText } from "./context-compressor";
import { createSummaryDedupeState, projectSummaryTools, protectedSummaryToolCalls, summaryDuplicatePreviewBytes } from "./summary-tool-dedup";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const BODY = "source file: 你好\n".repeat(80);
const proof = (preview = BODY): SummaryReadProof => ({
  format: 1, scope: "query-1:epoch-0", inputHash: hash("Read src/main.ts"),
  targetVersion: "file-v1", resultHash: hash(`complete:${preview}`), previewHash: hash(preview),
});
const read = (id: string, patch: Partial<ToolCardState> = {}): ChatItem => ({
  kind: "tool", id: `item-${id}`, tool: {
    id, name: "Read", summary: "src/main.ts", status: "done", resultPreview: BODY, summaryRead: proof(), ...patch,
  },
});
const bash = (): ChatItem => read("verify", { name: "Bash", summary: "npm test", resultPreview: "All tests passed", summaryRead: undefined });
const preview = (item: ChatItem): string | undefined => item.kind === "tool" ? item.tool.resultPreview : undefined;
const project = (items: ChatItem[]) => projectSummaryTools(items, createSummaryDedupeState(), protectedSummaryToolCalls(items));

describe("summary tool projection", () => {
  it.each([undefined, 123, { oldId: "legacy" }])("preserves legacy cards with a non-string call id (%j)", id => {
    const legacy = read("legacy", { id: id as unknown as string, summaryRead: undefined });
    const items = [read("first"), legacy, read("after"), bash()];
    const snapshot = structuredClone(items);
    expect(protectedSummaryToolCalls([legacy])).toEqual(new Set());
    const projected = projectSummaryTools(items, createSummaryDedupeState(), new Set());
    expect(projected.deduplicatedCalls).toBe(0);
    expect(projected.items).toEqual(items);
    expect(summaryDuplicatePreviewBytes(items, new Set())).toBe(0);
    expect(items).toEqual(snapshot);
  });

  it("has no potentially removable preview bytes for 46 distinct read inputs", () => {
    const items = Array.from({ length: 46 }, (_, i) => read(`call-${i}`, { summaryRead: { ...proof(), inputHash: hash(`Read file-${i}.ts`) } }));
    expect(summaryDuplicatePreviewBytes(items, protectedSummaryToolCalls(items))).toBe(0);
    expect(summaryDuplicatePreviewBytes(items, new Set())).toBe(0);
  });

  it("counts potential duplicates even when a long anchor id makes the global marker too large", () => {
    const first = read("long-id".repeat(1_000));
    const items = [first, read("short-id"), read("latest")];
    const protectedCalls = protectedSummaryToolCalls(items);
    expect(projectSummaryTools(items, createSummaryDedupeState(), protectedCalls).deduplicatedCalls).toBe(0);
    expect(summaryDuplicatePreviewBytes(items, protectedCalls)).toBe(Buffer.byteLength(BODY));
  });

  it.each<ChatItem>([
    read("legacy", { summaryRead: undefined }),
    read("error", { status: "error" }),
    read("unknown", { name: "Bash" }),
    { kind: "changes", id: "changes", files: [] },
    { kind: "text", id: "boundary", role: "system", text: "boundary" },
  ])("does not count a potentially duplicate preview across a $kind barrier", boundary => {
    const items = [read("first"), boundary, read("after")];
    expect(summaryDuplicatePreviewBytes(items, new Set())).toBe(0);
  });

  it("counts duplicate UTF-8 preview bytes across protected reads without changing inputs", () => {
    const unicode = "你好🌍".repeat(40);
    const other = read("other", { summaryRead: { ...proof(), inputHash: hash("Read other.ts") } });
    const items = [read("first", { resultPreview: unicode, summaryRead: proof(unicode) }), other,
      read("middle", { resultPreview: unicode, summaryRead: proof(unicode) }),
      read("latest", { resultPreview: unicode, summaryRead: proof(unicode) })];
    const snapshot = structuredClone(items);
    const protectedCalls = protectedSummaryToolCalls(items);
    const protectedSnapshot = new Set(protectedCalls);
    expect(summaryDuplicatePreviewBytes(items, protectedCalls)).toBe(Buffer.byteLength(unicode));
    expect(summaryDuplicatePreviewBytes([], new Set())).toBe(0);
    expect(items).toEqual(snapshot);
    expect(protectedCalls).toEqual(protectedSnapshot);
  });

  it("keeps the first and latest read plus later verification while marking middle call positions", () => {
    const items = [read("first"), read("second"), read("third"), bash()];
    const result = project(items);
    expect(result.deduplicatedCalls).toBe(1);
    expect(preview(result.items[0])).toBe(BODY);
    expect(preview(result.items[1])).toContain("call first");
    expect(preview(result.items[2])).toBe(BODY);
    expect(result.items[3]).toBe(items[3]);
    const text = transcriptToText(result.items);
    expect(text).toContain("(call second)");
    expect(text).toContain("(call third)");
    expect(text).toContain("All tests passed");
    expect(text).not.toContain("previewHash");
    expect(text).not.toContain(proof().resultHash);
    expect(result.savedBytes).toBe(Buffer.byteLength(BODY) - Buffer.byteLength(preview(result.items[1])!));
  });

  it("does not infer complete equality from identical previews", () => {
    const result = projectSummaryTools([read("first"), read("other-tail", { summaryRead: { ...proof(), resultHash: hash("different tail") } }), bash()], createSummaryDedupeState(), new Set());
    expect(result.deduplicatedCalls).toBe(0);
    expect(preview(result.items[1])).toBe(BODY);
  });

  it.each([
    ["inputHash", hash("different arguments")], ["targetVersion", "file-v2"], ["scope", "query-2:epoch-0"],
  ] as const)("keeps different %s evidence", (key, value) => {
    const items = [read("first"), read("second", { summaryRead: { ...proof(), [key]: value } }), bash()];
    expect(projectSummaryTools(items, createSummaryDedupeState(), new Set()).deduplicatedCalls).toBe(0);
  });

  it.each([
    undefined, { ...proof(), format: 2 }, { ...proof(), scope: "" }, { ...proof(), targetVersion: "" },
    { ...proof(), inputHash: "not-sha256" }, { ...proof(), resultHash: "f" },
    { ...proof(), previewHash: hash("old preview") },
  ])("preserves reads without valid complete proof (%j)", candidate => {
    const invalid = read("unproven", { summaryRead: candidate as SummaryReadProof });
    const result = project([read("first"), invalid, read("after"), bash()]);
    expect(result.deduplicatedCalls).toBe(0);
    expect(preview(result.items[1])).toBe(BODY);
    expect(preview(result.items[2])).toBe(BODY);
  });

  it.each([
    { status: "error" as const }, { status: "running" as const }, { status: "stopped" as const },
    { isSubagent: true }, { parentToolUseId: "parent" }, { todos: [] },
    { task: { operation: "list" as const } }, { agent: { id: "agent", title: "Worker", status: "completed" as const } },
    { name: "mcp__read" }, { name: "Edit" },
  ])("preserves unsupported tools and the first successful read afterwards (%j)", patch => {
    const items = [read("first"), read("boundary", patch), read("after"), read("repeat"), read("latest"), bash()];
    const result = project(items);
    expect(result.deduplicatedCalls).toBe(1);
    expect(preview(result.items[1])).toBe(BODY);
    expect(preview(result.items[2])).toBe(BODY);
    expect(preview(result.items[3])).toContain("call after");
    expect(preview(result.items[4])).toBe(BODY);
  });

  it.each<ChatItem>([
    { kind: "changes", id: "changes", files: [] },
    { kind: "text", id: "system", role: "system", text: "Compaction boundary" },
  ])("keeps reads on either side of a $kind boundary", boundary => {
    expect(project([read("first"), boundary, read("second"), bash()]).deduplicatedCalls).toBe(0);
  });

  it("protects the newest terminal read even when there are later running tools", () => {
    const items = [read("first"), read("latest"), read("running", { status: "running" })];
    expect(protectedSummaryToolCalls(items)).toEqual(new Set(["latest"]));
    expect(project(items).deduplicatedCalls).toBe(0);
  });

  it("keeps the latest complete observation for each read input even after other tools", () => {
    const otherProof = { ...proof(), inputHash: hash("Read src/other.ts") };
    const items = [read("a-first"), read("a-middle"), read("a-latest"), read("b-latest", { summaryRead: otherProof }), bash()];
    const result = project(items);
    expect(protectedSummaryToolCalls(items)).toEqual(new Set(["a-latest", "b-latest", "verify"]));
    expect(preview(result.items[0])).toBe(BODY);
    expect(preview(result.items[1])).toContain("call a-first");
    expect(preview(result.items[2])).toBe(BODY);
    expect(preview(result.items[3])).toBe(BODY);
    expect(result.deduplicatedCalls).toBe(1);
  });

  it("keeps unrelated read anchors across protected complete observations", () => {
    const b = read("b-latest", { summaryRead: { ...proof(), inputHash: hash("Read b.ts") } });
    const c = read("c-latest", { summaryRead: { ...proof(), inputHash: hash("Read c.ts") } });
    const items = [read("a-first"), b, read("a-middle"), c, read("a-latest")];
    const result = project(items);
    expect(result.deduplicatedCalls).toBe(1);
    expect(preview(result.items[2])).toContain("call a-first");
    for (const index of [0, 1, 3, 4]) expect(result.items[index]).toBe(items[index]);
  });

  it.each(["done", "error", "stopped"] as const)("protects the last %s tool across full history", status => {
    const oldItems = [read("first"), read("second")];
    const fullHistory = [...oldItems, read("recent", { status }), read("running", { status: "running" })];
    const protectedCalls = protectedSummaryToolCalls(fullHistory);
    expect(protectedCalls).toEqual(new Set(status === "done" ? ["recent"] : ["recent", "second"]));
    expect(projectSummaryTools(oldItems, createSummaryDedupeState(), protectedCalls).deduplicatedCalls).toBe(status === "done" ? 1 : 0);
  });

  it("does not reuse an old observation when a later scope changes back", () => {
    const items = [read("first"), read("other-scope", { summaryRead: { ...proof(), scope: "query-2:epoch-0" } }), read("returned"), bash()];
    expect(project(items).deduplicatedCalls).toBe(0);
  });

  it("does not seed an ambiguous anchor found elsewhere in full history", () => {
    const oldItems = [read("ambiguous"), read("later")];
    const protectedCalls = protectedSummaryToolCalls([...oldItems, read("ambiguous"), bash()]);
    expect(projectSummaryTools(oldItems, createSummaryDedupeState(), protectedCalls).deduplicatedCalls).toBe(0);
  });

  it("does not reuse a call id encountered in a previous unit", () => {
    const seeded = projectSummaryTools([read("same")], createSummaryDedupeState(), new Set());
    const repeated = projectSummaryTools([read("same"), read("after")], seeded.state, new Set());
    expect(repeated.deduplicatedCalls).toBe(0);
  });

  it("protects all repeated or missing call ids", () => {
    const items = [read("same"), read("other"), read("same"), read(""), bash()];
    expect(protectedSummaryToolCalls(items)).toEqual(new Set(["same", "", "verify"]));
    const result = project(items);
    expect(preview(result.items[0])).toBe(BODY);
    expect(preview(result.items[2])).toBe(BODY);
    expect(preview(result.items[3])).toBe(BODY);
    expect(result.deduplicatedCalls).toBe(0);
  });

  it("copies state and only clones changed cards without mutating history", () => {
    const first = read("first");
    const state = createSummaryDedupeState();
    const seeded = projectSummaryTools([first], state, new Set());
    const input = Object.freeze([Object.freeze(read("second"))]);
    if (input[0].kind === "tool") Object.freeze(input[0].tool);
    const snapshot = structuredClone(seeded.state);
    const result = projectSummaryTools(input, seeded.state, new Set());
    expect(seeded.state).toEqual(snapshot);
    expect(result.state).not.toBe(seeded.state);
    expect(projectSummaryTools([read("unrelated")], state, new Set()).deduplicatedCalls).toBe(0);
    expect(result.items[0]).not.toBe(input[0]);
    expect(preview(input[0])).toBe(BODY);
    expect(seeded.items[0]).toBe(first);
  });

  it("never refers to an anchor in a fresh summary batch", () => {
    const seeded = projectSummaryTools([read("first")], createSummaryDedupeState(), new Set());
    expect(projectSummaryTools([read("same-batch")], seeded.state, new Set()).deduplicatedCalls).toBe(1);
    expect(projectSummaryTools([read("next-batch")], createSummaryDedupeState(), new Set()).deduplicatedCalls).toBe(0);
  });

  it("keeps short results instead of growing the summary budget", () => {
    const body = "ok";
    const items = [read("first", { resultPreview: body, summaryRead: proof(body) }), read("second", { resultPreview: body, summaryRead: proof(body) }), bash()];
    const result = project(items);
    expect(result.items).toEqual(items);
    expect(result.savedBytes).toBe(0);
    expect(result.deduplicatedCalls).toBe(0);
  });
});
