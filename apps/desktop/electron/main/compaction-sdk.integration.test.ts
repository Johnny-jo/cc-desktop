import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionMessages, query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatItem } from "@claude-desktop/shared";
import { expect, it, vi } from "vitest";
import { AppDatabase } from "./app-database";
import { createContextCompressor } from "./context-compressor";
import { DiffTracker } from "./diff-tracker";
import type { ModelRuntime } from "./model-runtime";
import { PermissionBroker } from "./permission-broker";
import { SessionArchive } from "./session-archive";
import { SessionManager } from "./session-manager";
import { SettingsStore } from "./settings-store";

// Opt-in wire test for a checkout with the production Windows CLI installed.
it.runIf(process.env.CC_TEST_BUNDLED_SDK === "1")("sends the durable compact handoff on the first Messages request after restart", async () => {
  const executable = path.resolve("../../vendor/win-x64/claude/claude.exe");
  expect(fs.existsSync(executable)).toBe(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compact-wire-"));
  const model = "claude-sonnet-4-6";
  const summaryModel = "fixture/summary";
  const readTool = { type: "tool_use", name: "Read", id: "toolu_fixture", input: { file_path: path.join(dir, "source.txt") } };
  const wire: { model: string; messages: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url?.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":100}');
      return;
    }
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    wire.push({ model: body.model, messages: JSON.stringify(body.messages) });
    const firstRead = body.stream && body.tools?.some((tool: { name?: string }) => tool.name === "Read") &&
      JSON.stringify(body.messages).includes("READ_FIXTURE_FILE") && !JSON.stringify(body.messages).includes(readTool.id);
    const text = body.model === summaryModel ? "Fixture summary of old work" : "Fixture resumed";
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
    event("content_block_start", { index: 0, content_block: firstRead ? { ...readTool, input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: firstRead ? {
      type: "input_json_delta", partial_json: JSON.stringify(readTool.input),
    } : { type: "text_delta", text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: firstRead ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    event("message_stop", {});
    res.end();
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local fixture port");
  const target = { origin: "http://127.0.0.1:" + address.port, token: "fixture-only" };
  const db = AppDatabase.open(dir)!;
  const settings = new SettingsStore({ userDataDir: dir, encrypt: s => s, decrypt: s => s });
  settings.update({ models: [model, summaryModel], defaultModel: model, tokenSavings: { mode: "balanced", summaryModel } });
  // Only the environment required to run the executable is inherited.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|comspec|pathext|temp|tmp|programfiles|localappdata)$/i.test(key))) as Record<string, string>;
  const ready = { state: "ready" as const, port: address.port, managedByApp: true };
  const cpa: ModelRuntime = {
    ensureReady: async () => ready, getStatus: () => ready,
    getProxyTarget: () => target, getModelCatalog: () => [{ id: model }, { id: summaryModel }],
    listModelCatalog: async () => [{ id: model }, { id: summaryModel }], getModelQuota: async () => null,
    buildProcessEnv: () => ({ ...env, CLAUDE_CONFIG_DIR: path.join(dir, "cli"), USERPROFILE: dir, HOME: dir,
      ANTHROPIC_BASE_URL: target.origin, ANTHROPIC_AUTH_TOKEN: target.token,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false" }),
    mergeSdkModelCapabilities() {}, stopIfManaged() {},
  };
  const open = () => new SessionManager({
    archive: new SessionArchive(dir, db), cpa, settings, compressor: createContextCompressor(() => settings.get(), () => target),
    readSdkMessages: (session, cwd) => getSessionMessages(session, { dir: cwd, includeSystemMessages: true }),
    diffTracker: new DiffTracker(), permissionBroker: new PermissionBroker({ getMode: () => "default", requestFromUi() { throw new Error("Unexpected tool"); } }),
    claudeExecutablePath: executable, emit() {}, emitSession() {}, emitDiff() {},
    queryFn: ({ prompt, options }) => query({ prompt: prompt as Parameters<typeof query>[0]["prompt"],
      options: { ...options as NonNullable<Parameters<typeof query>[0]["options"]>, settingSources: [] } }),
  });
  let manager: SessionManager | undefined;
  try {
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dir, "cli"));
    fs.writeFileSync(readTool.input.file_path, "Fixture file\n".repeat(50) + "RAW_TOOL_TAIL");
    manager = open();
    const id = await manager.start({ text: "READ_FIXTURE_FILE", attachments: [] }, dir);
    expect(wire.some(request => request.messages.includes("RAW_TOOL_TAIL"))).toBe(true);
    const original: ChatItem[] = [];
    for (let i = 0; i < 5; i++) {
      original.push({ kind: "text", id: "u" + i, role: "user", text: "User sentinel " + i });
      original.push({ kind: "text", id: "a" + i, role: "assistant", text: "Assistant sentinel " + i });
    }
    original.push({ kind: "tool", id: "call", tool: { id: "test-result", name: "Read", summary: "fixture.txt", status: "done", resultPreview: "TOOL_SENTINEL" } });
    manager.saveTranscript(id, original, { replace: true });
    wire.length = 0;
    const compact = await manager.compressSession(id);
    expect(compact.ok, compact.message).toBe(true);
    expect(wire).toHaveLength(1);
    expect(wire[0].model).toBe(summaryModel);
    expect(wire[0].messages).toContain("User sentinel 0");
    manager.disposeAll();
    manager = open();
    const revision = manager.listCompactionHistory(id)[0].revision;
    expect(manager.getCompactionPage(id, revision, 0).items).toMatchObject(original);
    const sdkFile = manager.compactionSdkFile(id, revision);
    const rawHistory = fs.readFileSync(sdkFile!, "utf8");
    expect(rawHistory).toContain("tool_result");
    expect(rawHistory).toContain("RAW_TOOL_TAIL");
    await manager.continue(id, { text: "NEW_QUESTION", attachments: [] });
    const next = wire.find(request => request.messages.includes("NEW_QUESTION"));
    expect(next?.model).toBe(model);
    for (const sentinel of ["Fixture summary of old work", "User sentinel 4", "Assistant sentinel 4", "TOOL_SENTINEL"]) {
      expect(next?.messages).toContain(sentinel);
    }
    expect(next?.messages).not.toContain("User sentinel 0");
    expect(next?.messages).not.toContain("RAW_TOOL_TAIL");
    expect(manager.getSummary(id)).toMatchObject({ status: "idle", contextUsage: { modelId: model, occupancySource: "sdk" } });
  } finally {
    vi.unstubAllEnvs();
    manager?.disposeAll();
    db.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);
