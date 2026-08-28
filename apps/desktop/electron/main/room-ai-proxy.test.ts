import { describe, expect, it } from "vitest";
import {
  bufferToChunks,
  buildReqFrames,
  concatChunks,
  parseBorrowToken,
  startLoopbackProxy,
} from "./room-ai-proxy";

describe("room-ai-proxy chunks", () => {
  it("round-trips a body larger than one chunk", () => {
    const body = Buffer.alloc(100_000, 7);
    const parts = bufferToChunks(body, 40_000);
    expect(parts.length).toBe(3);
    expect(concatChunks(parts).equals(body)).toBe(true);
  });

  it("builds a single empty req frame", () => {
    const frames = buildReqFrames({
      requestId: "t1",
      targetUserId: "b",
      sourceUserId: "a",
      method: "POST",
      path: "/v1/messages",
      body: Buffer.alloc(0),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.last).toBe(true);
    expect(frames[0]?.method).toBe("POST");
  });

  it("parses the borrow token", () => {
    expect(parseBorrowToken("Bearer room-borrow:user-b")).toBe("user-b");
    expect(parseBorrowToken("room-borrow:user-b")).toBe("user-b");
    expect(parseBorrowToken("other")).toBeNull();
  });
});

describe("loopback proxy", () => {
  it("forwards a request to the handler and returns the body", async () => {
    const proxy = await startLoopbackProxy(async (req) => {
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/v1/messages");
      expect(parseBorrowToken(req.auth)).toBe("u1");
      return { status: 200, body: Buffer.from('{"ok":true}') };
    });
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { Authorization: "Bearer room-borrow:u1" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ok":true}');
    } finally {
      proxy.close();
    }
  });
});
