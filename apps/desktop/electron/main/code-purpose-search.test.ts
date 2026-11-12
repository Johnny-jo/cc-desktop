import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lookupCodeSymbol, type CodeSymbolRequest } from "./code-symbol-index";

const roots: string[] = [];
function project(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "code-purpose-search-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
}
function discover(root: string, request: CodeSymbolRequest) {
  const result = lookupCodeSymbol(root, request);
  expect(result.status).toBe("candidates");
  if (result.status !== "candidates") throw Error("missing purpose candidates");
  return result;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("purpose discovery", () => {
  it("prefers a focused implementation covering both explicit hints over a getter and a huge wrapper", () => {
    const root = project({
      "getter.ts": "export function summaryModel(settings: any) { return settings.summaryModel || settings.model; }",
      "wrapper.ts": [
        "export async function registerHandlers(summaryModel: string, abort: AbortSignal) {",
        ...Array.from({ length: 600 }, (_, index) => `  const model${index} = 'summary request message config';`),
        "  return { summaryModel, abort };",
        "}",
      ].join("\n"),
      "implementation.ts": [
        "export async function reconcileHistory(summaryModel: string, abort: AbortSignal) {",
        "  const result = await compressHistory(summaryModel, abort);",
        "  if (abort.aborted || result.model !== summaryModel) return { cancelled: true };",
        "  return commitHistory(result);",
        "}",
      ].join("\n"),
    });
    const result = discover(root, { purpose: "压缩历史并等待摘要返回，在取消请求后拒绝过期摘要，提交前核对模型。", hints: ["summaryModel", "abort"] });
    expect(result.candidates[0]).toMatchObject({ name: "reconcileHistory", file: "implementation.ts" });
    expect(result.terms).toEqual(expect.arrayContaining(["compress", "await", "commit", "stale"]));
  });

  it("recalls the real history compression guard from a Chinese behavioral query without a function-name hint", () => {
    const result = discover(path.resolve("../.."), {
      purpose: "查找压缩会话历史并等待摘要返回的实现：在主模型或摘要模型变化时拒绝过期摘要，并在取消请求后返回取消状态。解释提交前的具体守卫。",
      hints: ["summaryModel", "abort"], scope: "apps/desktop/electron/main",
    });
    expect(result.candidates.map(candidate => candidate.name)).toContain("compressSession");
  }, 20_000);

  it("does not echo an unbounded Chinese sentence as one search term", () => {
    const root = project({ "source.ts": "export function compress() { return 1; }" });
    const result = lookupCodeSymbol(root, { purpose: "查找压缩" + "非常长的行为描述".repeat(180) });
    if (result.status !== "candidates" && result.status !== "no_match") throw Error("missing purpose result");
    expect(result.terms.every(term => term.length <= 120)).toBe(true);
    expect(result.terms).toContain("compress");
  });

  it("uses bounded Chinese technical expansions to find English implementation identifiers", () => {
    const root = project({ "src/model.ts": [
      "export function changeSummaryModel(summaryModel: string) {",
      "  abortCurrentRequest();",
      "  resumePendingSend(summaryModel);",
      "}",
    ].join("\n") });
    const result = discover(root, { purpose: "跟踪切换摘要模型时的取消和续发" });
    expect(result.candidates[0]).toMatchObject({ name: "changeSummaryModel", file: "src/model.ts", startLine: 1, endLine: 4, startColumn: 1 });
    expect(result.terms).toEqual(expect.arrayContaining(["summary", "model", "abort", "resume"]));
    expect(result.coverage.partial).toBe(false);
    expect(result.hint).toMatch(/lexical|词法/i);
  });

  it("ranks source implementation above tests that only mention the search text", () => {
    const root = project({
      "src/queue.ts": "export function resumeQueuedSend(queue: string[]) { return queue.shift(); }",
      "tests/queue.test.ts": "function mention() { return 'resumeQueuedSend'; }",
    });
    const result = discover(root, { purpose: "locate resumeQueuedSend" });
    expect(result.candidates.map(candidate => candidate.name)).toEqual(["resumeQueuedSend", "mention"]);
    expect(result.candidates[1].reasons.join(" ")).toMatch(/string/i);
  });

  it("keeps same-named physical implementations distinct and returns at most three", () => {
    const root = project(Object.fromEntries(["a", "b", "c", "d"].map(name => [name + ".ts", "export function processQueue() { return 1; }"])));
    const result = discover(root, { purpose: "processQueue" });
    expect(result.totalCandidates).toBe(4);
    expect(result.candidates.map(candidate => candidate.file)).toEqual(["a.ts", "b.ts", "c.ts"]);
    const selected = result.candidates[0];
    expect(lookupCodeSymbol(root, { name: selected.name, file: selected.file, line: selected.startLine, column: selected.startColumn })).toMatchObject({ status: "found" });
  });

  it("returns no_match with no fabricated candidate when there is no lexical evidence", () => {
    const root = project({ "math.ts": "export function sum(a: number, b: number) { return a + b; }" });
    expect(lookupCodeSymbol(root, { purpose: "quantumInvoiceReconciliation" })).toMatchObject({
      status: "no_match", candidates: [], totalCandidates: 0, coverage: { partial: false }, hint: expect.any(String),
    });
    expect(lookupCodeSymbol(root, { purpose: "find the function that does it" })).toMatchObject({ status: "no_match", candidates: [] });
  });

  it("uses exact error strings as evidence and reports comment-only/test-only matches as weak", () => {
    const root = project({
      "src/request.ts": "export function requireActive() { throw new Error('No pending send to resume'); }",
      "tests/request.test.ts": "// quantum reconciliation\nfunction scenario() { return true; }",
    });
    expect(discover(root, { purpose: "locate failure", hints: ["No pending send to resume"] }).candidates[0]).toMatchObject({
      name: "requireActive", reasons: expect.arrayContaining([expect.stringMatching(/string.*No pending send to resume/i)]),
    });
    const weak = discover(root, { purpose: "quantum reconciliation" });
    expect(weak.candidates[0]).toMatchObject({ name: "scenario", file: "tests/request.test.ts" });
    expect(weak.candidates[0].reasons.join(" ")).toMatch(/comment/i);
    expect(weak.hint).toMatch(/weak/i);
  });

  it("resolves renamed exports/imports and local aliases to the physical implementation", () => {
    const root = project({
      "src/worker.ts": "export const work = (queue: string[]) => queue.shift();",
      "src/index.ts": "export { work as resumeQueuedSend } from './worker';",
      "app.ts": "import { resumeQueuedSend as dispatch } from './src/index';\nconst alias = dispatch;\nexport function userAction() { alias([]); }",
    });
    const result = discover(root, { purpose: "resumeQueuedSend" });
    expect(result.candidates[0]).toMatchObject({ name: "work", file: "src/worker.ts" });
    expect(result.candidates[0].reasons.join(" ")).toMatch(/resolved.*resumeQueuedSend/i);
    expect(discover(root, { purpose: "alias" }).candidates[0]).toMatchObject({ name: "work", file: "src/worker.ts" });
  });

  it("associates only resolved direct calls and does not connect unrelated same-name methods", () => {
    const root = project({ "src/model.ts": [
      "class Left { run() { return 1; } }",
      "class Right { run() { return 2; } }",
      "export function switchSummaryModel() { return new Left().run(); }",
    ].join("\n") });
    const result = discover(root, { purpose: "switchSummaryModel" });
    expect(result.candidates.map(candidate => [candidate.name, candidate.startLine])).toEqual([["switchSummaryModel", 3], ["run", 1]]);
    expect(result.candidates[1].reasons.join(" ")).toMatch(/resolved direct call/i);
  });

  it("does not treat a union receiver's synthetic call signature as one physical relationship", () => {
    const root = project({ "model.ts": [
      "class Left { run() { return 1; } }",
      "class Right { run() { return 2; } }",
      "export function switchModel(receiver: Left | Right) { return receiver.run(); }",
    ].join("\n") });
    const result = discover(root, { purpose: "switchModel" });
    expect(result.candidates.map(candidate => candidate.name)).toEqual(["switchModel"]);
    expect(result.totalCandidates).toBe(1);
  });

  it("preserves ambiguity through local aliases instead of choosing a union signature declaration", () => {
    const root = project({ "model.ts": [
      "class Left { run() { return 1; } }",
      "class Right { run() { return 2; } }",
      "declare const receiver: Left | Right;",
      "const selected = receiver.run;",
      "const alias = selected;",
      "export function switchModel() { return alias(); }",
    ].join("\n") });
    const result = discover(root, { purpose: "switchModel" });
    expect(result.candidates.map(candidate => candidate.name)).toEqual(["switchModel"]);
    expect(result.totalCandidates).toBe(1);
  });

  it("attributes nested evidence to its nearest implementation rather than a huge wrapper", () => {
    const root = project({ "service.ts": [
      "export function createService() {",
      "  const resumeQueuedSend = () => {",
      "    throw new Error('resume pending send');",
      "  };",
      "  const cancelQueuedSend = () => 'cancel pending send';",
      "  return { resumeQueuedSend, cancelQueuedSend };",
      "}",
    ].join("\n") });
    const result = discover(root, { purpose: "resume pending send", hints: ["resumeQueuedSend"] });
    expect(result.candidates[0].name).toBe("resumeQueuedSend");
    expect(result.totalCandidates).toBeLessThanOrEqual(3);
    expect(result.candidates.filter(candidate => candidate.name === "resumeQueuedSend")).toHaveLength(1);
  });

  it("reuses method, assignment, property-arrow and named-expression recognition without duplicates", () => {
    const root = project({ "source.js": [
      "const task = function inner() { return 'needle'; };",
      "const object = { arrow: () => 'needle', method() { return 'needle'; } };",
      "exports.assigned = () => 'needle';",
    ].join("\n") });
    const result = discover(root, { purpose: "needle" });
    expect(result.totalCandidates).toBe(4);
    expect(result.candidates.every(candidate => candidate.name !== "inner")).toBe(true);
  });

  it("returns one continuous bounded excerpt around a matched branch with exact line positions", () => {
    const lines = ["export function process() {", ...Array.from({ length: 60 }, (_, index) => `  const value${index} = ${index};`), "  throw new Error('RESUME_FAILED');", "}"];
    const root = project({ "process.ts": lines.join("\n") });
    const result = discover(root, { purpose: "RESUME_FAILED" });
    const { excerpt } = result.candidates[0];
    expect(excerpt.endLine - excerpt.startLine).toBeLessThan(20);
    expect(excerpt.text).toBe(lines.slice(excerpt.startLine - 1, excerpt.endLine).join("\n"));
    expect(excerpt.text).toContain("throw new Error('RESUME_FAILED');");
    expect(excerpt).not.toHaveProperty("startColumn");
    expect(result.candidates[0]).toMatchObject({ startLine: 1, endLine: 63 });
  });

  it("chooses a branch with multiple independent clues over an early parameter mention", () => {
    const lines = [
      "export function process(summaryModel: string) {",
      "  const original = summaryModel;",
      ...Array.from({ length: 60 }, (_, index) => `  const value${index} = ${index};`),
      "  if (pendingSend && original !== summaryModel) {",
      "    abortCurrentRequest();",
      "    resumePendingSend(summaryModel);",
      "  }",
      "}",
    ];
    const root = project({ "process.ts": lines.join("\n") });
    const { excerpt } = discover(root, { purpose: "summaryModel pendingSend abortCurrentRequest resumePendingSend" }).candidates[0];
    expect(excerpt.text).toContain("if (pendingSend");
    expect(excerpt.text).toContain("abortCurrentRequest();");
    expect(excerpt.text).toBe(lines.slice(excerpt.startLine - 1, excerpt.endLine).join("\n"));
  });

  it("centers pathological single-line excerpts on evidence and reports precise slice columns", () => {
    const source = "export function process() { /*" + "x".repeat(5000) + "*/ throw new Error('RESUME_FAILED'); }";
    const root = project({ "process.ts": source });
    const { excerpt } = discover(root, { purpose: "RESUME_FAILED" }).candidates[0];
    expect(excerpt.text).toContain("RESUME_FAILED");
    expect(excerpt.text.length).toBeLessThanOrEqual(2400);
    expect(excerpt.startLine).toBe(1);
    expect(excerpt.endLine).toBe(1);
    expect(excerpt.startColumn).toBeGreaterThan(1);
    expect(excerpt.text).toBe(source.slice(excerpt.startColumn! - 1, excerpt.endColumn! - 1));
  });

  it("limits candidates and relation traversal to the requested project-relative directory", () => {
    const root = project({
      "src/queue/run.ts": "export function resumeQueue() { return 1; }",
      "src/queue-extra/run.ts": "export function resumeQueue() { return 2; }",
      "outside.ts": "export function resumeQueue() { return 3; }",
    });
    const result = discover(root, { purpose: "resumeQueue", scope: "src/queue" });
    expect(result.totalCandidates).toBe(1);
    expect(result.candidates[0].file).toBe("src/queue/run.ts");
    expect(lookupCodeSymbol(root, { purpose: "resumeQueue", scope: "absent" })).toMatchObject({ status: "no_match" });
    expect(() => lookupCodeSymbol(root, { purpose: "resumeQueue", scope: "../" })).toThrow(/scope/i);
  });

  it("preserves partial coverage for both candidates and no_match", () => {
    const root = project({
      "large.ts": "//" + "x".repeat(2 * 1024 * 1024),
      "small.ts": "export function resumeQueue() {}",
    });
    expect(discover(root, { purpose: "resumeQueue" }).coverage).toMatchObject({ partial: true, reasons: [expect.any(String)] });
    expect(lookupCodeSymbol(root, { purpose: "nonexistentQuantumObject" })).toMatchObject({
      status: "no_match", coverage: { partial: true }, hint: expect.stringMatching(/partial/i),
    });
  });
});
