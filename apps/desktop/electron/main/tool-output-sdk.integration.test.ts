import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { SessionManager } from "./session-manager";
import { SettingsStore } from "./settings-store";
import { DiffTracker } from "./diff-tracker";
import type { ModelRuntime } from "./model-runtime";
import { PermissionBroker } from "./permission-broker";
import { RESULT_TOOL } from "./tool-output-policy";

const model = "claude-sonnet-4-6";
const browser = "mcp__browser__browser_console_messages";
const middle = "MIDDLE-SENTINEL";
const shellOutput = "SHELL-START\n" + "A".repeat(9000) + "\nSHELL-MIDDLE\n" + "B".repeat(9000) + "\nSHELL-END";
const consoleOutput = "### Result\nTotal messages: 1 (Errors: 0, Warnings: 0)\n\n[LOG] HEAD " +
  "A".repeat(6000) + middle + "B".repeat(6000) + " TAIL @ about:blank:1";
const consoleTool = { name: "browser_console_messages", description: "Read fixture logs", inputSchema: { type: "object", properties: {} } };

type ToolCall = { name: string; input: Record<string, unknown> };
function reply(res: http.ServerResponse, index: number, call?: ToolCall) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type: string, data: object) => res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n");
  const message = { type: "message", role: "assistant", id: "msg_" + index, model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } };
  event("message_start", { message });
  const content_block = call ? { type: "tool_use", id: "toolu_" + index, name: call.name, input: {} } : { type: "text", text: "" };
  event("content_block_start", { index: 0, content_block });
  event("content_block_delta", { index: 0, delta: call ?
    { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: middle } });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  event("message_stop", {}); res.end();
}

// Opt in with CC_TEST_BUNDLED_SDK=1. No real model, browser profile or application data.
it.runIf(process.env.CC_TEST_BUNDLED_SDK === "1")("compares the actual Messages shell/browser results and reads an archived page", async () => {
  const usePowerShell = process.env.CC_TOOL_OUTPUT_SHELL === "PowerShell";
  const shellName = usePowerShell ? "PowerShell" : "Bash";
  const command = usePowerShell ? "Get-Content -Raw -LiteralPath fixture.txt" : "cat fixture.txt";
  const executable = path.resolve("../../vendor/win-x64/claude/claude.exe");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tool-wire-"));
  const fixture = path.join(dir, "fixture.cjs");
  fs.writeFileSync(path.join(dir, "fixture.txt"), shellOutput);
  // Only replace the browser transport. Exercise the production SessionManager's
  // options, real stdio MCP result parsing, hook, SDK reader and permissions.
  fs.writeFileSync(fixture, `const rl = require("node:readline").createInterface({ input: process.stdin });
    rl.on("line", line => { const x = JSON.parse(line); if (x.id == null) return;
      const result = x.method === "initialize" ? { protocolVersion: x.params.protocolVersion, capabilities: { tools: {} }, serverInfo: {name:"browser",version:"1"} }
        : x.method === "tools/list" ? {tools:[${JSON.stringify(consoleTool)}]}
        : x.method === "tools/call" ? {content:[{type:"text",text:${JSON.stringify(consoleOutput)}}]} : {};
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:x.id,result})+"\\n"); });`);
  const reports = [];
  try {
    for (const mode of ["standard", "balanced"] as const) {
      let calls = 0;
      let shell = "", browserText = "", page = "";
      let errors: unknown;
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        if (req.url?.startsWith("/v1/messages/count_tokens")) {
          res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":100}');
          return;
        }
        if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const last = body.messages.at(-1).content;
          const result = Array.isArray(last) && last.find(block => block.type === "tool_result");
          const text = typeof result?.content === "string" ? result.content : result?.content[0].text ?? "";
          if (result?.is_error) throw Error(text);
          let next: ToolCall | undefined;
          calls++;
          if (calls === 1) {
            if (!body.tools.some((tool: { name: string }) => tool.name === shellName)) throw Error(shellName + " unavailable in bundled CLI");
            next = { name: shellName, input: { command } };
          }
          if (calls === 2) { shell = text; next = { name: browser, input: {} }; }
          if (calls === 3) {
            browserText = text;
            if (mode === "balanced") {
              const match = /with handle ([\da-f-]{36})/.exec(text);
              if (!match) throw Error("Missing archive handle in browser tool result");
              next = { name: RESULT_TOOL, input: { handle: match[1], offset: consoleOutput.indexOf(middle), limit: middle.length } };
            }
          }
          if (calls === 4) page = JSON.parse(text.trim()).text;
          reply(res, calls, next);
        } catch (error) { errors = error; reply(res, calls); }
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Missing loopback port");
      const root = path.join(dir, mode);
      fs.mkdirSync(root);
      const settings = new SettingsStore({ userDataDir: root, encrypt: s => s, decrypt: s => s });
      settings.update({ defaultModel: model, models: [model], tokenSavings: { mode },
        mcpServers: { browser: { type: "playwright", browser: "chrome", connection: "isolated" } } });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(path|systemroot|windir|comspec|pathext|temp|tmp|programfiles|localappdata|programfiles\(x86\))$/i.test(key))) as Record<string, string>;
      const status = { state: "ready", port: address.port, managedByApp: false } as const;
      const cpa: ModelRuntime = {
        ensureReady: async () => status, getStatus: () => status, getProxyTarget: () => null,
        listModelCatalog: async () => [], getModelCatalog: () => [], getModelQuota: async () => null,
        mergeSdkModelCapabilities() {}, stopIfManaged() {},
        buildProcessEnv: () => ({ ...env, USERPROFILE: root, HOME: root, CLAUDE_CONFIG_DIR: root,
          ...(usePowerShell ? { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" } : {}),
          ANTHROPIC_BASE_URL: "http://127.0.0.1:" + address.port, ANTHROPIC_AUTH_TOKEN: "fixture-only",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false" }),
      };
      const manager = new SessionManager({ cpa, settings, diffTracker: new DiffTracker(), toolOutputDatabasePath: path.join(root, "tools.sqlite3"),
        permissionBroker: new PermissionBroker({ getMode: () => "default", requestFromUi() { throw Error("Unexpected fixture permission request"); } }),
        claudeExecutablePath: executable, emit() {}, emitSession() {}, emitDiff() {},
        queryFn: ({ prompt, options }) => {
          const opts = options as NonNullable<Parameters<typeof query>[0]["options"]>;
          return query({ prompt: prompt as Parameters<typeof query>[0]["prompt"], options: {
            ...opts, allowedTools: [...opts.allowedTools ?? [], browser, shellName + "(" + command + ")"], settingSources: [],
            mcpServers: { ...opts.mcpServers, browser: { command: process.execPath, args: [fixture] } },
          } });
        },
      });
      try {
        const session = await manager.start({ text: "Find the middle fixture marker", attachments: [] }, dir);
        expect(errors).toBeUndefined();
        expect(manager.getSummary(session)?.status).toBe("idle");
        expect(shell).toContain("SHELL-START");
        expect(shell.includes("SHELL-MIDDLE")).toBe(mode === "standard");
        expect(browserText).toContain("HEAD"); expect(browserText).toContain("TAIL");
        expect(browserText.includes(middle)).toBe(mode === "standard");
        if (mode === "balanced") {
          expect(page).toBe(middle);
          const card = manager.getTranscript(session).find(item => item.kind === "tool" && item.tool.name === browser);
          expect(card?.kind === "tool" && card.tool.outputHandle).toBe(/with handle ([\da-f-]{36})/.exec(browserText)?.[1]);
        }
        expect(calls).toBe(mode === "balanced" ? 4 : 3);
        reports.push({ mode, shellName, messagesRequests: calls, toolCalls: calls - 1, shellResultChars: shell.length,
          browserResultChars: browserText.length, recoveredPageChars: page.length });
      } finally {
        manager.disposeAll();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
    console.info("SDK tool-output fixture", JSON.stringify(reports));
  } finally {
    // Windows releases the CLI's cwd after the async child-process close event.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
}, 90_000);
