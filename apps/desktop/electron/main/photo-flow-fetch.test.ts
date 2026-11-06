import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PHOTO_FLOW_LIMITS } from "./photo-flow-service";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", () => ({ net: { request } }));
import { fetchPhotoFlow } from "./photo-flow-fetch";

function client() {
  const client = Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn(), abort: vi.fn() });
  request.mockReturnValue(client);
  return client;
}

describe("Chromium photo requests", () => {
  it("waits for response end even if the writable request closes first", async () => {
    const req = client();
    const result = fetchPhotoFlow("https://picsum.photos/v2/list", { headers: { Accept: "application/json" } });
    req.emit("close");
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "application/json" } });
    req.emit("response", response);
    response.emit("data", Buffer.from("[]"));
    response.emit("end");
    expect(await (await result).json()).toEqual([]);
    expect(req.setHeader).toHaveBeenCalledWith("accept", "application/json");
  });

  it("returns redirects to the service for validation instead of following them", async () => {
    const req = client();
    const result = fetchPhotoFlow("https://picsum.photos/id/1/600/470.jpg");
    req.emit("redirect", 302, "GET", "https://fastly.picsum.photos/id/1/600/470.jpg?hmac=example");
    const response = await result;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("fastly.picsum.photos");
    expect(req.abort).toHaveBeenCalledOnce();
  });

  it("aborts the transport on cancellation and detaches the signal listener", async () => {
    const req = client();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = fetchPhotoFlow("https://picsum.photos/v2/list", { signal: controller.signal });
    controller.abort(new Error("disabled"));
    await expect(result).rejects.toThrow("disabled");
    expect(req.abort).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalled();
  });

  it("bounds chunked response bodies before constructing a Response", async () => {
    const req = client();
    const result = fetchPhotoFlow("https://picsum.photos/id/1/600/470.jpg");
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "image/jpeg" } });
    req.emit("response", response);
    response.emit("data", Buffer.alloc(PHOTO_FLOW_LIMITS.imageBytes));
    response.emit("data", Buffer.from([1]));
    await expect(result).rejects.toThrow("too large");
    expect(req.abort).toHaveBeenCalledOnce();
  });
});
