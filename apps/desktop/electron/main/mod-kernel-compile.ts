import { createRequire } from "node:module";
import type { RoomKv } from "./mod-kernel";
import type { SessionRunOpts } from "./session-manager";

export const MEMORY_MCP = "mod-memory";
export const MEMORY_TOOLS = ["memory_get", "memory_set", "memory_list", "memory_search"] as const;

type SdkMod = {
  createSdkMcpServer?: (opts: {
    name: string;
    version: string;
    tools: unknown[];
  }) => unknown;
  tool?: (
    name: string,
    desc: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) => unknown;
};

function loadSdk(): SdkMod | null {
  try {
    const require = createRequire(
      typeof __filename !== "undefined" ? __filename : process.cwd() + "/index.js",
    );
    return require("@anthropic-ai/claude-agent-sdk") as SdkMod;
  } catch {
    return null;
  }
}

export function mergeSessionRunOpts(
  a: SessionRunOpts,
  b: SessionRunOpts,
): SessionRunOpts {
  const servers = { ...(a.extraMcpServers ?? {}), ...(b.extraMcpServers ?? {}) };
  const tools = [
    ...new Set([...(a.extraAllowedTools ?? []), ...(b.extraAllowedTools ?? [])]),
  ];
  return {
    ...a,
    ...b,
    extraMcpServers: Object.keys(servers).length ? servers : undefined,
    extraAllowedTools: tools.length ? tools : undefined,
  };
}

export function tryCreateMemoryMcp(kv: RoomKv): SessionRunOpts | null {
  const sdk = loadSdk();
  if (typeof sdk?.createSdkMcpServer !== "function" || typeof sdk.tool !== "function") {
    return null;
  }
  const ns = kv.namespace("memory");
  try {
    const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
    const get = sdk.tool(
      "memory_get",
      "Read a room-shared memory value by key.",
      { key: { type: "string" } },
      async (args) => text(ns.get(String(args.key ?? "")) ?? ""),
    );
    const set = sdk.tool(
      "memory_set",
      "Write a room-shared memory string.",
      { key: { type: "string" }, value: { type: "string" } },
      async (args) => {
        const result = ns.set(String(args.key ?? ""), String(args.value ?? ""));
        return text(result.ok ? "ok" : result.error);
      },
    );
    const list = sdk.tool(
      "memory_list",
      "List room-shared memory keys, optionally by prefix.",
      { prefix: { type: "string" } },
      async (args) =>
        text(JSON.stringify(ns.list(args.prefix ? String(args.prefix) : undefined))),
    );
    const search = sdk.tool(
      "memory_search",
      "Search room-shared memory keys and values.",
      { query: { type: "string" } },
      async (args) => text(JSON.stringify(ns.search(String(args.query ?? "")))),
    );
    const server = sdk.createSdkMcpServer({
      name: MEMORY_MCP,
      version: "1.0.0",
      tools: [get, set, list, search],
    });
    return {
      extraMcpServers: { [MEMORY_MCP]: server },
      extraAllowedTools: [
        ...MEMORY_TOOLS,
        ...MEMORY_TOOLS.map((t) => `mcp__${MEMORY_MCP}__${t}`),
      ],
    };
  } catch {
    return null;
  }
}
