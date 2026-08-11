import { beforeEach, describe, expect, it } from "vitest";
import {
  __applySessionEventForTests,
  __resetStoreForTests,
  __upsertSessionForTests,
  dequeuePrompt,
  getState,
  sendMessage,
} from "./store";

function runningSession(id: string) {
  __upsertSessionForTests({
    id,
    title: "t",
    cwd: "D:/p",
    updatedAt: Date.now(),
    status: "running",
  });
}

describe("prompt queue", () => {
  beforeEach(() => {
    __resetStoreForTests();
    // sendMessage calls getDesktop() when NOT queueing — provide a stub so a
    // failing queue condition surfaces as a stubbed call, not a throw.
    // node test env has no window; getDesktop reads window.desktop — polyfill.
    const g = globalThis as unknown as { window?: { desktop?: unknown } };
    g.window = g.window ?? {};
    g.window.desktop = {
      continueSession: async () => ({ sessionId: "s1" }),
      startSession: async () => ({ sessionId: "s1" }),
    };
  });

  it("queues messages sent while a turn is running", () => {
    runningSession("s1");
    // Active session is set by upsert when none selected + running
    expect(getState().activeSessionId).toBe("s1");
    expect(getState().running).toBe(true);

    sendMessage("second question");
    const q = getState().queuedPrompts;
    expect(q).toHaveLength(1);
    expect(q[0].text).toBe("second question");
  });

  it("dequeuePrompt removes a queued message", () => {
    runningSession("s1");
    sendMessage("one");
    sendMessage("two");
    expect(getState().queuedPrompts).toHaveLength(2);
    dequeuePrompt(0);
    const q = getState().queuedPrompts;
    expect(q).toHaveLength(1);
    expect(q[0].text).toBe("two");
  });

  it("queue persists across stream events until flushed", () => {
    runningSession("s1");
    sendMessage("queued msg");
    expect(getState().queuedPrompts).toHaveLength(1);
    __applySessionEventForTests({
      type: "text_delta",
      sessionId: "s1",
      text: "partial",
    });
    expect(getState().queuedPrompts).toHaveLength(1);
  });

  it("flushes the queue when the turn result arrives", async () => {
    runningSession("s1");
    sendMessage("queued msg");
    expect(getState().queuedPrompts).toHaveLength(1);

    __applySessionEventForTests({
      type: "result",
      sessionId: "s1",
      ok: true,
    });
    // flushQueuedPrompt runs on a macrotask
    await new Promise((r) => setTimeout(r, 5));
    expect(getState().queuedPrompts).toHaveLength(0);
  });
});
