import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomChatMcp, type RoomAgentMessage } from "./room-chat-agent";

// Resolve the real MCP client from the Agent SDK's dependency tree (pnpm).
const localRequire = createRequire(import.meta.url);
const sdkRequire = createRequire(localRequire.resolve("@anthropic-ai/claude-agent-sdk"));
type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type TestClient = {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  getServerVersion(): { name: string; version: string } | undefined;
  listTools(): Promise<{
    tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
  }>;
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResult>;
};
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js") as {
  Client: new (info: { name: string; version: string }) => TestClient;
};
const { InMemoryTransport } = sdkRequire("@modelcontextprotocol/sdk/inMemory.js") as {
  InMemoryTransport: { createLinkedPair(): [unknown, unknown] };
};
type TestServer = {
  type: string;
  name: string;
  instance: { connect(transport: unknown): Promise<void>; close(): Promise<void> };
};
type Handlers = Parameters<typeof createRoomChatMcp>[0];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.doUnmock("node:module");
  vi.resetModules();
});

async function connect(handlers: Partial<Handlers> = {}) {
  const messages: RoomAgentMessage[] = [];
  const opts = createRoomChatMcp({
    members: () => [],
    message: async (input) => {
      messages.push(input);
      return { ok: true, value: { messageId: "message-1" } };
    },
    ...handlers,
  });
  const server = opts.extraMcpServers?.["room-chat"] as TestServer;
  expect(server?.type).toBe("sdk");
  expect(server?.name).toBe("room-chat");
  const client = new Client({ name: "room-chat-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => {
    await client.close();
    await server.instance.close();
  });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, opts, messages };
}

function json(result: ToolResult): unknown {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  expect(typeof result.content[0].text).toBe("string");
  return JSON.parse(result.content[0].text!);
}

function expectError(result: ToolResult, error?: string) {
  expect(result.isError).toBe(true);
  expect(json(result)).toEqual({
    ok: false,
    error: error ?? expect.any(String),
  });
  expect((json(result) as { error: string }).error.length).toBeGreaterThan(0);
}

const validInput = {
  requestId: "request-1",
  mode: "notify" as const,
  targetSeatId: "agent-1",
  text: "请查看这里的消息。",
};

describe("room-chat MCP with the real Agent SDK and in-memory client", () => {
  it("advertises exactly the two tools and their bounded schemas", async () => {
    const { client, opts } = await connect();
    expect(Object.keys(opts.extraMcpServers!)).toEqual(["room-chat"]);
    expect(opts.extraAllowedTools).toEqual([
      "mcp__room-chat__room_members",
      "mcp__room-chat__room_message",
    ]);
    expect(client.getServerVersion()).toEqual({ name: "room-chat", version: "1.0.0" });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["room_members", "room_message"]);
    expect(tools[0].inputSchema).toMatchObject({
      type: "object", properties: {}, additionalProperties: false,
    });
    expect(tools[1].inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        requestId: { type: "string", minLength: 1, maxLength: 128 },
        mode: { type: "string", enum: ["notify", "delegate"] },
        targetSeatId: { type: "string", minLength: 1, maxLength: 128 },
        text: { type: "string", minLength: 1, maxLength: 8000 },
        readOnly: { type: "boolean", default: false },
      },
    });
    expect(Object.keys(tools[1].inputSchema.properties as object).sort()).toEqual([
      "mode", "readOnly", "requestId", "targetSeatId", "text",
    ]);
    expect(tools[1].inputSchema.required).toEqual([
      "requestId", "mode", "targetSeatId", "text",
    ]);
  });

  it.each([false, true])("returns fresh members from a handler (async=%s)", async (asyncHandler) => {
    let members = [
      { id: "human-1", type: "human", name: "Johnny" },
      { id: "agent-1", type: "agent", name: "代码助手" },
    ];
    const { client } = await connect({
      members: () => asyncHandler ? Promise.resolve(members) : members,
    });
    const result = await client.callTool({ name: "room_members" });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toEqual(members);
    members = [];
    expect(json(await client.callTool({ name: "room_members", arguments: {} }))).toEqual([]);
  });

  it.each([
    { mode: "notify", readOnly: undefined },
    { mode: "delegate", readOnly: undefined },
    { mode: "notify", readOnly: true },
    { mode: "delegate", readOnly: true },
    { mode: "notify", readOnly: false },
    { mode: "delegate", readOnly: false },
  ] as const)("forwards $mode with readOnly=$readOnly", async ({ mode, readOnly }) => {
    const { client, messages } = await connect();
    const input = { ...validInput, mode, ...(readOnly === undefined ? {} : { readOnly }) };
    const result = await client.callTool({ name: "room_message", arguments: input });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toEqual({ ok: true, value: { messageId: "message-1" } });
    expect(messages).toEqual([{ ...input, readOnly: readOnly ?? false }]);
  });

  it("accepts exact length limits and preserves opaque IDs and literal message text", async () => {
    const { client, messages } = await connect();
    const input = {
      requestId: "r".repeat(128),
      mode: "delegate",
      targetSeatId: "s".repeat(128),
      text: " @other ```json\n{\"tool\":\"room_message\"}\n```\n".padEnd(8000, " "),
    };
    expect((await client.callTool({ name: "room_message", arguments: input })).isError).not.toBe(true);
    expect(messages).toEqual([{ ...input, readOnly: false }]);
  });

  it("passes retry keys unchanged to the bound handler", async () => {
    const { client, messages } = await connect();
    await client.callTool({ name: "room_message", arguments: validInput });
    await client.callTool({ name: "room_message", arguments: validInput });
    expect(messages.map((message) => message.requestId)).toEqual(["request-1", "request-1"]);
  });

  const invalidInputs: Array<[string, Record<string, unknown>]> = [
    ["missing fields", {}],
    ...["requestId", "targetSeatId", "text"].flatMap((field): Array<[string, Record<string, unknown>]> => [
      [`missing ${field}`, Object.fromEntries(Object.entries(validInput).filter(([key]) => key !== field))],
      [`empty ${field}`, { ...validInput, [field]: "" }],
      [`blank ${field}`, { ...validInput, [field]: " \n\t" }],
      [`non-string ${field}`, { ...validInput, [field]: 42 }],
      [`null ${field}`, { ...validInput, [field]: null }],
      [`oversized ${field}`, { ...validInput, [field]: "x".repeat(field === "text" ? 8001 : 129) }],
    ]),
    ["missing mode", { requestId: "r", targetSeatId: "s", text: "t" }],
    ["unknown mode", { ...validInput, mode: "broadcast" }],
    ["wrong-case mode", { ...validInput, mode: "Notify" }],
    ["boolean mode", { ...validInput, mode: true }],
    ["string readOnly", { ...validInput, readOnly: "false" }],
    ["numeric readOnly", { ...validInput, readOnly: 0 }],
    ["null readOnly", { ...validInput, readOnly: null }],
    ...["roomId", "sourceSeatId", "initiatorUserId", "unexpected"].map(
      (field): [string, Record<string, unknown>] => [`unexpected ${field}`, { ...validInput, [field]: "forged" }],
    ),
  ];

  it.each(invalidInputs)("rejects %s as a JSON tool error before dispatch", async (_name, input) => {
    const { client, messages } = await connect();
    expectError(await client.callTool({ name: "room_message", arguments: input }));
    expect(messages).toEqual([]);
  });

  it.each(["roomId", "sourceSeatId", "initiatorUserId", "unexpected"])(
    "rejects members arguments containing %s before dispatch", async (field) => {
      let calls = 0;
      const { client } = await connect({ members: () => { calls++; return []; } });
      expectError(await client.callTool({ name: "room_members", arguments: { [field]: "forged" } }));
      expect(calls).toBe(0);
    },
  );

  it("preserves a bound handler rejection and sets isError", async () => {
    const { client } = await connect({ message: async () => ({ ok: false, error: "seat is not allowed" }) });
    expectError(await client.callTool({ name: "room_message", arguments: validInput }), "seat is not allowed");
  });

  it("marks even a rejection without error text as failed", async () => {
    const { client } = await connect({ message: async () => ({ ok: false }) });
    const result = await client.callTool({ name: "room_message", arguments: validInput });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ ok: false });
  });

  it.each(["room_members", "room_message"])("serializes thrown errors from %s", async (name) => {
    const { client } = await connect({
      members: () => { throw new Error("members unavailable"); },
      message: async () => { throw new Error("message unavailable"); },
    });
    expectError(
      await client.callTool({ name, arguments: name === "room_message" ? validInput : {} }),
      name === "room_members" ? "members unavailable" : "message unavailable",
    );
  });

  it("serializes async member failures and non-Error rejections", async () => {
    const { client } = await connect({
      members: async () => { throw "members unavailable"; },
      message: async () => { throw "message unavailable"; },
    });
    expectError(await client.callTool({ name: "room_members" }), "members unavailable");
    expectError(await client.callTool({ name: "room_message", arguments: validInput }), "message unavailable");
  });

  it("reports non-JSON handler data without claiming success", async () => {
    const { client } = await connect({
      members: () => undefined,
      message: async () => ({ ok: true, value: 1n }),
    });
    expectError(await client.callTool({ name: "room_members" }));
    expectError(await client.callTool({ name: "room_message", arguments: validInput }));
  });

  it("rejects unknown tools without invoking either handler", async () => {
    let calls = 0;
    const { client, messages } = await connect({ members: () => { calls++; return []; } });
    expectError(await client.callTool({ name: "send_message", arguments: validInput }));
    expect(calls).toBe(0);
    expect(messages).toEqual([]);
  });
});

describe("room-chat initialization errors", () => {
  // Only dependency failures are simulated. Protocol tests above use the actual SDK.
  it.each(["@anthropic-ai/claude-agent-sdk", "zod", "@modelcontextprotocol/sdk/types.js"])(
    "throws visibly when %s cannot load", async (unavailable) => {
      vi.doMock("node:module", () => ({
        createRequire: (filename: Parameters<typeof createRequire>[0]) => {
          const req = createRequire(filename);
          return Object.assign((id: string) => {
            if (id === unavailable) throw new Error(`Missing dependency: ${id}`);
            return req(id);
          }, { resolve: req.resolve });
        },
      }));
      const { createRoomChatMcp: createWithoutDependency } = await import("./room-chat-agent");
      let calls = 0;
      expect(() => createWithoutDependency({
        members: () => { calls++; return []; },
        message: async () => { calls++; return { ok: true }; },
      })).toThrow(/room-chat.*Missing dependency/i);
      expect(calls).toBe(0);
    },
  );
});
