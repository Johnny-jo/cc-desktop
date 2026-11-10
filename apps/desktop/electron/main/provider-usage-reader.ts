export type ProviderResponseObservation = {
  outcome: "success" | "failure" | "cancelled";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usageReported: boolean;
};

const usageFields = {
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  cache_read_input_tokens: "cacheReadTokens",
  cache_creation_input_tokens: "cacheCreationTokens",
} as const;
type UsageField = keyof typeof usageFields;
type UsageState = Omit<ProviderResponseObservation, "outcome">;
type Observer = { push(text: string): void; finish(): boolean };
const maxEventLength = 8 * 1024 * 1024;

function reportField(state: UsageState, field: string, value: unknown) {
  if (!Object.hasOwn(usageFields, field) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return;
  // Messages usage fields are cumulative, including output_tokens in deltas.
  state[usageFields[field as UsageField]] = value;
  state.usageReported = true;
}
function reportUsage(state: UsageState, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const field of Object.keys(usageFields)) reportField(state, field, (value as Record<string, unknown>)[field]);
}

function sseObserver(state: UsageState): Observer {
  let pending = ""; let data: string[] = []; let event = ""; let eventLength = 0;
  let started = false; let stopped = false;
  const dispatch = () => {
    const eventName = event; const hasData = data.length > 0; const payload = data.join("\n");
    data = []; event = ""; eventLength = 0;
    if (!hasData) { if (eventName === "error") throw new Error("Provider SSE error"); return; }
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Messages event");
    if (value.type === "message_start") {
      reportUsage(state, value.message?.usage);
      if (started || stopped || value.message?.type !== "message") throw new Error("Invalid message_start");
      started = true;
    } else if (value.type === "message_delta") {
      reportUsage(state, value.usage);
      if (!started || stopped) throw new Error("Unexpected message_delta");
    } else if (value.type === "message_stop") {
      if (!started || stopped) throw new Error("Unexpected message_stop");
      stopped = true;
    } else if (typeof value.type !== "string" || (value.type !== "ping" && (!started || stopped))) {
      throw new Error("Unexpected Messages event");
    }
    if (eventName === "error" || value.type === "error" || value.error) throw new Error("Provider SSE error");
  };
  const line = (value: string) => {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (!value) { dispatch(); return; }
    eventLength += value.length;
    if (eventLength > maxEventLength) throw new Error("Provider SSE event too large");
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    else if (value.startsWith("event:")) event = value.slice(6).trim();
  };
  return {
    push(text) {
      let offset = 0; let newline: number;
      while ((newline = text.indexOf("\n", offset)) >= 0) {
        if (pending.length + newline - offset + eventLength > maxEventLength) throw new Error("Provider SSE event too large");
        line(pending + text.slice(offset, newline)); pending = ""; offset = newline + 1;
      }
      if (pending.length + text.length - offset + eventLength > maxEventLength) throw new Error("Provider SSE event too large");
      pending += text.slice(offset);
    },
    finish() {
      if (pending) line(pending);
      dispatch(); pending = "";
      return started && stopped;
    },
  };
}

type JsonFrame = { kind: "object" | "array"; path: string[]; state: "keyOrEnd" | "key" | "colon" | "value" | "valueOrEnd" | "commaOrEnd"; key?: string; index: number };

/** Validates JSON incrementally while retaining only short keys/scalars and
 * container paths. Response text, tool inputs and thinking are never collected. */
function jsonObserver(usage: UsageState): Observer {
  const frames: JsonFrame[] = [];
  let begun = false; let done = false; let rootObject = false;
  let messageType = false; let assistant = false; let content = false; let stopReason = false;
  let mode: "normal" | "string" | "number" | "literal" = "normal";
  let token = ""; let capture = true; let keyToken = false; let escape = false; let unicode = 0; let path: string[] = [];
  const invalid = (): never => { throw new Error("Invalid Messages JSON"); };
  const scalar = (value: unknown) => {
    if (path.length === 1) {
      if (path[0] === "type") messageType = value === "message";
      if (path[0] === "role") assistant = value === "assistant";
      if (path[0] === "stop_reason") stopReason = typeof value === "string" && value.length > 0;
    }
    if (path.length === 2 && path[0] === "usage") reportField(usage, path[1], value);
    if (!frames.length) done = true;
  };
  const beginValue = (): string[] => {
    const parent = frames.at(-1);
    if (!parent) { if (begun) invalid(); begun = true; return []; }
    if (parent.state !== "value" && parent.state !== "valueOrEnd") invalid();
    parent.state = "commaOrEnd";
    const nextPath = [...parent.path, parent.kind === "object" ? parent.key! : String(parent.index++)];
    if (nextPath.length === 1) {
      if (nextPath[0] === "type") messageType = false;
      if (nextPath[0] === "role") assistant = false;
      if (nextPath[0] === "stop_reason") stopReason = false;
      if (nextPath[0] === "content") content = false;
    }
    return nextPath;
  };
  const finishToken = () => {
    if (mode === "number") {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) invalid();
      scalar(Number(token));
    } else if (mode === "literal") {
      if (!["true", "false", "null"].includes(token)) invalid();
      scalar(token === "null" ? null : token === "true");
    } else invalid();
    mode = "normal"; token = "";
  };
  const append = (char: string) => {
    if (capture) { if (token.length < 256) token += char; else { capture = false; token = ""; } }
  };
  const close = (kind: JsonFrame["kind"]) => {
    const frame = frames.at(-1);
    if (!frame || frame.kind !== kind) return invalid();
    if (frame.state !== "commaOrEnd" && !(kind === "object" && frame.state === "keyOrEnd") && !(kind === "array" && frame.state === "valueOrEnd")) invalid();
    frames.pop(); if (!frames.length) done = true;
  };
  return {
    push(text) {
      for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (mode === "string") {
          append(char);
          if (unicode) { if (!/[\da-f]/i.test(char)) invalid(); unicode--; }
          else if (escape) { if (char === "u") unicode = 4; else if (!'"\\/bfnrt'.includes(char)) invalid(); escape = false; }
          else if (char === "\\") escape = true;
          else if (char === '"') {
            const value = capture ? JSON.parse(token) : undefined;
            mode = "normal"; token = "";
            if (keyToken) { const frame = frames.at(-1)!; frame.key = value ?? ""; frame.state = "colon"; }
            else scalar(value);
          } else if (char.charCodeAt(0) < 0x20) invalid();
          continue;
        }
        if (mode === "number" || mode === "literal") {
          if ((mode === "number" ? /[\deE.+-]/ : /[a-z]/).test(char)) { if (token.length >= 128) invalid(); token += char; continue; }
          finishToken(); index--; continue;
        }
        if (/[ \t\r\n]/.test(char)) continue;
        if (done) invalid();
        const frame = frames.at(-1);
        if (frame?.state === "key" || frame?.state === "keyOrEnd") {
          if (char === "}" && frame.state === "keyOrEnd") { close("object"); continue; }
          if (char !== '"') invalid();
          keyToken = true; capture = true; token = '"'; mode = "string"; continue;
        }
        if (frame?.state === "colon") { if (char !== ":") invalid(); frame.state = "value"; continue; }
        if (frame?.state === "commaOrEnd") {
          if (char === ",") { frame.state = frame.kind === "object" ? "key" : "value"; continue; }
          if (char === "}" || char === "]") { close(char === "}" ? "object" : "array"); continue; }
          invalid();
        }
        if (frame?.state === "valueOrEnd" && char === "]") { close("array"); continue; }
        path = beginValue();
        if (char === "{" || char === "[") {
          const kind = char === "{" ? "object" : "array";
          if (!path.length) rootObject = kind === "object";
          if (path.length === 1 && path[0] === "content") content = kind === "array";
          if (frames.length >= 64) invalid();
          frames.push({ kind, path, state: kind === "object" ? "keyOrEnd" : "valueOrEnd", index: 0 });
        } else if (char === '"') { mode = "string"; token = '"'; capture = true; keyToken = false; }
        else if (/[\d-]/.test(char)) { mode = "number"; token = char; }
        else if (/[tfn]/.test(char)) { mode = "literal"; token = char; }
        else invalid();
      }
    },
    finish() {
      if (mode === "number" || mode === "literal") finishToken();
      return mode === "normal" && done && rootObject && messageType && assistant && content && stopReason;
    },
  };
}

/** Observes a Messages response in the consumer's read path. No tee or background
 * drain is used, so a slow client also slows upstream. A successful stream needs
 * message_stop AND a clean EOF; reported partial usage survives errors/cancel. */
export function observeProviderResponse(response: Response, options: {
  signal?: AbortSignal;
  onComplete: (result: ProviderResponseObservation) => void;
}): Response {
  const usage: UsageState = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usageReported: false };
  let completed = false;
  const complete = (outcome: ProviderResponseObservation["outcome"]) => {
    if (completed) return; completed = true;
    try { options.onComplete({ outcome, ...usage }); } catch { /* Statistics must not disrupt provider transport. */ }
  };
  if (!response.ok || !response.body) { complete(options.signal?.aborted ? "cancelled" : "failure"); return response; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let observer: Observer | undefined = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ? sseObserver(usage) : jsonObserver(usage);
  let closed = false; let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => { options.signal?.removeEventListener("abort", abort); observer = undefined; };
  const abort = () => {
    if (closed) return; closed = true;
    const reason = options.signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
    complete("cancelled"); cleanup(); controller.error(reason);
    void reader.cancel(reason).catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort(); },
    async pull(value) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          closed = true;
          try { observer?.push(decoder.decode()); complete(observer?.finish() ? "success" : "failure"); }
          catch { complete("failure"); }
          cleanup(); value.close();
        } else {
          if (observer) {
            try { observer.push(decoder.decode(next.value, { stream: true })); }
            catch { observer = undefined; complete("failure"); }
          }
          value.enqueue(next.value);
        }
      } catch (error) {
        if (closed) return; closed = true;
        complete(options.signal?.aborted ? "cancelled" : "failure"); cleanup(); value.error(error);
      }
    },
    async cancel(reason) {
      if (closed) return; closed = true;
      complete("cancelled"); cleanup(); await reader.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
