import fs from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import ts from "typescript";
import { expect, it } from "vitest";
import { DiffTracker } from "./diff-tracker";
import type { ModelRuntime } from "./model-runtime";
import { PermissionBroker } from "./permission-broker";
import { SessionManager } from "./session-manager";
import { SettingsStore } from "./settings-store";

const model = "claude-sonnet-4-6";
const symbolTool = "mcp__agentos-code__read_symbol";
const repo = path.resolve("../..");
type Strategy = "read" | "symbol";
type Task = { cwd: string; name: string; files: string[] };
type Call = { file: string; line: number; column: number };
type Definition = { file: string; startLine: number; endLine: number; text: string };
type Evidence = { definition: Definition; calls: Call[] };
type ToolRequest = { name: string; input: Record<string, unknown> };
type ToolResult = { type: string; tool_use_id: string; is_error?: boolean; content: string | { type: string; text: string }[] };
type Size = { chars: number; tokens?: number };

function normalize(text: string) { return text.replace(/\r\n/g, "\n"); }
function orderCalls(a: Call, b: Call) { return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column; }

// Independent reader for these fixtures: all calls use the declared name directly.
// Feed it the CLI Read payloads, including one-based line numbers, not the symbol index.
function evidenceFromSource(name: string, files: Map<string, string>): Evidence {
  let definition: Definition | undefined;
  const calls: Call[] = [];
  for (const [file, text] of files) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        expect(definition).toBeUndefined();
        definition = { file, startLine: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          endLine: source.getLineAndCharacterOfPosition(node.end - 1).line + 1, text: node.getText() };
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        const point = source.getLineAndCharacterOfPosition(node.expression.getStart());
        calls.push({ file, line: point.line + 1, column: point.character + 1 });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  if (!definition || !calls.length) throw Error("Missing definition or calls in Read evidence");
  return { definition, calls: calls.sort(orderCalls) };
}

function answerFromResults(strategy: Strategy, task: Task, results: ToolResult[]): Evidence {
  const textOf = (result: ToolResult) => typeof result.content === "string" ? result.content :
    result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  for (const result of results) if (result.is_error) throw Error(textOf(result));
  if (strategy === "symbol") {
    expect(results).toHaveLength(1);
    // The CLI may append a budget reminder to a tool_result. Count the whole
    // block on the wire, but decode only the tool's JSON payload as evidence.
    const found = JSON.parse(textOf(results[0]).split(/\n+<system-reminder>/, 1)[0]);
    expect(found).toMatchObject({ status: "found", totalCalls: found.calls?.length, nextCallOffset: null });
    const { file, startLine, endLine, text } = found.definition as Definition;
    const calls = (found.calls as Call[]).map(({ file, line, column }) => ({ file, line, column }));
    return { definition: { file, startLine, endLine, text: normalize(text) }, calls: calls.sort(orderCalls) };
  }
  expect(results).toHaveLength(task.files.length);
  const sources = new Map<string, string>();
  for (const [index, file] of task.files.entries()) {
    const result = results.find(item => item.tool_use_id === "toolu_" + index);
    if (!result) throw Error("Missing Read response for " + file);
    const lines = [...normalize(textOf(result)).matchAll(/^\s*(\d+)(?:\t|→)(.*)$/gm)];
    lines.forEach((match, i) => expect(Number(match[1])).toBe(i + 1));
    const content = lines.map(match => match[2]).join("\n");
    // Verify the full file reached the provider, including the last line. Read
    // can omit the final newline or include a separate SDK system reminder.
    const disk = normalize(fs.readFileSync(path.join(task.cwd, file), "utf8"));
    expect(content.replace(/\n$/, "")).toBe(disk.replace(/\n$/, ""));
    sources.set(file, content);
  }
  return evidenceFromSource(task.name, sources);
}

function respond(res: http.ServerResponse, calls: ToolRequest[], answer: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, payload: object) => res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...payload }) + "\n\n");
  send("message_start", { message: { id: calls.length ? "msg_calls" : "msg_answer", type: "message", role: "assistant",
    model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  if (calls.length) {
    calls.forEach((call, index) => {
      send("content_block_start", { index, content_block: { type: "tool_use", id: "toolu_" + index, name: call.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
      send("content_block_stop", { index });
    });
  } else {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer } });
    send("content_block_stop", { index: 0 });
  }
  send("message_delta", { delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  res.end();
}

// Enable with CC_TEST_BUNDLED_SDK=1 after building the desktop worker.
// CC_JS_TIKTOKEN may point to a local js-tiktoken installation. No downloads.
it.runIf(process.env.CC_TEST_BUNDLED_SDK === "1")("compares whole-file Reads and read_symbol at the provider with the same complete evidence", async () => {
  const tokenizer = process.env.CC_JS_TIKTOKEN
    ? createRequire(import.meta.url)(process.env.CC_JS_TIKTOKEN).getEncoding("o200k_base") : undefined;
  const measure = (text: string): Size => ({ chars: text.length, tokens: tokenizer?.encode(text, [], []).length });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-symbol-wire-"));
  const reports = [];
  try {
    const tiny = path.join(dir, "tiny");
    fs.mkdirSync(tiny);
    fs.writeFileSync(path.join(tiny, "tiny.ts"), "export function twice(x: number) { return 2 * x; }\ntwice(3);\n");
    const tasks: Task[] = [
      { cwd: repo, name: "compactBrowserResult", files: ["apps/desktop/electron/main/tool-output-policy.ts", "apps/desktop/electron/main/tool-output-policy.test.ts"] },
      { cwd: tiny, name: "twice", files: ["tiny.ts"] },
    ];
    for (const task of tasks) {
      const expected = evidenceFromSource(task.name, new Map(task.files.map(file =>
        [file, normalize(fs.readFileSync(path.join(task.cwd, file), "utf8"))])));
      for (const strategy of ["read", "symbol"] as const) {
        const profile = path.join(dir, task.name + "-" + strategy);
        fs.mkdirSync(profile);
        const requests: Size[] = [], resultBlocks: Size[] = [];
        let error: unknown, evidence: Evidence | undefined;
        const selected = strategy === "symbol" ? symbolTool : "Read";
        const server = http.createServer(async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          if (req.url?.startsWith("/v1/messages/count_tokens")) {
            res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":100}');
            return;
          }
          if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
          try {
            const raw = Buffer.concat(chunks).toString();
            const body = JSON.parse(raw);
            requests.push(measure(raw));
            if (requests.length === 1) {
              const names = body.tools.map((tool: { name: string }) => tool.name);
              expect(names).toContain(selected);
              expect(names.includes(symbolTool)).toBe(strategy === "symbol");
              // Give the baseline both known paths and one parallel batch; charge no search.
              const calls = strategy === "read" ? task.files.map(file =>
                ({ name: selected, input: { file_path: path.join(task.cwd, file) } })) :
                [{ name: selected, input: { name: task.name } }];
              respond(res, calls, "");
            } else {
              const results = body.messages.at(-1).content.filter((block: ToolResult) => block.type === "tool_result") as ToolResult[];
              resultBlocks.push(...results.map(block => measure(JSON.stringify(block))));
              evidence = answerFromResults(strategy, task, results);
              respond(res, [], JSON.stringify(evidence));
            }
          } catch (err) { error = err; respond(res, [], "fixture failed"); }
        });
        await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw Error("Missing loopback port");
        const ready = { state: "ready" as const, port: address.port, managedByApp: false };
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          /^(path|systemroot|windir|comspec|pathext|temp|tmp|programfiles|localappdata|programfiles\(x86\))$/i.test(key))) as Record<string, string>;
        const cpa: ModelRuntime = {
          ensureReady: async () => ready, getStatus: () => ready, getProxyTarget: () => null,
          listModelCatalog: async () => [], getModelCatalog: () => [], getModelQuota: async () => null,
          mergeSdkModelCapabilities() {}, stopIfManaged() {},
          buildProcessEnv: () => ({ ...env, USERPROFILE: profile, HOME: profile, CLAUDE_CONFIG_DIR: profile,
            ANTHROPIC_BASE_URL: "http://127.0.0.1:" + address.port, ANTHROPIC_AUTH_TOKEN: "fixture-only",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false" }),
        };
        const settings = new SettingsStore({ userDataDir: profile, encrypt: s => s, decrypt: s => s });
        settings.update({ models: [model], defaultModel: model, tokenSavings: { mode: "balanced" } });
        const permissionBroker = new PermissionBroker({ getMode: () => "default", requestFromUi(request) {
          if (strategy !== "symbol" || request.toolName !== symbolTool) throw Error("Unexpected permission prompt for " + request.toolName);
          expect(request.inputPreview).toEqual({ name: task.name });
          permissionBroker.respond(request.requestId, { behavior: "allow", scope: "once" });
        } });
        const manager = new SessionManager({ cpa, settings, diffTracker: new DiffTracker(),
          claudeExecutablePath: path.join(repo, "vendor/win-x64/claude/claude.exe"), toolOutputDatabasePath: path.join(profile, "tools.sqlite3"),
          permissionBroker, emit() {}, emitSession() {}, emitDiff() {},
          queryFn: ({ prompt, options }) => {
            const opts = options as NonNullable<Parameters<typeof query>[0]["options"]>;
            const servers = { ...opts.mcpServers };
            // Reproduce the previous tool list; both arms keep the same budget, CLI and SDK.
            if (strategy === "read") delete servers["agentos-code"];
            return query({ prompt: prompt as Parameters<typeof query>[0]["prompt"],
              options: { ...opts, mcpServers: servers, settingSources: [] } });
          },
        });
        try {
          const id = await manager.start({ text: "Return the complete source definition, file and line range for " + task.name +
            ", and the file, line and column of every direct call in this workspace.", attachments: [] }, task.cwd);
          if (error) throw error;
          expect(requests).toHaveLength(2);
          expect(evidence).toEqual(expected);
          expect(manager.getSummary(id)?.status).toBe("idle");
          expect(manager.getTranscript(id).some(item => item.kind === "text" && item.role === "assistant" &&
            item.text === JSON.stringify(expected))).toBe(true);
          reports.push({ name: task.name, strategy, toolResults: resultBlocks, messagesRequests: requests,
            definition: { file: expected.definition.file, startLine: expected.definition.startLine, endLine: expected.definition.endLine,
              sha256: createHash("sha256").update(expected.definition.text).digest("hex") }, calls: expected.calls });
        } finally {
          manager.disposeAll();
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      }
    }
    const report = { encoding: tokenizer ? "o200k_base" : undefined, reports };
    console.info("Code symbol wire measurements", JSON.stringify(report));
    if (process.env.CC_CODE_SYMBOL_REPORT) fs.writeFileSync(process.env.CC_CODE_SYMBOL_REPORT, JSON.stringify(report, null, 2));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
}, 120_000);
