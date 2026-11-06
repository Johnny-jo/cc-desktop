import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfCompatibilityProxy, normalizePdfMessages } from "./pdf-compatibility-proxy";
import { readPdfText } from "./pdf-text";
import { pdfFixture } from "./pdf-test-fixture";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function document(text = "Document test 314159") {
  return { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfFixture([text]).toString("base64") } };
}
async function endpoint(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function proxy(extract = readPdfText) {
  const value = new PdfCompatibilityProxy(extract);
  cleanup.push(() => value.dispose());
  return value;
}

describe("PDF compatibility at the outbound boundary", () => {
  it("normalizes historic, current and tool-result PDFs, preserving surrounding messages", async () => {
    const body = { model: "deepseek-v4-flash", messages: [
      { role: "user", content: [document("old"), { type: "text", text: "first question" }] },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: [document("tool")] }, document("new")] },
    ] };
    expect(await normalizePdfMessages(body, readPdfText)).toBe(true);
    const json = JSON.stringify(body);
    expect(json).not.toContain('"type":"document"');
    for (const value of ["old", "tool", "new", "earlier reply", "first question", '"tool_use_id":"read"']) expect(json).toContain(value);
  });
  it.each(["claude-sonnet-4-6", "gpt-5.4"])("leaves native PDF input intact for %s", async model => {
    const body = { model, messages: [{ role: "user", content: [document()] }] };
    const before = JSON.stringify(body);
    const extract = vi.fn();
    expect(await normalizePdfMessages(body, extract)).toBe(false);
    expect(JSON.stringify(body)).toBe(before);
    expect(extract).not.toHaveBeenCalled();
  });
  it("rejects malformed PDF data and never silently drops a document", async () => {
    const block = document(); block.source.data = "invalid??";
    await expect(normalizePdfMessages({ model: "deepseek-v4-flash", messages: [{ content: [block] }] }, readPdfText)).rejects.toThrow("数据不完整");
  });
  it("forwards auth, paths, query and streaming bytes after normalization and caches repeat history", async () => {
    const received: Array<{ path: string; token: string; body: unknown }> = [];
    const upstream = await endpoint(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      received.push({ path: req.url!, token: req.headers.authorization!, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "test-id" });
      res.write("event: message_start\ndata: {}\n\n");
      res.end("event: message_stop\ndata: {}\n\n");
    });
    const extract = vi.fn(readPdfText);
    const gate = proxy(extract);
    const env = await gate.environment({ ANTHROPIC_BASE_URL: upstream + "/provider", ANTHROPIC_AUTH_TOKEN: "fixture-only" });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-only");
    expect((await gate.environment({ ANTHROPIC_BASE_URL: upstream + "/provider" })).ANTHROPIC_BASE_URL).toBe(env.ANTHROPIC_BASE_URL);
    for (let n = 0; n < 2; n++) {
      const response = await fetch(env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
        method: "POST", headers: { authorization: "Bearer fixture-only", "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, messages: [{ role: "user", content: [document()] }] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("request-id")).toBe("test-id");
      expect(await response.text()).toBe("event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n");
    }
    expect(extract).toHaveBeenCalledTimes(1);
    expect(received[0].path).toBe("/provider/v1/messages?beta=true");
    expect(received[0].token).toBe("Bearer fixture-only");
    expect(JSON.stringify(received[0].body)).toContain("Document test 314159");
    expect(JSON.stringify(received[0].body)).not.toContain('"type":"document"');
  });
  it("returns a readable OCR error without calling upstream", async () => {
    const reached = vi.fn((_req, res) => res.end());
    const upstream = await endpoint(reached);
    const env = await proxy().environment({ ANTHROPIC_BASE_URL: upstream });
    const response = await fetch(env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ content: [document("")] }] }) });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("仍未找到可读文字");
    expect(reached).not.toHaveBeenCalled();
  });
  it("passes non-PDF request and upstream error responses through unchanged", async () => {
    const payload = JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "plain text" }] });
    const upstream = await endpoint(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe(payload);
      res.writeHead(429, { "retry-after": "2" }); res.end('{"error":"quota"}');
    });
    const env = await proxy().environment({ ANTHROPIC_BASE_URL: upstream });
    const response = await fetch(env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: payload });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.text()).toBe('{"error":"quota"}');
  });
});
