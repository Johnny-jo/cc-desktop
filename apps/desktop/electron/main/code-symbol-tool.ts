import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { createSdkMcpServer, SDKControlListPermissionRulesResponse } from "@anthropic-ai/claude-agent-sdk";
import { globMatch } from "@claude-desktop/shared";
import type { CodeSymbolRequest } from "./code-symbol-index";

export const SYMBOL_SERVER = "agentos-code";
export const SYMBOL_TOOL = `mcp__${SYMBOL_SERVER}__read_symbol`;
export type CodeSymbolBinding = ReturnType<typeof createCodeSymbolBinding>;

export function symbolProjectRoot(cwd: string): string | undefined {
  if (!path.isAbsolute(cwd)) return;
  try {
    const root = realpathSync.native(cwd);
    if (root === path.parse(root).root || !statSync(root).isDirectory()) return;
    for (const defaultDir of [homedir(), tmpdir()]) {
      if (!path.relative(root, defaultDir)) return;
    }
    return root;
  } catch { return; }
}

function relativePath(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && !value.includes("\u0000") &&
    !path.isAbsolute(value) && !/^[a-z]:/i.test(value) &&
    !/^[\\/]/.test(value) && !value.split(/[\\/]/).includes("..");
}

function validRequest(args: Record<string, unknown> | undefined): args is CodeSymbolRequest {
  if (!args) return false;
  if (args.purpose !== undefined) {
    return typeof args.purpose === "string" && !!args.purpose.trim() && args.purpose.length <= 2000 &&
      (args.hints === undefined || (Array.isArray(args.hints) && args.hints.length <= 8 &&
        args.hints.every(hint => typeof hint === "string" && !!hint.trim() && hint.length <= 120))) &&
      (args.scope === undefined || relativePath(args.scope)) &&
      Object.keys(args).every(key => ["purpose", "hints", "scope"].includes(key));
  }
  return typeof args.name === "string" && !!args.name.trim() &&
    (args.file === undefined || relativePath(args.file)) &&
    (args.line === undefined || (Number.isSafeInteger(args.line) && Number(args.line) >= 1)) &&
    (args.column === undefined || (args.line !== undefined && Number.isSafeInteger(args.column) && Number(args.column) >= 1)) &&
    (args.callOffset === undefined || (Number.isSafeInteger(args.callOffset) && Number(args.callOffset) >= 0)) &&
    Object.keys(args).every(key => ["name", "file", "line", "column", "callOffset"].includes(key));
}

// Even a file-qualified lookup can read other files to resolve imports and calls.
// A restricted Read/Glob/Grep cannot be translated into a project-wide compiler read.
function restrictsLookup(rule: string, behavior: "deny" | "ask", hiddenPathsExcluded: boolean) {
  // The index never descends into a dot directory or reads a dot file.
  // Only recognize these hidden-path patterns; leave other globs to the SDK.
  if (hiddenPathsExcluded &&
    /^(?:Read|FileRead|Glob|Grep)\((?:\.\/|\*\*\/)?\.[\w-][\w.-]*(?:\*|\/\*\*)?\)$/.test(rule)) return false;
  const tool = rule.split("(", 1)[0].trim();
  const targets = ["Read", "FileRead", "Glob", "Grep"];
  if (behavior === "deny") targets.push(`mcp__${SYMBOL_SERVER}`, SYMBOL_TOOL);
  return targets.some(target => globMatch(tool, target));
}

export function createCodeSymbolBinding(options: {
  root: string;
  requestedRoot?: string;
  isActive: () => boolean;
  listRules: () => Promise<SDKControlListPermissionRulesResponse | undefined>;
  desktopDeny: () => string[];
}) {
  // Load MCP and the SDK only for a project query that actually offers this tool.
  const req = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
  const sdk = req("@anthropic-ai/claude-agent-sdk") as { createSdkMcpServer: typeof createSdkMcpServer };
  const { ListToolsRequestSchema, CallToolRequestSchema } =
    createRequire(req.resolve("@anthropic-ai/claude-agent-sdk"))("@modelcontextprotocol/sdk/types.js");
  const server = sdk.createSdkMcpServer({ name: SYMBOL_SERVER, tools: [] });
  server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "read_symbol",
    description: "Find TypeScript/JavaScript code by purpose, or read an exact symbol's full definition and static call sites. " +
      "For discovery provide purpose plus code hints (identifiers, config keys, error text); local lexical search returns up to 3 candidates with evidence. " +
      "Expand a candidate with name, file, line and optionally column. Use either purpose mode or name mode. Continue call sites with callOffset.",
    // Keep a flat schema with explicit required for the bundled CLI's SDK tool
    // conversion. validRequest, rather than a schema union, enforces the modes.
    inputSchema: { type: "object", additionalProperties: false, required: [], properties: {
      name: { type: "string", minLength: 1 }, file: { type: "string", description: "Project-relative source file" },
      line: { type: "integer", minimum: 1, description: "1-based declaration line" },
      column: { type: "integer", minimum: 1, description: "1-based candidate startColumn on that line" },
      callOffset: { type: "integer", minimum: 0 },
      purpose: { type: "string", minLength: 1, maxLength: 2000, description: "Behavior to locate; exclusive with name/file/line/column/callOffset" },
      hints: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 120 }, description: "Optional code terms for purpose mode; use concrete technical clues for Chinese requests" },
      scope: { type: "string", minLength: 1, description: "Optional project-relative directory for purpose mode" },
    } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }] }));

  const lifetime = new AbortController();
  let paused: symbol | undefined;
  let turn = new AbortController();
  const cancelPending = () => { turn.abort(); turn = new AbortController(); };
  const hiddenPathsExcluded = !path.relative(options.root, options.requestedRoot ?? options.root) &&
    !path.resolve(options.root).split(path.sep).some(segment => segment.startsWith("."));
  const canRead = async () => {
    const live = (await options.listRules())?.state;
    return Array.isArray(live?.rules) && !live.errors?.length &&
      !live.rules.some(row => !row.notInEffect && row.behavior !== "allow" && restrictsLookup(row.rule, row.behavior, hiddenPathsExcluded)) &&
      !options.desktopDeny().some(rule => restrictsLookup(rule, "deny", hiddenPathsExcluded));
  };
  const error = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
  const denied = () => error("Project-wide symbol lookup is unavailable under the current read permissions or session. Use Read or Grep.");
  server.instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> };
    if (name !== "read_symbol" || !validRequest(args)) return error("Invalid read_symbol arguments.");
    const signal = AbortSignal.any([lifetime.signal, turn.signal, extra.signal]);
    const active = () => !paused && !signal.aborted && options.isActive();
    try {
      if (!active() || !await canRead() || !active()) return denied();
      const { runCodeSymbolLookup } = await import("./code-symbol-runner");
      if (!active()) return denied();
      const result = await runCodeSymbolLookup(options.root, args, signal);
      if (!active() || !await canRead() || !active()) return denied();
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch { return error("Symbol lookup unavailable. Use Read or Grep."); }
  });
  return {
    server, cancelPending, revoke: () => lifetime.abort(),
    suspend() {
      const toggle = Symbol();
      paused = toggle;
      cancelPending();
      return () => { if (paused === toggle) paused = undefined; };
    },
  };
}
