import { createRequire } from "node:module";
import type { RoomKv } from "./mod-kernel";
import type { SessionRunOpts } from "./session-manager";

export const MEMORY_MCP = "mod-memory";
export const MEMORY_TOOLS = ["memory_get", "memory_set", "memory_list", "memory_search"] as const;

export const IMPROVE_MCP = "mod-improve";
export const IMPROVE_TOOLS = [
  "kernel_list",
  "kernel_get_source",
  "kernel_propose",
  "kernel_status",
  "kernel_rollback",
] as const;

export type KernelImproveHost = {
  list(): Array<{
    id: string;
    name?: string;
    version: string;
    inject: string[];
    provides: string[];
    permissions: string[];
    hooks: string[];
    state: string;
    pendingReason?: string;
    failedReason?: string;
  }>;
  getSource(packId: string): string | null;
  propose(
    packId: string,
    modJs: string,
    note?: string,
  ): { ok: boolean; decision?: string; status?: string; error?: string };
  status(): {
    autonomy: 0 | 1 | 2;
    proposals: Array<{
      id: string;
      packId: string;
      status: string;
      decision: string;
      note?: string;
      error?: string;
      at: number;
    }>;
    canRollback: string[];
  };
  rollback(packId: string): { ok: boolean; error?: string };
};

type SdkMod = {
  createSdkMcpServer?: (opts: {
    name: string;
    version: string;
    tools: unknown[];
    alwaysLoad?: boolean;
  }) => unknown;
  tool?: (
    name: string,
    desc: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) => unknown;
};

type ZodMod = {
  string: () => unknown;
};

function sdkRequire() {
  return createRequire(
    typeof __filename !== "undefined" ? __filename : process.cwd() + "/index.js",
  );
}

function loadSdk(): SdkMod | null {
  try {
    return sdkRequire()("@anthropic-ai/claude-agent-sdk") as SdkMod;
  } catch {
    return null;
  }
}

function loadZod(): ZodMod | null {
  try {
    const req = sdkRequire();
    return createRequire(req.resolve("@anthropic-ai/claude-agent-sdk"))("zod") as ZodMod;
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
  const z = loadZod();
  if (
    typeof sdk?.createSdkMcpServer !== "function" ||
    typeof sdk.tool !== "function" ||
    typeof z?.string !== "function"
  ) {
    return null;
  }
  const ns = kv.namespace("memory");
  try {
    const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
    const str = z.string();
    const get = sdk.tool(
      "memory_get",
      "Read a room-shared memory value by key. Use this for facts this room already stored.",
      { key: str },
      async (args) => text(ns.get(String(args.key ?? "")) ?? ""),
    );
    const set = sdk.tool(
      "memory_set",
      "Write a room-shared memory string. Persist facts other seats and later turns should recall.",
      { key: str, value: str },
      async (args) => {
        const result = ns.set(String(args.key ?? ""), String(args.value ?? ""));
        return text(result.ok ? "ok" : result.error);
      },
    );
    const list = sdk.tool(
      "memory_list",
      "List room-shared memory keys, optionally by prefix.",
      { prefix: str },
      async (args) =>
        text(JSON.stringify(ns.list(args.prefix ? String(args.prefix) : undefined))),
    );
    const search = sdk.tool(
      "memory_search",
      "Search room-shared memory keys and values.",
      { query: str },
      async (args) => text(JSON.stringify(ns.search(String(args.query ?? "")))),
    );
    const server = sdk.createSdkMcpServer({
      name: MEMORY_MCP,
      version: "1.0.0",
      alwaysLoad: true,
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

export function tryCreateImproveMcp(host: KernelImproveHost): SessionRunOpts | null {
  const sdk = loadSdk();
  const z = loadZod();
  if (
    typeof sdk?.createSdkMcpServer !== "function" ||
    typeof sdk.tool !== "function" ||
    typeof z?.string !== "function"
  ) {
    return null;
  }
  try {
    const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
    const str = z.string();
    const list = sdk.tool(
      "kernel_list",
      "List room kernel extensions currently loaded (id, manifest boundary, state). Guests never run this code. Use before proposing a new mod.js.",
      {},
      async () => text(JSON.stringify(host.list())),
    );
    const getSource = sdk.tool(
      "kernel_get_source",
      "Read the live mod.js of one loaded kernel pack. You may only rewrite this file; inject/provides/permissions/hooks stay on the current manifest.",
      { pack_id: str },
      async (args) => {
        const src = host.getSource(String(args.pack_id ?? ""));
        return text(src ?? "pack not loaded");
      },
    );
    const propose = sdk.tool(
      "kernel_propose",
      "Propose a same-boundary mod.js replacement. Do not send a new manifest. Trial runs in a sandbox; L0 parks for the host, L1 auto-applies if provides stay the same, L2 applies after trial. Returns decision/status/error.",
      { pack_id: str, mod_js: str, note: str },
      async (args) => {
        const note = String(args.note ?? "").trim();
        const result = host.propose(
          String(args.pack_id ?? ""),
          String(args.mod_js ?? ""),
          note || undefined,
        );
        return text(JSON.stringify(result));
      },
    );
    const status = sdk.tool(
      "kernel_status",
      "Read improve autonomy (0/1/2), proposal ids/status (no source), and pack ids that can roll back.",
      {},
      async () => text(JSON.stringify(host.status())),
    );
    const rollback = sdk.tool(
      "kernel_rollback",
      "Restore the previous mod.js for a pack after an applied improve. Fails if there is no revision.",
      { pack_id: str },
      async (args) => text(JSON.stringify(host.rollback(String(args.pack_id ?? "")))),
    );
    const server = sdk.createSdkMcpServer({
      name: IMPROVE_MCP,
      version: "1.0.0",
      alwaysLoad: true,
      tools: [list, getSource, propose, status, rollback],
    });
    return {
      extraMcpServers: { [IMPROVE_MCP]: server },
      extraAllowedTools: [
        ...IMPROVE_TOOLS,
        ...IMPROVE_TOOLS.map((t) => `mcp__${IMPROVE_MCP}__${t}`),
      ],
    };
  } catch {
    return null;
  }
}
