import { createRequire } from "node:module";
import type { SessionRunOpts } from "./session-manager";

export type RoomAgentMessage = {
  requestId: string;
  mode: "notify" | "delegate";
  targetSeatId: string;
  text: string;
  readOnly?: boolean;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type SdkMod = {
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => unknown;
  createSdkMcpServer: (opts: {
    name: string;
    version: string;
    alwaysLoad: boolean;
    tools: unknown[];
  }) => {
    instance: {
      server: {
        setRequestHandler: <T>(
          schema: unknown,
          handler: (request: {
            params: { name: string; arguments?: unknown };
          }) => Promise<T>,
        ) => void;
      };
    };
  };
};

// Structural types keep Zod resolved from the SDK, as in room-mod-agent.ts.
type Schema<T> = { parse(input: unknown): T; describe(text: string): Schema<T> };
type StringSchema = Schema<string> & {
  min(length: number): StringSchema;
  max(length: number): StringSchema;
  regex(pattern: RegExp, message: string): StringSchema;
};
type ObjectSchema<T> = Schema<T> & { strict(): ObjectSchema<T> };
type ZodMod = {
  string(): StringSchema;
  boolean(): Schema<boolean> & { default(value: boolean): Schema<boolean> };
  enum<T extends string>(values: [T, ...T[]]): Schema<T>;
  object<T extends Record<string, Schema<unknown>>>(shape: T): ObjectSchema<{
    [K in keyof T]: T[K] extends Schema<infer V> ? V : never;
  }>;
  toJSONSchema(schema: unknown, options: { io: "input" }): Record<string, unknown>;
};

function sdkRequire() {
  return createRequire(
    typeof __filename !== "undefined" ? __filename : process.cwd() + "/index.js",
  );
}

function loadZod(): ZodMod {
  const req = sdkRequire();
  return createRequire(req.resolve("@anthropic-ai/claude-agent-sdk"))("zod") as ZodMod;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "Unknown room-chat error";
}

function jsonResult(value: unknown, isError = false): ToolResult {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("room-chat handler returned no JSON value");
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** Bound handlers own identity, authorization and requestId deduplication. */
export function createRoomChatMcp(handlers: {
  members: () => unknown | Promise<unknown>;
  message: (input: RoomAgentMessage) => Promise<{ ok: boolean; error?: string; value?: unknown }>;
}): SessionRunOpts {
  try {
    const req = sdkRequire();
    const sdk = req("@anthropic-ai/claude-agent-sdk") as SdkMod;
    const z = loadZod();
    const { CallToolRequestSchema, ListToolsRequestSchema } = createRequire(
      req.resolve("@anthropic-ai/claude-agent-sdk"),
    )("@modelcontextprotocol/sdk/types.js") as {
      CallToolRequestSchema: unknown;
      ListToolsRequestSchema: unknown;
    };
    if (
      typeof sdk?.tool !== "function" ||
      typeof sdk?.createSdkMcpServer !== "function" ||
      typeof z?.object !== "function" ||
      typeof z?.toJSONSchema !== "function" ||
      !CallToolRequestSchema ||
      !ListToolsRequestSchema
    ) {
      throw new Error("Required Agent SDK / Zod / MCP APIs are unavailable");
    }

    const boundedText = (max: number) => z.string().min(1).max(max)
      .regex(/\S/, "Must contain a non-whitespace character");
    const membersShape = {};
    const messageShape = {
      requestId: boundedText(128).describe("Idempotency key. Reuse for retries of the same request; max 128 characters."),
      mode: z.enum(["notify", "delegate"]).describe("notify sends a notice; delegate requests work from the target seat."),
      targetSeatId: boundedText(128).describe("Exact member ID returned by room_members; max 128 characters."),
      text: boundedText(8000).describe("Literal message or task text, max 8000 characters. Mentions in this text are not routed."),
      readOnly: z.boolean().default(false).describe("Request read-only work when delegating. Defaults to false; host permissions still apply."),
    };
    const membersSchema = z.object(membersShape).strict();
    const messageSchema = z.object(messageShape).strict();

    async function invoke(name: string, args: unknown): Promise<ToolResult> {
      try {
        const input = args === undefined ? {} : args;
        if (name === "room_members") {
          membersSchema.parse(input);
          return jsonResult(await handlers.members());
        }
        if (name === "room_message") {
          const result = await handlers.message(messageSchema.parse(input));
          return jsonResult(result, !result.ok);
        }
        throw new Error(`Unknown room-chat tool: ${name}`);
      } catch (error) {
        return jsonResult({ ok: false, error: errorText(error) }, true);
      }
    }

    const definitions = [
      {
        name: "room_members",
        description: "List the current room members, including their IDs, types and names. No arguments; room and caller identity are bound by the host.",
        shape: membersShape,
        schema: membersSchema,
      },
      {
        name: "room_message",
        description: "Notify a room member or delegate a task using an explicit targetSeatId. Returns JSON with ok, optional error/value. Reuse requestId on retry. Never supply roomId, sourceSeatId or initiatorUserId; identity and permissions are bound by the host.",
        shape: messageShape,
        schema: messageSchema,
      },
    ];
    const server = sdk.createSdkMcpServer({
      name: "room-chat",
      version: "1.0.0",
      alwaysLoad: true,
      tools: definitions.map(({ name, description, shape }) =>
        sdk.tool(name, description, shape, (args) => invoke(name, args)),
      ),
    });

    // The bundled SDK converter loses checks/descriptions from the installed
    // Zod 4 schemas. Generate the advertised schemas with that same Zod version.
    const tools = definitions.map(({ name, description, schema }) => ({
      name,
      description,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
      _meta: { "anthropic/alwaysLoad": true },
    }));
    server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    // The SDK's raw-shape validator strips unknown keys and emits plain-text
    // validation errors. Use the public protocol handler to validate the original
    // arguments strictly and return JSON errors.
    server.instance.server.setRequestHandler(CallToolRequestSchema, (request) =>
      invoke(request.params.name, request.params.arguments),
    );

    return {
      extraMcpServers: { "room-chat": server },
      extraAllowedTools: [
        "mcp__room-chat__room_members",
        "mcp__room-chat__room_message",
      ],
    };
  } catch (error) {
    throw new Error(`Unable to initialize room-chat MCP: ${errorText(error)}`, { cause: error });
  }
}
