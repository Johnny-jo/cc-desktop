import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __applySessionEventForTests,
  __resetStoreForTests,
  __upsertSessionForTests,
  dequeuePrompt,
  enterCliMode,
  exitCliMode,
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

describe("transcript persistence", () => {
  beforeEach(() => {
    __resetStoreForTests();
  });

  it("does not call saveSessionTranscript on stream events", () => {
    const save = vi.fn();
    const g = globalThis as unknown as { window?: { desktop?: Record<string, unknown> } };
    g.window = g.window ?? {};
    g.window.desktop = {
      ...(g.window.desktop ?? {}),
      saveSessionTranscript: save,
      continueSession: async () => ({ sessionId: "s1" }),
      startSession: async () => ({ sessionId: "s1" }),
    };
    runningSession("s1");
    __applySessionEventForTests({
      type: "text_delta",
      sessionId: "s1",
      text: "Hi",
    });
    __applySessionEventForTests({
      type: "result",
      sessionId: "s1",
      ok: true,
      usage: { outputTokens: 1 },
    });
    expect(getState().itemsBySession.s1.some((i) => i.kind === "text")).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("cli mode", () => {
  beforeEach(() => {
    __resetStoreForTests();
    const g = globalThis as unknown as { window?: { desktop?: unknown } };
    g.window = g.window ?? {};
    g.window.desktop = {
      continueSession: async () => ({ sessionId: "s1" }),
      startSession: async () => ({ sessionId: "s1" }),
    };
  });

  it("enterCliMode drops cached transcripts and sets cliMode", () => {
    runningSession("s1");
    __applySessionEventForTests({
      type: "text_delta",
      sessionId: "s1",
      text: "Hi",
    });
    expect(getState().itemsBySession.s1.length).toBeGreaterThan(0);
    enterCliMode();
    expect(getState().cliMode).toBe(true);
    expect(getState().itemsBySession).toEqual({});
    exitCliMode();
    expect(getState().cliMode).toBe(false);
  });

  it("does not accumulate items from stream events while cliMode is on", () => {
    runningSession("s1");
    enterCliMode();
    expect(getState().itemsBySession).toEqual({});
    __applySessionEventForTests({
      type: "text_delta",
      sessionId: "s1",
      text: "partial",
    });
    __applySessionEventForTests({
      type: "result",
      sessionId: "s1",
      ok: true,
    });
    expect(getState().itemsBySession).toEqual({});
  });

  it("sendMessage does not write items while cliMode is on", () => {
    // Idle session so sendMessage continues instead of queueing.
    __upsertSessionForTests({
      id: "s1",
      title: "t",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });
    enterCliMode();
    expect(getState().itemsBySession).toEqual({});
    sendMessage("hello from cli");
    expect(getState().itemsBySession).toEqual({});
  });
});
