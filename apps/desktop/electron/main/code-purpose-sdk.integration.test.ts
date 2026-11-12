import fs from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import ts from "typescript";
import { expect, it } from "vitest";
import { createCodeSymbolBinding } from "./code-symbol-tool";
import { DiffTracker } from "./diff-tracker";
import type { ModelRuntime } from "./model-runtime";
import { PermissionBroker } from "./permission-broker";
import { SessionManager } from "./session-manager";
import { SettingsStore } from "./settings-store";

const model = "claude-sonnet-4-6";
const symbolTool = "mcp__agentos-code__read_symbol";
const repo = path.resolve("../..");
const normalize = (text: string) => text.replace(/\r\n/g, "\n");
const sha256 = (text: string) => createHash("sha256").update(normalize(text)).digest("hex");
const sourceSha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// This runs without a provider or worker build, and caught the old name-only
// contract before purpose lookup was implemented.
it("advertises name-free purpose lookup on the actual MCP server", async () => {
  const req = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = req("@modelcontextprotocol/sdk/inMemory.js");
  const binding = createCodeSymbolBinding({ root: repo, isActive: () => true,
    listRules: async () => ({ state: { rules: [], errors: [] } }) as never, desktopDeny: () => [] });
  const client = new Client({ name: "purpose-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await binding.server.instance.connect(b);
    await client.connect(a);
    const tool = (await client.listTools()).tools.find((item: { name: string }) => item.name === "read_symbol");
    expect(tool?.inputSchema.properties).toHaveProperty("purpose");
    expect(tool?.inputSchema.properties).toHaveProperty("hints");
    expect(tool?.inputSchema.required ?? []).not.toContain("name");
    // The bundled CLI omitted an earlier schema-union variant entirely.
    // Keep discovery flat; the call handler enforces mutually exclusive modes.
    expect(tool?.inputSchema).not.toHaveProperty("anyOf");
  } finally { await client.close(); await binding.server.instance.close(); }
});

type Strategy = "grep-symbol" | "grep-read" | "purpose-symbol";
type Task = { id: string; cwd: string; searchDir: string; purpose: string; hints: string[];
  oracle?: { file: string; name: string }; files?: string[] };
type ToolRequest = { name: string; input: Record<string, unknown> };
type ToolResult = { type: string; tool_use_id: string; is_error?: boolean;
  content: string | { type: string; text: string }[] };
type Definition = { name: string; file: string; startLine: number; endLine: number; text: string; sha256: string };
type Branch = { kind: string; text: string };
type Evidence = { status: "found"; definition: Definition; branches: Branch[]; conclusion: string } |
  { status: "no_implementation"; testEvidence: boolean; conclusion: string };
type Candidate = { name: string; file: string; startLine: number; endLine: number; startColumn: number;
  excerpt: { startLine: number; endLine: number; startColumn?: number; endColumn?: number; text: string }; reasons: string[] };
type Hit = { file: string; line: number; text: string };
type Size = { chars: number; tokens?: number };

const textOf = (result: ToolResult) => typeof result.content === "string" ? result.content :
  result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
const payloadOf = (result: ToolResult) => JSON.parse(textOf(result).split(/\n+<system-reminder>/, 1)[0]);
const isTest = (file: string) => /(?:^|[/\\])(?:tests?|spec|__tests__)(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file);
const absence = (testEvidence: boolean): Evidence => ({ status: "no_implementation", testEvidence,
  conclusion: testEvidence ? "Only test evidence surfaced; no business implementation was established in the searched JS/TS scope." :
    "No implementation surfaced for these clues in the searched JS/TS scope; lexical search alone does not prove repository-wide absence." });

function sourceDefinition(file: string, sourceText: string, name: string): Definition {
  const text = normalize(sourceText);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const matches: ts.Node[] = [];
  function visit(node: ts.Node) {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name && node.body) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(matches).toHaveLength(1);
  const node = matches[0], start = node.getStart(source, true);
  const definition = text.slice(start, node.end);
  return { name, file, startLine: source.getLineAndCharacterOfPosition(start).line + 1,
    endLine: source.getLineAndCharacterOfPosition(node.end - 1).line + 1, text: definition, sha256: sha256(definition) };
}

// An answer is derived only after the provider has received a full definition.
// The independent on-disk oracle below is never passed into this reader/planner.
function explain(definition: Definition): Evidence {
  const source = ts.createSourceFile("received.ts", "class Received {\n" + definition.text + "\n}", ts.ScriptTarget.Latest, true);
  const branches: Branch[] = [];
  function visit(node: ts.Node) {
    if (ts.isExpressionStatement(node) && node.getText(source) === "signal.throwIfAborted();" && !branches.some(b => b.kind === "abort")) {
      branches.push({ kind: "abort", text: node.getText(source) });
    }
    if (ts.isIfStatement(node) && node.expression.getText(source).includes("summaryModel !== this.summaryModel(entry)")) {
      branches.push({ kind: "model-change", text: node.getText(source) });
    }
    if (ts.isVariableStatement(node) && /const fail =/.test(node.getText(source)) && node.getText(source).includes("cancelled: signal.aborted")) {
      branches.push({ kind: "cancelled-result", text: node.getText(source) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(branches.map(b => b.kind).sort()).toEqual(["abort", "cancelled-result", "model-change"]);
  branches.sort((a, b) => a.kind.localeCompare(b.kind));
  return { status: "found", definition, branches,
    conclusion: "Compression checks abort after awaiting the summary, rejects a changed main or summary model before committing, and reports cancelled for abort or stream-generation change. A model mismatch alone need not set cancelled=true. This function alone does not prove a waiting prompt is sent exactly once." };
}

function grepHits(result: ToolResult, cwd: string): Hit[] {
  const hits: Hit[] = [];
  for (const line of normalize(textOf(result)).split("\n")) {
    // A search with a single file can omit the path. Multi-file content uses
    // file:line:text (and file-line-text for contextual lines).
    const match = /^(.*?)(?::|-)(\d+)(?::|-)(.*)$/.exec(line);
    if (match) {
      const absolute = path.isAbsolute(match[1]) ? match[1] : path.resolve(cwd, match[1]);
      hits.push({ file: path.relative(cwd, absolute).split(path.sep).join("/"), line: Number(match[2]), text: match[3] });
    }
  }
  return hits;
}

function readLines(result: ToolResult): { line: number; text: string }[] {
  return [...normalize(textOf(result)).matchAll(/^\s*(\d+)(?:\t|→)(.*)$/gm)]
    .map(match => ({ line: Number(match[1]), text: match[2] }));
}

const declarationPattern = "^  (?:private |public |protected )?(?:async )?[A-Za-z_$][\\w$]*\\(";
const declarationName = /^\s*(?:(?:private|public|protected|async)\s+)*([A-Za-z_$][\w$]*)\(/;

function definitionFromRead(result: ToolResult, anchor: Hit): Definition | undefined {
  const rows = readLines(result);
  const headers = rows.filter(row => row.line <= anchor.line && new RegExp(declarationPattern).test(row.text));
  const header = headers.at(-1);
  if (!header) return;
  const name = declarationName.exec(header.text)?.[1];
  if (!name) return;
  let startIndex = rows.findIndex(row => row.line === header.line);
  if (rows[startIndex - 1]?.text.trim() === "*/" || rows[startIndex - 1]?.text.includes("/**")) {
    while (startIndex > 0 && !rows[startIndex - 1].text.includes("/**")) startIndex--;
    if (startIndex > 0) startIndex--;
  }
  const selected = rows.slice(startIndex);
  const prefix = "class Received {\n";
  const source = ts.createSourceFile("read.ts", prefix + selected.map(row => row.text).join("\n") + "\n}", ts.ScriptTarget.Latest, true);
  let method: ts.MethodDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === name) method = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!method?.body) return;
  const found = method as ts.MethodDeclaration;
  const start = found.getStart(source, true), end = found.end;
  // Synthetic closing braces must never turn a truncated Read into evidence.
  if (end > prefix.length + selected.map(row => row.text).join("\n").length || source.text[end - 1] !== "}") return;
  const text = source.text.slice(start, end);
  return { name, file: anchor.file, startLine: selected[0].line + source.getLineAndCharacterOfPosition(start).line - 1,
    endLine: selected[0].line + source.getLineAndCharacterOfPosition(end - 1).line - 1, text, sha256: sha256(text) };
}

function respond(res: http.ServerResponse, calls: ToolRequest[], answer: string, sequence: number) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, payload: object) => res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...payload }) + "\n\n");
  send("message_start", { message: { id: "msg_" + sequence, type: "message", role: "assistant", model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  calls.forEach((call, index) => {
    send("content_block_start", { index, content_block: { type: "tool_use", id: "toolu_" + sequence + "_" + index, name: call.name, input: {} } });
    send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
    send("content_block_stop", { index });
  });
  if (!calls.length) {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer } });
    send("content_block_stop", { index: 0 });
  }
  send("message_delta", { delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  res.end();
}

// Enable after the normal worker build. All tools are the bundled CLI's real
// tools; only the provider is a local deterministic endpoint. It never reads
// source files or an oracle to decide what to search/read next.
it.runIf(process.env.CC_TEST_BUNDLED_SDK === "1")("benchmarks purpose discovery and conservative Grep workflows using identical source evidence", async () => {
  const tokenizer = process.env.CC_JS_TIKTOKEN ? createRequire(import.meta.url)(process.env.CC_JS_TIKTOKEN).getEncoding("o200k_base") : undefined;
  const measure = (text: string): Size => ({ chars: text.length, tokens: tokenizer?.encode(text, [], []).length });
  const total = (sizes: Size[]): Size => ({ chars: sizes.reduce((sum, size) => sum + size.chars, 0),
    tokens: tokenizer ? sizes.reduce((sum, size) => sum + (size.tokens ?? 0), 0) : undefined });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-purpose-wire-"));
  const reports: object[] = [];
  try {
    const missing = path.join(dir, "missing"), testOnly = path.join(dir, "test-only");
    for (const fixture of [missing, testOnly]) {
      fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
      fs.writeFileSync(path.join(fixture, "src/ordinary.ts"), "export function listNames() { return []; }\n");
    }
    fs.mkdirSync(path.join(testOnly, "tests"));
    fs.writeFileSync(path.join(testOnly, "tests/lease.test.ts"),
      "export function verifiesOrbitalCabinetLease() {\n  const orbitalCabinetLease = 'expected behavior, implementation missing';\n  return orbitalCabinetLease;\n}\n");
    const tasks: Task[] = [
      { id: "real-model-change-guard", cwd: repo, searchDir: "apps/desktop/electron/main",
        purpose: "找到压缩会话历史的实现：等待辅助摘要时，如果主模型或摘要模型变了，或者请求被取消，要在提交前拒绝过期摘要并报告取消状态。给出完整函数和关键守卫分支原文。",
        hints: ["summaryModel", "abort"], oracle: { file: "apps/desktop/electron/main/session-manager.ts", name: "compressSession" } },
      { id: "no-implementation", cwd: missing, searchDir: ".", purpose: "找到执行 quantumLeaseReconciliation 的业务实现。",
        hints: ["quantumLeaseReconciliation"], files: ["src/ordinary.ts"] },
      { id: "test-evidence-only", cwd: testOnly, searchDir: ".", purpose: "找到执行 orbitalCabinetLease 的业务实现。",
        hints: ["orbitalCabinetLease"], files: ["src/ordinary.ts", "tests/lease.test.ts"] },
    ];
    for (const task of tasks) {
      const taskPrompt = task.purpose + "\nClues: " + task.hints.join(", ") + "\nSearch directory: " + task.searchDir +
        ". Return the complete function, key branch source, and a conclusion supported by that source. Distinguish test evidence from business implementation.";
      // Oracle construction is outside and independent of the simulated provider.
      const expected = task.oracle ? explain(sourceDefinition(task.oracle.file,
        fs.readFileSync(path.join(task.cwd, task.oracle.file), "utf8"), task.oracle.name)) : absence(task.id === "test-evidence-only");
      const sourceHashes = (task.oracle ? [task.oracle.file] : task.files!).map(file =>
        ({ file, sha256: sourceSha256(path.join(task.cwd, file)) }));
      for (const strategy of ["grep-symbol", "grep-read", "purpose-symbol"] as const) {
        const profile = path.join(dir, task.id + "-" + strategy);
        fs.mkdirSync(profile);
        const requests: Size[] = [], resultBlocks: Size[] = [], toolCalls: ToolRequest[] = [];
        const requestTimes: number[] = [];
        const searchEvidence: object[] = [];
        const diagnostics: string[] = [];
        let error: unknown, evidence: Evidence | undefined, anchor: Hit | undefined, readAttempts = 0;
        let stage: "initial" | "search" | "test-search" | "declarations" | "read" | "definition" = "initial";
        const issue = (res: http.ServerResponse, calls: ToolRequest[]) => {
          toolCalls.push(...calls);
          respond(res, calls, "", requests.length);
        };
        const finish = (res: http.ServerResponse, answer: Evidence) => { evidence = answer; respond(res, [], JSON.stringify(answer), requests.length); };
        const server = http.createServer(async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          if (req.url?.startsWith("/v1/messages/count_tokens")) {
            res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":100}'); return;
          }
          if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
          try {
            const raw = Buffer.concat(chunks).toString(), body = JSON.parse(raw);
            requestTimes.push(performance.now());
            requests.push(measure(raw));
            if (stage === "initial") {
              expect(body.tools.map((tool: { name: string }) => tool.name)).toContain(strategy === "purpose-symbol" ? symbolTool : "Grep");
              if (strategy !== "grep-read") expect(body.tools.map((tool: { name: string }) => tool.name)).toContain(symbolTool);
              stage = "search";
              issue(res, strategy === "purpose-symbol" ? [{ name: symbolTool, input: { purpose: task.purpose, hints: task.hints, scope: task.searchDir } }] :
                [{ name: "Grep", input: { pattern: task.hints[0], path: path.join(task.cwd, task.searchDir), glob: "!**/*.{test,spec}.{ts,tsx,js,jsx}",
                  output_mode: "content", "-n": true, "-C": 8, head_limit: 200 } }]);
              return;
            }
            const results = body.messages.at(-1).content.filter((block: ToolResult) => block.type === "tool_result") as ToolResult[];
            expect(results).toHaveLength(1);
            for (const result of results) {
              resultBlocks.push(measure(JSON.stringify(result)));
              if (result.is_error) throw Error(textOf(result));
            }
            const result = results[0];
            if (stage === "search" && strategy === "purpose-symbol") {
              const found = payloadOf(result);
              expect(["candidates", "no_match"]).toContain(found.status);
              expect(found.candidates.length).toBeLessThanOrEqual(3);
              expect(found.terms.length).toBeGreaterThan(0);
              expect(found.coverage).toHaveProperty("indexedFiles");
              const candidates = found.candidates as Candidate[];
              for (const candidate of candidates) {
                expect(candidate).toMatchObject({ name: expect.any(String), file: expect.any(String), startLine: expect.any(Number),
                  endLine: expect.any(Number), startColumn: expect.any(Number), reasons: expect.any(Array),
                  excerpt: { startLine: expect.any(Number), endLine: expect.any(Number), text: expect.any(String) } });
                if (isTest(candidate.file)) expect(candidate.reasons.join(" ")).toMatch(/test|fixture/i);
              }
              searchEvidence.push(found);
              // Test-only hits are retained as evidence but cannot establish a
              // business implementation. Select only from returned candidates.
              const eligible = candidates.filter(candidate => !isTest(candidate.file));
              const score = (candidate: Candidate) => {
                const text = candidate.excerpt.text;
                // A small transparent reader for the supplied behavior, not a
                // known target name or a best-candidate index from the oracle.
                return task.hints.reduce((sum, hint) => sum + (text.toLowerCase().includes(hint.toLowerCase()) ? 1 : 0), 0) +
                  (task.purpose.includes("压缩") && /compress|compact/i.test(text) ? 3 : 0) +
                  (task.purpose.includes("等待") && /\bawait\b/.test(text) ? 2 : 0) +
                  (task.purpose.includes("取消") && /throwIfAborted|signal\.aborted/.test(text) ? 2 : 0) +
                  (task.purpose.includes("模型") && task.purpose.includes("变") && /summaryModel\s*!==/.test(text) ? 2 : 0);
              };
              eligible.sort((a, b) => score(b) - score(a));
              const selected = eligible[0];
              searchEvidence.push({ candidateSelection: eligible.map(candidate => ({ name: candidate.name, file: candidate.file, score: score(candidate) })) });
              if (!selected) { finish(res, absence(candidates.some(candidate => isTest(candidate.file)))); return; }
              stage = "definition";
              issue(res, [{ name: symbolTool, input: { name: selected.name, file: selected.file, line: selected.startLine, column: selected.startColumn } }]);
            } else if (stage === "test-search") {
              const hits = grepHits(result, task.cwd).filter(hit => hit.text.toLowerCase().includes(task.hints[0].toLowerCase()));
              searchEvidence.push({ tool: "Grep", testSearch: true, hits });
              finish(res, absence(hits.some(hit => isTest(hit.file))));
            } else if (stage === "search") {
              const context = grepHits(result, task.cwd);
              const hits = context.filter(hit => hit.text.toLowerCase().includes(task.hints[0].toLowerCase()));
              searchEvidence.push({ tool: "Grep", hits });
              const eligible = hits.filter(hit => !isTest(hit.file));
              if (!eligible.length) {
                stage = "test-search";
                issue(res, [{ name: "Grep", input: { pattern: task.hints[0], path: path.join(task.cwd, task.searchDir),
                  glob: "**/*.{test,spec}.{ts,tsx,js,jsx}", output_mode: "content", "-n": true, head_limit: 100 } }]);
                return;
              }
              const fileScore = (file: string) => task.hints.reduce((sum, hint) => sum +
                (context.some(row => row.file === file && row.text.toLowerCase().includes(hint.toLowerCase())) ? 1 : 0), 0);
              const selectedFile = [...new Set(eligible.map(hit => hit.file))].sort((a, b) => fileScore(b) - fileScore(a))[0];
              // The changed-model guard is selected by returned source text,
              // never a target name/file/coordinate from the oracle.
              anchor = eligible.find(hit => hit.file === selectedFile && /summaryModel\s*!==/.test(hit.text)) ?? eligible.find(hit => hit.file === selectedFile);
              if (!anchor) throw Error("Grep returned no production anchor");
              if (strategy === "grep-symbol") {
                stage = "declarations";
                issue(res, [{ name: "Grep", input: { pattern: declarationPattern, path: path.join(task.cwd, anchor.file),
                  output_mode: "content", "-n": true, head_limit: 200 } }]);
              } else {
                stage = "read"; readAttempts++;
                issue(res, [{ name: "Read", input: { file_path: path.join(task.cwd, anchor.file), offset: Math.max(1, anchor.line - 100), limit: 220 } }]);
              }
            } else if (stage === "declarations") {
              const rows = grepHits(result, task.cwd);
              // Single-file Grep often prints line:text instead of file:line:text.
              if (!rows.length) for (const line of normalize(textOf(result)).split("\n")) {
                const match = /^(\d+):(.*)$/.exec(line);
                if (match) rows.push({ file: anchor!.file, line: Number(match[1]), text: match[2] });
              }
              const selected = rows.filter(row => row.line <= anchor!.line && declarationName.test(row.text)).at(-1);
              if (!selected) throw Error("Grep returned no enclosing declaration");
              const name = declarationName.exec(selected.text)![1];
              stage = "definition";
              issue(res, [{ name: symbolTool, input: { name, file: anchor!.file, line: selected.line } }]);
            } else if (stage === "read") {
              const found = definitionFromRead(result, anchor!);
              if (!found) {
                if (readAttempts >= 3) throw Error("Read did not expose a complete enclosing definition");
                readAttempts++;
                issue(res, [{ name: "Read", input: { file_path: path.join(task.cwd, anchor!.file), offset: Math.max(1, anchor!.line - 220), limit: 440 } }]);
              } else finish(res, explain(found));
            } else {
              const found = payloadOf(result);
              expect(found.status).toBe("found");
              expect(found.definition.text).toBeTypeOf("string");
              const name = String(toolCalls.at(-1)!.input.name);
              finish(res, explain({ name, file: found.definition.file, startLine: found.definition.startLine,
                endLine: found.definition.endLine, text: normalize(found.definition.text), sha256: sha256(found.definition.text) }));
            }
          } catch (err) {
            error = new Error(task.id + "/" + strategy + "/" + stage + ": " + String(err));
            respond(res, [], "fixture failed", requests.length);
          }
        });
        await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw Error("Missing loopback port");
        const ready = { state: "ready" as const, port: address.port, managedByApp: false };
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          /^(path|systemroot|windir|comspec|pathext|temp|tmp|programfiles|localappdata|programfiles\(x86\))$/i.test(key))) as Record<string, string>;
        const cpa: ModelRuntime = { ensureReady: async () => ready, getStatus: () => ready, getProxyTarget: () => null,
          listModelCatalog: async () => [], getModelCatalog: () => [], getModelQuota: async () => null, mergeSdkModelCapabilities() {}, stopIfManaged() {},
          buildProcessEnv: () => ({ ...env, USERPROFILE: profile, HOME: profile, CLAUDE_CONFIG_DIR: profile,
            ANTHROPIC_BASE_URL: "http://127.0.0.1:" + address.port, ANTHROPIC_AUTH_TOKEN: "fixture-only",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false" }) };
        const settings = new SettingsStore({ userDataDir: profile, encrypt: s => s, decrypt: s => s });
        settings.update({ models: [model], defaultModel: model, tokenSavings: { mode: "balanced" } });
        const permissionBroker = new PermissionBroker({ getMode: () => "default", requestFromUi(request) {
          if (!["Grep", "Read", symbolTool].includes(request.toolName)) throw Error("Unexpected permission prompt: " + request.toolName);
          permissionBroker.respond(request.requestId, { behavior: "allow", scope: "once" });
        } });
        const manager = new SessionManager({ cpa, settings, diffTracker: new DiffTracker(),
          claudeExecutablePath: path.join(repo, "vendor/win-x64/claude/claude.exe"), toolOutputDatabasePath: path.join(profile, "tools.sqlite3"),
          permissionBroker, emit() {}, emitSession() {}, emitDiff() {}, queryFn: ({ prompt, options }) => {
            const opts = options as NonNullable<Parameters<typeof query>[0]["options"]>;
            const servers = { ...opts.mcpServers };
            if (strategy !== "grep-read") expect(Object.keys(servers)).toContain("agentos-code");
            if (strategy === "grep-read") delete servers["agentos-code"];
            return query({ prompt: prompt as Parameters<typeof query>[0]["prompt"], options: { ...opts, mcpServers: servers, settingSources: [],
              stderr: data => diagnostics.push(data) } });
          } });
        try {
          const startedAt = performance.now();
          const id = await manager.start({ text: taskPrompt, attachments: [] }, task.cwd);
          const elapsedMs = Math.round(performance.now() - startedAt);
          if (error) throw new Error(String(error) + "\nSearch evidence:\n" + JSON.stringify(searchEvidence) + "\nCLI diagnostics:\n" + diagnostics.join("").slice(-9000));
          expect(evidence).toEqual(expected);
          expect(manager.getSummary(id)?.status).toBe("idle");
          expect(manager.getTranscript(id).some(item => item.kind === "text" && item.role === "assistant" && item.text === JSON.stringify(expected))).toBe(true);
          expect(sourceHashes).toEqual(sourceHashes.map(({ file }) => ({ file, sha256: sourceSha256(path.join(task.cwd, file)) })));
          for (const search of searchEvidence) for (const candidate of (search as { candidates?: Candidate[] }).candidates ?? []) {
            const source = normalize(fs.readFileSync(path.join(task.cwd, candidate.file), "utf8"));
            const rows = source.split("\n").slice(candidate.excerpt.startLine - 1, candidate.excerpt.endLine);
            if (candidate.excerpt.endColumn !== undefined) rows[rows.length - 1] = rows.at(-1)!.slice(0, candidate.excerpt.endColumn - 1);
            if (candidate.excerpt.startColumn !== undefined) rows[0] = rows[0].slice(candidate.excerpt.startColumn - 1);
            expect(rows.join("\n")).toBe(normalize(candidate.excerpt.text));
            expect(candidate.excerpt.startLine).toBeGreaterThanOrEqual(candidate.startLine);
            expect(candidate.excerpt.endLine).toBeLessThanOrEqual(candidate.endLine);
          }
          reports.push({ task: task.id, strategy, purpose: task.purpose, hints: task.hints, promptSha256: sha256(taskPrompt),
            sameSettings: { tokenSavings: "balanced", model, sourceScope: task.searchDir },
            modelRequests: requests.length, modelRoundTrips: requests.length, toolRounds: toolCalls.length, elapsedMs,
            toolRoundTripMs: requestTimes.slice(1).map((time, index) => Math.round(time - requestTimes[index])),
            toolCalls, definitionReads: toolCalls.filter(call => call.name === "Read" || call.name === symbolTool && !!call.input.name).length,
            supplementalReads: Math.max(0, readAttempts - 1), toolResults: { blocks: resultBlocks, total: total(resultBlocks) },
            fullMessagesRequests: { requests, total: total(requests) }, sourceFiles: sourceHashes, searchEvidence, answer: evidence });
        } finally {
          manager.disposeAll(); server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      }
    }
    const report = { generatedAt: new Date().toISOString(), node: process.version, encoding: tokenizer ? "o200k_base" : undefined,
      hashing: "sourceFiles SHA256 hashes raw bytes; definition SHA256 hashes UTF-8 text with CRLF normalized to LF. Full definition and branch text are compared after the same line-ending normalization.",
      method: "Real bundled SDK/CLI and product MCP worker, deterministic local provider, no paid model. Provider planning uses only purpose/clues and received tool results; independent disk AST/SHA256 oracle validates all final answers. Full requests include repeated history/system/tool schema. SDK-declared usage is synthetic and excluded from measurements.",
      timing: "One observed run per arm in fixed order, with uncontrolled OS caches. elapsedMs includes CLI startup, local tools, deterministic endpoint and offline tokenization; toolRoundTripMs are intervals between provider request arrivals and include that local overhead. These are not real model/network latency measurements.",
      limitations: ["One real repository behavior plus two small negative fixtures; not a general retrieval-quality or latency claim.",
        "The deterministic endpoint models a conservative search workflow, not an autonomous LLM.",
        "Grep+symbol and purpose+symbol offer the same current symbol schema; Grep+Read omits the symbol server.",
        "All arms use balanced product output policy; offline o200k_base counts serialized requests and tool_result blocks, not provider billing/cache tokens.",
        "Function evidence establishes stale-summary guards only, not end-to-end exactly-once prompt delivery."], reports };
    console.info("Purpose code wire measurements", JSON.stringify({ encoding: report.encoding, reports: reports.map(item => {
      const row = item as { task: string; strategy: string; modelRequests: number; toolResults: { total: Size }; fullMessagesRequests: { total: Size } };
      return { task: row.task, strategy: row.strategy, modelRequests: row.modelRequests, toolResults: row.toolResults.total, fullRequests: row.fullMessagesRequests.total };
    }) }));
    if (process.env.CC_CODE_PURPOSE_REPORT) fs.writeFileSync(process.env.CC_CODE_PURPOSE_REPORT, JSON.stringify(report, null, 2));
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("cc-purpose-wire-")) throw Error("Unexpected fixture cleanup path");
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
}, 240_000);
