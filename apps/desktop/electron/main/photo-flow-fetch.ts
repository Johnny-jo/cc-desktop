import { net } from "electron";
import { PHOTO_FLOW_LIMITS } from "./photo-flow-service";

/** net.fetch rejects manual redirects. Expose each hop without following it so
 * the cache service can validate the destination before sending another request.
 * net.request retains Chromium's system-proxy support. This adapter is GET-only. */
export const fetchPhotoFlow: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const signal = init?.signal;
  signal?.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const request = net.request({ url, method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
    new Headers(init?.headers).forEach((value, name) => request.setHeader(name, value));
    let settled = false;
    const finish = (response?: Response, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (response) resolve(response);
      else reject(error ?? new Error("Photo request closed"));
    };
    const abort = () => { finish(undefined, signal?.reason); request.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    request.on("error", error => finish(undefined, error));
    // The writable request may close before its readable response finishes.
    // Response errors/aborts and the caller's deadline handle incomplete bodies.
    request.on("redirect", (status, _method, location) => {
      finish(new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.on("response", response => {
      const chunks: Buffer[] = [];
      let size = 0;
      const headers = new Headers();
      for (const [name, values] of Object.entries(response.headers)) {
        for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
      }
      const fail = (error: unknown) => { finish(undefined, error); request.abort(); };
      response.on("error", fail);
      response.on("aborted", () => fail(new Error("Photo response aborted")));
      response.on("end", () => {
        try {
          finish(new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks),
            { status: response.statusCode, headers }));
        } catch (error) { fail(error); }
      });
      if (Number(headers.get("content-length")) > PHOTO_FLOW_LIMITS.imageBytes) {
        fail(new Error("Photo response too large"));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > PHOTO_FLOW_LIMITS.imageBytes) fail(new Error("Photo response too large"));
        else chunks.push(Buffer.from(chunk));
      });
    });
    if (signal?.aborted) abort();
    else request.end();
  });
};
