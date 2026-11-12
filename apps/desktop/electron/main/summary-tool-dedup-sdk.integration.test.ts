import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { getSessionMessages, query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatItem } from "@claude-desktop/shared";
import { expect, it, vi } from "vitest";
import { AppDatabase } from "./app-database";
import { buildContinuationPrompt, createContextCompressor, splitItemsForCompression, transcriptToText } from "./context-compressor";
import { DiffTracker } from "./diff-tracker";
import type { ModelRuntime } from "./model-runtime";
import { PermissionBroker } from "./permission-broker";
import { SessionArchive } from "./session-archive";
import { SessionManager } from "./session-manager";
import { SettingsStore } from "./settings-store";

const factsFrom = (text: string): string[] => [...new Set(text.match(/FACT_(?:FAIL|FIX|FINAL)=[A-Z0-9_]+/g) ?? [])].sort();
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

// Real bundled CLI, real hooks/reducer/archive and real summary HTTP. The local
// provider is deterministic: it extracts facts from actual input, and requests a
// real Read when a continuation lacks one. This measures evidence preservation,
// request bytes/calls and extra reads, not a paid LLM's accuracy or billed tokens.
it.runIf(process.env.CC_TEST_BUNDLED_SDK === "1")("benchmarks proven Read projection without changing SDK history, archive or recent turns", async () => {
  const executable = path.resolve("../../vendor/win-x64/claude/claude.exe");
  expect(fs.existsSync(executable)).toBe(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-summary-dedup-wire-"));
  const source = path.join(dir, "source.txt");
  const evidence = path.join(dir, "evidence.txt");
  const missing = path.join(dir, "missing.txt");
  const expectedFacts = ["FACT_FAIL=MISSING_CONFIG", "FACT_FIX=ADDED_CONFIG", "FACT_FINAL=PASS"].sort();
  const before = "FACT_FAIL=MISSING_CONFIG\n" + "unchanged source material\n".repeat(100);
  const after = "FACT_FIX=ADDED_CONFIG\nFACT_FINAL=PASS\n" + "unchanged source material\n".repeat(100);
  fs.writeFileSync(source, before);
  fs.writeFileSync(evidence, expectedFacts.join("\n"));
  const model = "claude-sonnet-4-6";
  const summaryModel = "fixture/summary";
  const steps = [
    ...Array.from({ length: 8 }, () => ({ name: "Read", input: { file_path: source } })),
    { name: "Read", input: { file_path: missing } },
    { name: "Write", input: { file_path: source, content: after } },
    { name: "Read", input: { file_path: source } },
    { name: "Read", input: { file_path: source } },
  ];
  let step = 0;
  let phase = "recording";
  const wire: Array<{ phase: string; raw: string; model: string; messages: string }> = [];
  const additionalReads: Record<string, number> = {};
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url?.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":100}');
      return;
    }
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
    const raw = Buffer.concat(chunks).toString();
    const body = JSON.parse(raw);
    const messages = JSON.stringify(body.messages);
    wire.push({ phase, raw, model: body.model, messages });
    let tool: { name: string; input: Record<string, unknown> } | undefined;
    let text: string;
    if (body.model === summaryModel) {
      // Includes the previous summary in subsequent batches; no oracle answers.
      text = JSON.stringify({ facts: factsFrom(messages) });
    } else if (phase.includes("continuation")) {
      const facts = factsFrom(messages);
      if (facts.length < expectedFacts.length && !messages.includes("toolu_evidence_")) {
        tool = { name: "Read", input: { file_path: evidence } };
        additionalReads[phase] = (additionalReads[phase] ?? 0) + 1;
      }
      text = JSON.stringify({ facts });
    } else {
      tool = steps[step++];
      text = "Recorded fixture turn.";
    }
    const id = tool ? (phase.includes("continuation") ? "toolu_evidence_" + randomUUID() : "toolu_record_" + step) : undefined;
    const message = { id: "msg_" + randomUUID(), model: body.model, role: "assistant", type: "message",
      content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 5 } };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, data: object) => res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n");
    event("message_start", { message: { ...message, content: [], stop_reason: null } });
    event("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id, name: tool.name, input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    event("message_stop", {});
    res.end();
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const target = { origin: "http://127.0.0.1:" + address.port, token: "fixture-only" };
  const db = AppDatabase.open(dir)!;
  const archive = new SessionArchive(dir, db);
  const settings = new SettingsStore({ userDataDir: dir, encrypt: s => s, decrypt: s => s });
  settings.update({ models: [model, summaryModel], defaultModel: model, tokenSavings: { mode: "balanced", summaryModel } });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|comspec|pathext|temp|tmp|programfiles|localappdata)$/i.test(key))) as Record<string, string>;
  const processEnv = { ...env, CLAUDE_CONFIG_DIR: path.join(dir, "cli"), USERPROFILE: dir, HOME: dir,
    ANTHROPIC_BASE_URL: target.origin, ANTHROPIC_AUTH_TOKEN: target.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false" };
  const ready = { state: "ready" as const, port: address.port, managedByApp: true };
  const cpa: ModelRuntime = {
    ensureReady: async () => ready, getStatus: () => ready, getProxyTarget: () => target,
    getModelCatalog: () => [{ id: model }, { id: summaryModel }], listModelCatalog: async () => [{ id: model }, { id: summaryModel }],
    getModelQuota: async () => null, buildProcessEnv: () => processEnv,
    mergeSdkModelCapabilities() {}, stopIfManaged() {},
  };
  const compressor = createContextCompressor(() => settings.get(), () => target);
  const open = () => new SessionManager({ archive, cpa, settings, compressor,
    readSdkMessages: (session, cwd) => getSessionMessages(session, { dir: cwd, includeSystemMessages: true }),
    diffTracker: new DiffTracker(), permissionBroker: new PermissionBroker({ getMode: () => "auto", requestFromUi() { throw new Error("Unexpected permission"); } }),
    claudeExecutablePath: executable, emit() {}, emitSession() {}, emitDiff() {},
    queryFn: ({ prompt, options }) => query({ prompt: prompt as Parameters<typeof query>[0]["prompt"],
      options: { ...options as NonNullable<Parameters<typeof query>[0]["options"]>, settingSources: [] } }),
  });
  let manager: SessionManager | undefined;
  try {
    vi.stubEnv("CLAUDE_CONFIG_DIR", processEnv.CLAUDE_CONFIG_DIR);
    manager = open();
    const id = await manager.start({ text: "Record fixture reads, a missing-file failure, a repair and the final verification.", attachments: [] }, dir);
    for (let i = 0; i < 4; i++) await manager.continue(id, { text: "Recent fixture turn " + i, attachments: [] });
    const original = manager.getTranscript(id);
    const originalJSON = JSON.stringify(original);
    const tools = original.flatMap(item => item.kind === "tool" ? [item.tool] : []);
    const reads = tools.filter(tool => tool.name === "Read" && tool.status === "done");
    expect(reads).toHaveLength(10);
    // Proofs must originate in SessionManager's actual hooks and tool_end path.
    expect(reads.every(tool => tool.summaryRead?.format === 1)).toBe(true);
    expect(new Set(reads.slice(0, 8).map(tool => tool.summaryRead?.resultHash)).size).toBe(1);
    expect(reads[8].summaryRead?.resultHash).not.toBe(reads[0].summaryRead?.resultHash);
    expect(tools.some(tool => tool.name === "Read" && tool.status === "error")).toBe(true);
    const kept = splitItemsForCompression(original).kept;
    expect(kept.filter(item => item.kind === "text" && item.role === "user")).toHaveLength(3);
    phase = "baseline-summary";
    const baseline = await compressor.compress(original, { model: summaryModel, contextLimit: 8000, deduplicateTools: false });
    phase = "enabled-summary";
    const enabled = await compressor.compress(original, { model: summaryModel, contextLimit: 8000, deduplicateTools: true });
    for (const result of [baseline, enabled]) {
      expect(factsFrom(result.summaryText)).toEqual(expectedFacts);
      expect(result.items.slice(1)).toEqual(kept);
    }
    expect(enabled.summaryStats?.deduplicatedToolResults).toBeGreaterThan(0);
    expect(enabled.summaryStats?.savedPreviewBytes).toBeGreaterThan(0);
    expect(baseline.summaryStats).toBeUndefined();
    expect(JSON.stringify(original)).toBe(originalJSON);
    const requests = (name: string) => wire.filter(request => request.phase === name && request.model === summaryModel);
    const bytes = (name: string) => requests(name).reduce((sum, request) => sum + Buffer.byteLength(request.raw), 0);
    expect(enabled.summaryStats?.calls).toBe(requests("enabled-summary").length);
    expect(enabled.summaryStats?.inputTextBytes).toBe(requests("enabled-summary").reduce((sum, request) =>
      sum + Buffer.byteLength(JSON.parse(request.raw).messages[0].content), 0));
    expect(bytes("enabled-summary")).toBeLessThan(bytes("baseline-summary"));
    expect(requests("enabled-summary").length).toBeLessThanOrEqual(requests("baseline-summary").length);
    const enabledInput = requests("enabled-summary").map(request => request.messages).join("\n");
    expect(enabledInput).not.toContain(reads[0].summaryRead!.resultHash);
    expect(enabledInput).not.toContain("previewHash");
    expect(enabledInput).toContain("[error]");
    expect(enabledInput).toContain("Tool: Write");
    expect(enabledInput).toContain("call " + reads.at(-1)!.id);
    const enabledText = requests("enabled-summary").map(request => JSON.parse(request.raw).messages[0].content).join("\n");
    for (const call of [reads[8], reads.at(-1)!]) {
      const card = original.find(item => item.kind === "tool" && item.tool.id === call.id)!;
      expect(enabledText).toContain(transcriptToText([card]));
    }
    phase = "baseline-continuation";
    let baselineAnswer = "";
    for await (const message of query({ prompt: buildContinuationPrompt(baseline.summaryText, { recent: kept }) + "\nReport the failure, repair and final result.",
      options: { cwd: dir, pathToClaudeCodeExecutable: executable, model, settingSources: [], tools: ["Read"], allowedTools: ["Read"], env: processEnv } })) {
      if (message.type === "result" && message.subtype === "success") baselineAnswer = message.result;
    }
    expect(factsFrom(baselineAnswer)).toEqual(expectedFacts);
    manager.flushPendingPersistence();
    const sourceSdkSessionId = archive.loadIndex().find(session => session.id === id)?.sdkSessionId;
    expect(sourceSdkSessionId).toBeTruthy();
    const readSourceSdk = () => getSessionMessages(sourceSdkSessionId!, { dir, includeSystemMessages: true });
    const sourceSdkBefore = await readSourceSdk();
    expect(sourceSdkBefore.length).toBeGreaterThan(0);
    phase = "archive-summary";
    const compact = await manager.compressSession(id);
    expect(compact.ok, compact.message).toBe(true);
    const revision = manager.listCompactionHistory(id)[0].revision;
    const archivedItems = (): ChatItem[] => {
      const first = manager!.getCompactionPage(id, revision, 0);
      const all = [...first.items];
      for (let offset = all.length; offset < first.total; offset += 25) all.push(...manager!.getCompactionPage(id, revision, offset).items);
      return all;
    };
    // The history viewer pages at 25 items; persistence removes undefined keys.
    expect(JSON.stringify(archivedItems())).toBe(originalJSON);
    const sdkFile = manager.compactionSdkFile(id, revision)!;
    const sdkBefore = fs.readFileSync(sdkFile, "utf8");
    // Compare every returned SDK message/block against a snapshot captured
    // before compaction, rather than only checking a newly created archive.
    expect(JSON.parse(sdkBefore)).toEqual(sourceSdkBefore);
    expect(sdkBefore).toContain("tool_result");
    expect(sdkBefore).toContain("MISSING_CONFIG");
    expect(sdkBefore).toContain("ADDED_CONFIG");
    expect(sdkBefore).not.toContain("summaryRead");
    manager.disposeAll();
    manager = open();
    phase = "enabled-continuation";
    await manager.continue(id, { text: "Report the failure, repair and final result.", attachments: [] });
    const enabledAnswer = manager.getTranscript(id).filter(item => item.kind === "text" && item.role === "assistant").at(-1);
    expect(factsFrom(enabledAnswer?.kind === "text" ? enabledAnswer.text : "")).toEqual(expectedFacts);
    expect(digest(fs.readFileSync(sdkFile, "utf8"))).toBe(digest(sdkBefore));
    const sourceSdkAfter = await readSourceSdk();
    expect(sourceSdkAfter).toEqual(sourceSdkBefore);
    expect(JSON.stringify(archivedItems())).toBe(originalJSON);
    expect(additionalReads["baseline-continuation"] ?? 0).toBe(0);
    expect(additionalReads["enabled-continuation"] ?? 0).toBe(0);
    // Optional, fully offline measurement over the exact full HTTP JSON, with
    // no hidden message/schema overhead added or removed between variants.
    const tokenizerPath = process.env.CC_JS_TIKTOKEN;
    const tokenizer = tokenizerPath ? createRequire(import.meta.url)(tokenizerPath) as {
      getEncoding(name: string): { encode(text: string): number[] };
    } : undefined;
    const encoding = tokenizer?.getEncoding("o200k_base");
    const measure = (name: string) => {
      const perRequest = requests(name).map(request => ({
        rawSHA256: digest(request.raw), requestJSONBytes: Buffer.byteLength(request.raw),
        inputTextBytes: Buffer.byteLength(JSON.parse(request.raw).messages[0].content),
        o200kBaseTokens: encoding?.encode(request.raw).length ?? null,
      }));
      return { requestJSONBytes: bytes(name), inputTextBytes: perRequest.reduce((sum, request) => sum + request.inputTextBytes, 0),
        o200kBaseTokens: encoding ? perRequest.reduce((sum, request) => sum + request.o200kBaseTokens!, 0) : null,
        calls: perRequest.length, perRequest };
    };
    const baselineMetrics = measure("baseline-summary");
    const enabledMetrics = measure("enabled-summary");
    if (encoding) expect(enabledMetrics.o200kBaseTokens).toBeLessThan(baselineMetrics.o200kBaseTokens!);
    const reportPath = path.resolve("../../.tmp/summary-tool-dedup-benchmark.json");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const transcriptFixture = path.join(path.dirname(reportPath), "summary-tool-dedup-transcript.fixture.json");
    const sdkFixture = path.join(path.dirname(reportPath), "summary-tool-dedup-sdk-archive.fixture.json");
    const sourceSdkFixture = path.join(path.dirname(reportPath), "summary-tool-dedup-sdk-source-before.fixture.json");
    fs.writeFileSync(transcriptFixture, originalJSON);
    fs.writeFileSync(sdkFixture, sdkBefore);
    fs.writeFileSync(sourceSdkFixture, JSON.stringify(sourceSdkBefore));
    const report = {
      format: 2, generatedAt: new Date().toISOString(), fixture: "real bundled CLI + SessionManager + local deterministic Messages provider",
      apiCase: { initialReadRepeats: 8, missingReadFailures: 1, writes: 1, postWriteReads: 2, laterTurns: 4, retainedRecentTurns: 3,
        summaryEndpoint: "/v1/messages", summaryContextLimit: 8000, summaryModel, continuationModel: model },
      tokenizer: encoding ? { package: "js-tiktoken", version: JSON.parse(fs.readFileSync(path.join(tokenizerPath!, "package.json"), "utf8")).version,
        encoding: "o200k_base", input: "each complete original summary HTTP request JSON, cumulative across calls", offline: true }
        : { encoding: "o200k_base", unavailable: "Set CC_JS_TIKTOKEN to an installed offline js-tiktoken package" },
      rawReadCount: reads.length, provenReadCount: reads.filter(tool => tool.summaryRead).length,
      baseline: { ...baselineMetrics, extraReads: additionalReads["baseline-continuation"] ?? 0 },
      enabled: { ...enabledMetrics, stats: enabled.summaryStats, extraReads: additionalReads["enabled-continuation"] ?? 0 },
      sourceArtifacts: [{ path: path.basename(transcriptFixture), sha256: digest(originalJSON) }, { path: path.basename(sdkFixture), sha256: digest(sdkBefore) },
        { path: path.basename(sourceSdkFixture), sha256: digest(JSON.stringify(sourceSdkBefore)) }],
      fixtureContentHashes: { sourceBefore: digest(before), sourceAfter: digest(after), recoveryEvidence: digest(expectedFacts.join("\n")) },
      facts: expectedFacts, originalTranscriptUnchanged: JSON.stringify(original) === originalJSON,
      compactionArchiveUnchanged: true, archivedSDKHashBefore: digest(sdkBefore), archivedSDKHashAfter: digest(fs.readFileSync(sdkFile, "utf8")),
      originalSourceSDK: { sessionId: sourceSdkSessionId, messageCount: sourceSdkBefore.length,
        beforeCompressionSHA256: digest(JSON.stringify(sourceSdkBefore)), afterRestartContinuationSHA256: digest(JSON.stringify(sourceSdkAfter)),
        archiveDeepEqualsPreCompressionSource: true, sourceDeepEqualAfterRestartContinuation: true },
      recentTurnsUnchanged: true, requests: wire,
      limitations: ["Local deterministic provider, not real LLM answer accuracy", "UTF-8 bytes and offline o200k_base counts over whole request JSON are proxies, not billed tokens", "Current tool cards expose a 200-character preview; savings apply to that preview", "Baseline fresh SDK continuation and enabled SessionManager restart continuation exercise different lifecycle paths", "Raw offline wire fixtures include built-in SDK tool configuration and must not be copied wholesale into public documentation"],
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } finally {
    vi.unstubAllEnvs();
    manager?.disposeAll();
    db.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 120_000);
