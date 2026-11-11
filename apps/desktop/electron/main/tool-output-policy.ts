import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { McpServersMap } from "@claude-desktop/shared";
import type { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { MAX_PAGE_CHARS, type ToolOutputStore } from "./tool-output-store";

export const RESULT_SERVER = "agentos-results";
export const RESULT_TOOL = `mcp__${RESULT_SERVER}__result_read`;

export function shellOutputBudget(cwd: string, env: Record<string, string>) {
  let budget = 16000;
  const user = env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || env.HOME || homedir(), ".claude");
  const folders = new Set([path.resolve(cwd)]);
  let folder = path.resolve(cwd);
  while (folder !== path.dirname(folder)) {
    if (existsSync(path.join(folder, ".git"))) { folders.add(folder); break; }
    folder = path.dirname(folder);
  }
  const files = [path.join(user, "settings.json")];
  for (const root of folders) files.push(path.join(root, ".claude/settings.json"), path.join(root, ".claude/settings.local.json"));
  for (const file of files) {
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) return undefined;
      const configured = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")).bashOutputMaxChars;
      if (Number.isSafeInteger(configured)) budget = Math.min(budget, Math.max(4000, configured));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // If the SDK accepts a config syntax this reader cannot parse, let it
      // resolve the budget itself rather than shadow a user's lower setting.
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }
  }
  return budget;
}

const threshold = 8000;
const previewEdge = 1200;
const protectedText = /\[ref[=:\s]|\be\d+\b|\b(?:ref|refs|sceneId|targetId|observationId|nextCursor|executed|verification|isError|persistedOutputPath|rawOutputPath)["']?\s*[:=]|\]\(|data:(?:image|audio)\/|<persisted-output>|\b(?:cancelled|canceled|aborted)\b|(?:^|\n)(?:diff --git |@@ |\x60\x60\x60)/i;
const resultHeading = "### Result\n";

export function compactBrowserResult(tool: string, output: unknown, save: (text: string) => string | undefined) {
  // CLI 2.1.318 presents successful MCP content as an array to PostToolUse.
  if (!Array.isArray(output) || output.length !== 1) return;
  const block = output[0];
  if (block?.type !== "text" || typeof block.text !== "string" || Object.keys(block).length !== 2) return;
  const full: string = block.text;
  if (full.length <= threshold || !full.startsWith(resultHeading)) return;
  const codeAt = full.indexOf("\n### Ran Playwright code\n");
  const body = full.slice(resultHeading.length, codeAt < 0 ? undefined : codeAt);
  const suffix = codeAt < 0 ? "" : full.slice(codeAt);
  if (/^### /m.test(body) || protectedText.test(body) || suffix.split("\n### ").length > 2) return;
  if (suffix && (!/^\n### Ran Playwright code\n\x60{3}\w+\n[\s\S]+\n\x60{3}$/.test(suffix) ||
    protectedText.test(suffix.replace(/^\x60{3}.*$/gm, "")))) return;

  let text: string;
  switch (tool) {
    case "browser_console_messages":
      if (suffix || !/^Total messages: \d+ \(Errors: 0, Warnings: 0\)\n(?:Returning \d+ messages for level "(?:debug|info|warning|error)"\n)?\n\[(?:LOG|DEBUG|INFO|TRACE)\] /.test(body)) return;
      text = body;
      break;
    case "browser_evaluate":
      // Objects, snapshots, code blocks and multi-part results keep their original representation.
      try {
        const value: unknown = JSON.parse(body);
        if (typeof value !== "string" || value.length <= threshold || protectedText.test(value) ||
          /^\s*[\[{]/.test(value) || /(?:^|\n)\s*(?:diff --git |@@ |\x60\x60\x60)/.test(value)) return;
        text = value;
      } catch { return; }
      break;
    default: return;
  }
  try {
    const handle = save(full);
    if (!handle) return;
    const preview = text.slice(0, previewEdge) +
      `\n[… Full tool output: ${full.length} UTF-16 characters. Use ${RESULT_TOOL} with handle ${handle}.]\n` +
      text.slice(-previewEdge);
    return [{ type: "text" as const, text: resultHeading + preview + suffix }];
  } catch { return; }
}

export type ToolOutputBinding = ReturnType<typeof createToolOutputBinding>;
type ServerFactory = typeof createSdkMcpServer;
const sdkRequire = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

/** All caller identity comes from the SessionManager closure. The MCP accepts no paths or session IDs. */
export function createToolOutputBinding(options: {
  store: ToolOutputStore; sessionId: string; sources: Set<string>; retained: Map<string, string>; isActive: () => boolean;
}) {
  const { store, sessionId, sources, isActive } = options;
  const grants = new Map(options.retained);
  const pending = new Map<string, string>();
  const sdk = sdkRequire("@anthropic-ai/claude-agent-sdk") as { createSdkMcpServer: ServerFactory };
  const { ListToolsRequestSchema, CallToolRequestSchema } = createRequire(
    sdkRequire.resolve("@anthropic-ai/claude-agent-sdk"),
  )("@modelcontextprotocol/sdk/types.js");
  const server = sdk.createSdkMcpServer({ name: RESULT_SERVER, tools: [] });
  server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "result_read", description: "Read a page of complete archived tool text using a handle from this conversation. Offsets count UTF-16 characters.",
    inputSchema: { type: "object", additionalProperties: false, required: ["handle"], properties: {
      handle: { type: "string", format: "uuid" }, offset: { type: "integer", minimum: 0, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_CHARS, default: MAX_PAGE_CHARS },
    } }, annotations: { readOnlyHint: true },
  }] }));
  let enabled = true;
  const active = () => enabled && isActive();
  server.instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params as { name: string; arguments?: Record<string, unknown> };
    const args = params.arguments;
    const failure = { isError: true, content: [{ type: "text", text: "Result unavailable or invalid page." }] };
    if (!active() || params.name !== "result_read" || !args || typeof args.handle !== "string" ||
      !/^[\da-f-]{36}$/.test(args.handle) || Object.keys(args).some(k => !["handle", "offset", "limit"].includes(k))) return failure;
    const { offset = 0, limit = MAX_PAGE_CHARS } = args;
    if (typeof offset !== "number" || typeof limit !== "number") return failure;
    try {
      const call = grants.get(args.handle);
      if (!call) return failure;
      const page = store.read(sessionId, call, args.handle, offset, limit);
      return page ? { content: [{ type: "text", text: JSON.stringify(page) }] } : failure;
    } catch { return failure; }
  });
  return {
    server, sources, revoke: () => { enabled = false; grants.clear(); pending.clear(); }, active,
    takeOutputHandle(call: string) {
      const handle = pending.get(call);
      pending.delete(call);
      return handle;
    },
    post: async (input: {
      tool_name?: string; tool_use_id?: string; mcp_server?: { name: string; source: string }; tool_response?: unknown; agent_id?: string;
    }, _id?: string, hook?: { signal?: AbortSignal }) => {
      const provenance = input.mcp_server;
      if (!active() || input.agent_id || hook?.signal?.aborted || !provenance ||
        !["sdk", "dynamic"].includes(provenance.source) || !sources.has(provenance.name)) return {};
      const prefix = `mcp__${provenance.name}__`;
      const call = input.tool_use_id;
      if (!call || !input.tool_name?.startsWith(prefix)) return {};
      const updated = compactBrowserResult(input.tool_name.slice(prefix.length), input.tool_response, text => {
        const handle = store.save(sessionId, call, text);
        if (handle) { pending.set(call, handle); grants.set(handle, call); }
        return handle;
      });
      return updated ? { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: updated } } : {};
    },
  };
}

export function browserOutputSources(servers: McpServersMap, extras: Record<string, unknown>) {
  return new Set(Object.entries(servers).filter(([name, config]) =>
    config.type === "playwright" && !(name in extras) && /^[a-zA-Z0-9_-]+$/.test(name),
  ).map(([name]) => name));
}
