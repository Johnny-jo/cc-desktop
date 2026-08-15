import { createRequire } from "node:module";
import type { AgentTurn } from "./mod-game";
import type { SessionRunOpts } from "./session-manager";

export const ROOM_MOD_PREFIX = "[room_mod]";
export const ROOM_MOD_TOOL = "room_mod_act";
export const ROOM_MOD_MCP = "room-mod";
export const ROOM_MOD_ALLOWED = `mcp__${ROOM_MOD_MCP}__${ROOM_MOD_TOOL}`;

export type RoomModAct = { action: string; payload: unknown };

export type ModActionSchema = { params?: unknown; hint?: string };

export function actionNames(actions: unknown): string[] {
  if (Array.isArray(actions)) {
    const out: string[] = [];
    for (const a of actions) {
      if (typeof a === "string" && a) out.push(a);
      else if (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string") {
        out.push((a as { name: string }).name);
      }
    }
    return out;
  }
  if (actions && typeof actions === "object") return Object.keys(actions);
  return [];
}

export function toModActionMap(
  actions: unknown,
): Record<string, ModActionSchema> {
  const out: Record<string, ModActionSchema> = {};
  if (Array.isArray(actions)) {
    for (const a of actions) {
      if (typeof a === "string" && a) {
        out[a] = {};
      } else if (
        a &&
        typeof a === "object" &&
        typeof (a as { name?: unknown }).name === "string"
      ) {
        const o = a as { name: string; params?: unknown; hint?: string };
        out[o.name] = { params: o.params, hint: o.hint };
      }
    }
    return out;
  }
  if (!actions || typeof actions !== "object") return out;
  for (const [name, raw] of Object.entries(actions as Record<string, unknown>)) {
    if (!name) continue;
    if (raw && typeof raw === "object") {
      const o = raw as { params?: unknown; hint?: string };
      out[name] = { params: o.params, hint: o.hint };
    } else {
      out[name] = {};
    }
  }
  return out;
}

export function formatRoomModPrompt(turn: AgentTurn): string {
  return [
    ROOM_MOD_PREFIX,
    turn.prompt,
    "",
    "视图:",
    JSON.stringify(turn.view),
    "",
    "可选动作:",
    JSON.stringify(turn.actions),
    "",
    `请使用 ${ROOM_MOD_TOOL} 工具行动（参数 action, payload）。`,
    "若无工具，回复：",
    "```json",
    JSON.stringify({ tool: ROOM_MOD_TOOL, action: "<name>", payload: {} }),
    "```",
  ].join("\n");
}

export function parseRoomModAct(text: string): RoomModAct | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (obj.tool !== ROOM_MOD_TOOL) return null;
    if (typeof obj.action !== "string" || !obj.action) return null;
    return { action: obj.action, payload: obj.payload };
  } catch {
    return null;
  }
}

export function illegalActionMessage(actions: unknown): string {
  const names = actionNames(actions);
  return names.length
    ? `非法操作。当前合法动作: ${names.join(", ")}`
    : "非法操作。当前没有合法动作";
}

type SdkMod = {
  createSdkMcpServer?: (opts: {
    name: string;
    version?: string;
    tools: unknown[];
  }) => unknown;
  tool?: (
    name: string,
    description: string,
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

export function tryCreateRoomModMcp(handler: (act: RoomModAct) => Promise<string>): {
  opts: SessionRunOpts;
  attached: boolean;
} | null {
  const sdk = loadSdk();
  if (typeof sdk?.createSdkMcpServer !== "function" || typeof sdk.tool !== "function") {
    return null;
  }
  try {
    const actTool = sdk.tool(
      ROOM_MOD_TOOL,
      "Submit a legal action for this room seat. Parameters: action (string), payload (any).",
      {
        action: { type: "string" },
        payload: {},
      },
      async (args) => {
        const action = String(args.action ?? "");
        const text = await handler({ action, payload: args.payload });
        return { content: [{ type: "text" as const, text }] };
      },
    );
    const server = sdk.createSdkMcpServer({
      name: ROOM_MOD_MCP,
      version: "1.0.0",
      tools: [actTool],
    });
    return {
      attached: true,
      opts: {
        extraMcpServers: { [ROOM_MOD_MCP]: server },
        extraAllowedTools: [ROOM_MOD_ALLOWED, ROOM_MOD_TOOL],
      },
    };
  } catch {
    return null;
  }
}
