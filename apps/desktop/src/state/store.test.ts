import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __applySessionEventForTests,
  __resetStoreForTests,
  __upsertSessionForTests,
  dequeuePrompt,
  enterCliMode,
  exitCliMode,
  getState,
  loadNewerMessages,
  loadOlderMessages,
  selectSession,
  sendMessage,
} from "./store";
import { TRANSCRIPT_TURN_WINDOW, type ChatItem } from "@claude-desktop/shared";

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
  it("drops unsent prompts after interruption without reporting a failure", () => {
    runningSession("s1");
    sendMessage("Queued work");
    __applySessionEventForTests({ type: "result", sessionId: "s1", ok: false, outcome: "interrupted" });
    expect(getState().queuedPrompts).toEqual([]);
    expect(getState().lastError).toBeNull();
  });
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

  it("does not queue a send on an idle session while another session is running", async () => {
    runningSession("s1");
    __upsertSessionForTests({
      id: "s2",
      title: "two",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });
    const continueSession = vi.fn().mockResolvedValue({ sessionId: "s2" });
    const g = globalThis as unknown as { window?: { desktop?: Record<string, unknown> } };
    g.window = g.window ?? {};
    g.window.desktop = {
      ...(g.window.desktop as object),
      continueSession,
      selectSession: vi.fn().mockResolvedValue({
        sessionId: "s2",
        cwd: "D:/p",
        items: [],
        total: 0,
        hasMore: false,
        hasNewer: false,
        changes: [],
      }),
    };
    await selectSession("s2");
    expect(getState().activeSessionId).toBe("s2");
    expect(getState().running).toBe(true);

    sendMessage("on idle session");
    expect(getState().queuedPrompts).toHaveLength(0);
    expect(continueSession).toHaveBeenCalledWith(
      "s2",
      expect.objectContaining({ text: "on idle session" }),
    );
  });

  it("caps live renderer transcript and marks hasMore so older rows stay on disk", () => {
    runningSession("s1");
    const total = TRANSCRIPT_TURN_WINDOW + 20;
    for (let i = 0; i < total; i++) {
      __applySessionEventForTests({
        type: "user_message",
        sessionId: "s1",
        text: `msg-${i}`,
        submittedItem: userItem(`user-${i}`, `msg-${i}`),
      });
    }
    const items = getState().itemsBySession.s1 ?? [];
    expect(items.length).toBe(TRANSCRIPT_TURN_WINDOW);
    expect(getState().hasMoreBySession.s1).toBe(true);
    expect(items[0]).toMatchObject({ text: "msg-20" });
    expect(items[items.length - 1]).toMatchObject({ text: `msg-${total - 1}` });
    expect(getState().hasNewerBySession.s1).toBe(false);
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

  it("selectSession in cliMode loads changes but not transcript", async () => {
    const select = vi.fn().mockResolvedValue({
      sessionId: "s2",
      cwd: "D:/b",
      items: [{ kind: "text", id: "x", role: "user", text: "should-not-land" }],
      total: 1,
      hasMore: false,
      changes: [
        {
          path: "a.ts",
          status: "M",
          hunks: "+x",
          updatedAt: 1,
          events: [],
        },
      ],
    });
    const g = globalThis as unknown as { window?: { desktop?: Record<string, unknown> } };
    g.window = g.window ?? {};
    g.window.desktop = {
      ...(g.window.desktop as object),
      selectSession: select,
    };
    __upsertSessionForTests({
      id: "s1",
      title: "one",
      cwd: "D:/a",
      updatedAt: Date.now(),
      status: "idle",
    });
    __upsertSessionForTests({
      id: "s2",
      title: "two",
      cwd: "D:/b",
      updatedAt: Date.now(),
      status: "idle",
    });
    enterCliMode();
    await selectSession("s2");
    expect(getState().activeSessionId).toBe("s2");
    expect(getState().projectPath).toBe("D:/b");
    expect(getState().itemsBySession).toEqual({});
    expect(getState().changesBySession.s2).toHaveLength(1);
    expect(select).toHaveBeenCalled();
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

function textItem(id: string, text: string): {
  kind: "text";
  id: string;
  role: "assistant";
  text: string;
} {
  return { kind: "text", id, role: "assistant", text };
}

function userItem(id: string, text: string): Extract<ChatItem, { kind: "text" }> {
  return { kind: "text", id, role: "user", text };
}

describe("sliding transcript window", () => {
  it("loads twelve whole turns and retains the adjacent page while paging in either direction", async () => {
    const turns = Array.from({ length: 60 }, (_, i) => [
      userItem(`user-${i}`, `Question ${i}`),
      ...Array.from({ length: i === 54 ? 350 : 2 }, (_, j): ChatItem => ({
        kind: "tool", id: `tool-${i}-${j}`, tool: { id: `tool-${i}-${j}`, name: "Read", summary: "Read", status: "done" },
      })),
      textItem(`answer-${i}`, `Answer ${i}`),
    ]);
    const select = vi.fn(async (_id: string, { turnLimit }: { turnLimit: number }) => ({
      items: turns.slice(-turnLimit).flat(), hasMore: true, hasNewer: false,
    }));
    Object.assign(window.desktop, { selectSession: select });
    desktop.loadOlderMessages.mockImplementation(async (_id: string, cursor: string, { turnLimit }: { turnLimit: number }) => {
      const end = turns.findIndex(turn => turn[0]!.id === cursor);
      return { items: turns.slice(Math.max(0, end - turnLimit), end).flat(), hasMore: end > turnLimit };
    });
    desktop.loadNewerMessages.mockImplementation(async (_id: string, cursor: string, { turnLimit }: { turnLimit: number }) => {
      const start = turns.findIndex(turn => turn.at(-1)!.id === cursor) + 1;
      return { items: turns.slice(start, start + turnLimit).flat(), hasNewer: start + turnLimit < turns.length };
    });

    await selectSession("s1");
    expect(select).toHaveBeenCalledWith("s1", { turnLimit: 12 });
    const tail = getState().itemsBySession.s1;
    expect(tail).toEqual(turns.slice(48).flat());
    await loadOlderMessages("s1");
    expect(desktop.loadOlderMessages).toHaveBeenCalledWith("s1", "user-48", { turnLimit: 12 });
    expect(getState().itemsBySession.s1).toEqual(turns.slice(36).flat());
    await loadOlderMessages("s1");
    expect(getState().itemsBySession.s1).toEqual(turns.slice(24, 48).flat());
    expect(getState().hasNewerBySession.s1).toBe(true);

    await loadNewerMessages("s1");
    expect(desktop.loadNewerMessages).toHaveBeenCalledWith("s1", "answer-47", { turnLimit: 12 });
    expect(getState().itemsBySession.s1).toEqual(turns.slice(36).flat());
    expect(getState().hasNewerBySession.s1).toBe(false);
  });

  it("keeps a long turn's prompt, all tool work and its final outcome in the same window", async () => {
    runningSession("s1");
    const user = { kind: "text" as const, role: "user" as const, id: "persisted-user", text: "first question" };
    __applySessionEventForTests({ type: "user_message", text: user.text, submittedItem: user, sessionId: "s1" });
    for (let i = 0; i < 350; i++) {
      __applySessionEventForTests({ type: "text_done", text: "step " + i, sessionId: "s1", transcriptIds: ["persisted-" + i] });
    }
    __applySessionEventForTests({ type: "result", ok: true, sessionId: "s1" });
    const tail = getState().itemsBySession.s1;
    expect(tail).toHaveLength(351);
    expect(tail[0]).toMatchObject({ ...user, turnOutcome: "completed" });
    expect(tail.at(-1)).toMatchObject({ text: "step 349" });
    expect(getState().itemsBySession.s1.filter(row => row.id === user.id)).toHaveLength(1);
    expect(getState().leadingUserBySession.s1).toBeUndefined();
  });
  let desktop: {
    loadOlderMessages: ReturnType<typeof vi.fn>;
    loadNewerMessages: ReturnType<typeof vi.fn>;
    continueSession: () => Promise<{ sessionId: string }>;
    startSession: () => Promise<{ sessionId: string }>;
  };

  beforeEach(() => {
    __resetStoreForTests();
    desktop = {
      loadOlderMessages: vi.fn(),
      loadNewerMessages: vi.fn(),
      continueSession: async () => ({ sessionId: "s1" }),
      startSession: async () => ({ sessionId: "s1" }),
    };
    const g = globalThis as unknown as { window?: { desktop?: unknown } };
    g.window = g.window ?? {};
    g.window.desktop = desktop;
  });

  function fillLiveTail(n = TRANSCRIPT_TURN_WINDOW): void {
    runningSession("s1");
    for (let i = 0; i < n; i++) {
      __applySessionEventForTests({
        type: "user_message",
        sessionId: "s1",
        text: `msg-${i}`,
        submittedItem: userItem(`live-${i}`, `msg-${i}`),
      });
    }
  }

  it("loadOlder prepends a page and prunes the newer tail so the window stays capped", async () => {
    fillLiveTail();
    const before = getState().itemsBySession.s1 ?? [];
    expect(before).toHaveLength(TRANSCRIPT_TURN_WINDOW);

    const older = Array.from({ length: 12 }, (_, i) => userItem(`old-${i}`, `old-${i}`));
    desktop.loadOlderMessages.mockResolvedValue({
      items: older,
      total: 200,
      hasMore: true,
      hasNewer: true,
    });

    await loadOlderMessages("s1");

    const after = getState().itemsBySession.s1 ?? [];
    expect(after).toHaveLength(TRANSCRIPT_TURN_WINDOW);
    expect(after[0]).toMatchObject({ id: "old-0" });
    expect(after[11]).toMatchObject({ id: "old-11" });
    expect(after[12]).toMatchObject({ text: "msg-0" });
    expect(after.at(-1)).toMatchObject({ text: `msg-${TRANSCRIPT_TURN_WINDOW - 13}` });
    expect(after.some((i) => i.kind === "text" && i.text === `msg-${TRANSCRIPT_TURN_WINDOW - 1}`)).toBe(false);
    expect(getState().hasMoreBySession.s1).toBe(true);
    expect(getState().hasNewerBySession.s1).toBe(true);
  });

  it("does not erase streamed output that arrives while an older page is in flight", async () => {
    fillLiveTail(3);
    let resolvePage!: (page: unknown) => void;
    desktop.loadOlderMessages.mockReturnValue(new Promise(resolve => { resolvePage = resolve; }));
    const loading = loadOlderMessages("s1");
    __applySessionEventForTests({ type: "text_done", sessionId: "s1", text: "new live output" });
    resolvePage({ items: [textItem("older", "Older")], hasMore: false });
    await loading;
    expect(getState().itemsBySession.s1.at(-1)).toMatchObject({ text: "new live output" });
  });

  it("loadNewer appends a page and prunes the older head so the window stays capped", async () => {
    fillLiveTail();
    const prunedTail = (getState().itemsBySession.s1 ?? []).slice(12);

    desktop.loadOlderMessages.mockResolvedValue({
      items: Array.from({ length: 12 }, (_, i) => userItem(`old-${i}`, `old-${i}`)),
      total: 200,
      hasMore: true,
      hasNewer: true,
    });
    await loadOlderMessages("s1");
    expect(getState().hasNewerBySession.s1).toBe(true);

    desktop.loadNewerMessages.mockResolvedValue({
      items: prunedTail,
      total: 200,
      hasMore: true,
      hasNewer: false,
    });
    await loadNewerMessages("s1");

    const after = getState().itemsBySession.s1 ?? [];
    expect(after).toHaveLength(TRANSCRIPT_TURN_WINDOW);
    expect(after[0]).toMatchObject({ text: "msg-0" });
    expect(after.at(-1)).toMatchObject({ text: `msg-${TRANSCRIPT_TURN_WINDOW - 1}` });
    expect(after.some((i) => i.kind === "text" && i.id === "old-0")).toBe(false);
    expect(getState().hasMoreBySession.s1).toBe(true);
    expect(getState().hasNewerBySession.s1).toBe(false);
  });

  it("does not apply live stream items while the window is scrolled into history", async () => {
    fillLiveTail();
    desktop.loadOlderMessages.mockResolvedValue({
      items: Array.from({ length: 12 }, (_, i) => userItem(`old-${i}`, `old-${i}`)),
      total: 200,
      hasMore: true,
      hasNewer: true,
    });
    await loadOlderMessages("s1");
    const snapshot = (getState().itemsBySession.s1 ?? []).map((i) => i.id);

    __applySessionEventForTests({
      type: "text_done",
      sessionId: "s1",
      text: "should-not-land",
    });
    __applySessionEventForTests({
      type: "result",
      sessionId: "s1",
      ok: true,
    });

    expect((getState().itemsBySession.s1 ?? []).map((i) => i.id)).toEqual(snapshot);
    expect(getState().itemsBySession.s1.some((i) => i.kind === "text" && i.text === "should-not-land")).toBe(
      false,
    );
  });

  it("sendMessage while scrolled into history snaps the window back to the new tail", async () => {
    fillLiveTail();
    desktop.loadOlderMessages.mockResolvedValue({
      items: Array.from({ length: 12 }, (_, i) => userItem(`old-${i}`, `old-${i}`)),
      total: 200,
      hasMore: true,
      hasNewer: true,
    });
    await loadOlderMessages("s1");
    expect(getState().hasNewerBySession.s1).toBe(true);

    __upsertSessionForTests({
      id: "s1",
      title: "t",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });

    sendMessage("new question");

    const items = getState().itemsBySession.s1 ?? [];
    expect(getState().hasNewerBySession.s1).toBe(false);
    expect(items.some((i) => i.kind === "text" && i.text === "new question")).toBe(true);
    expect(items.some((i) => i.kind === "text" && i.id === "old-0")).toBe(false);
  });
});

describe("renderer session cache pruning", () => {
  beforeEach(() => {
    __resetStoreForTests();
  });

  function stubSelect(
    sessionId: string,
    extra?: { items?: unknown[]; changes?: unknown[] },
  ): void {
    const g = globalThis as unknown as { window?: { desktop?: Record<string, unknown> } };
    g.window = g.window ?? {};
    g.window.desktop = {
      ...(g.window.desktop as object),
      selectSession: vi.fn().mockResolvedValue({
        sessionId,
        cwd: "D:/p",
        items: extra?.items ?? [
          { kind: "text", id: `${sessionId}-x`, role: "user", text: "loaded" },
        ],
        total: 1,
        hasMore: false,
        hasNewer: false,
        changes: extra?.changes ?? [],
      }),
      continueSession: async () => ({ sessionId }),
      startSession: async () => ({ sessionId }),
    };
  }

  it("drops an idle session transcript when switching away", async () => {
    runningSession("s1");
    __applySessionEventForTests({
      type: "text_done",
      sessionId: "s1",
      text: "keep-me-on-disk-only",
    });
    expect(getState().itemsBySession.s1.length).toBeGreaterThan(0);

    __upsertSessionForTests({
      id: "s1",
      title: "t",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });
    __upsertSessionForTests({
      id: "s2",
      title: "two",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });
    stubSelect("s2");
    await selectSession("s2");

    expect(getState().itemsBySession.s1).toBeUndefined();
    expect(getState().itemsBySession.s2).toHaveLength(1);
    expect(getState().hasMoreBySession.s1).toBeUndefined();
    expect(getState().hasNewerBySession.s1).toBeUndefined();
  });

  it("keeps a running session cache while viewing another", async () => {
    runningSession("s1");
    __applySessionEventForTests({
      type: "text_done",
      sessionId: "s1",
      text: "live",
    });
    __upsertSessionForTests({
      id: "s2",
      title: "two",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });
    stubSelect("s2");
    await selectSession("s2");

    expect(getState().itemsBySession.s1.some((i) => i.kind === "text" && i.text === "live")).toBe(
      true,
    );
    expect(getState().itemsBySession.s2).toHaveLength(1);
  });

  it("does not rebuild a parked idle session from live events", async () => {
    runningSession("s1");
    __applySessionEventForTests({
      type: "text_done",
      sessionId: "s1",
      text: "old",
    });
    __upsertSessionForTests({
      id: "s1",
      title: "t",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });
    __upsertSessionForTests({
      id: "s2",
      title: "two",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });
    stubSelect("s2");
    await selectSession("s2");
    expect(getState().itemsBySession.s1).toBeUndefined();

    __applySessionEventForTests({
      type: "text_done",
      sessionId: "s1",
      text: "should-not-rebuild",
    });
    expect(getState().itemsBySession.s1).toBeUndefined();
  });

  it("reloads the tail when switching back to a session scrolled into history", async () => {
    __upsertSessionForTests({
      id: "s1",
      title: "one",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });
    __upsertSessionForTests({
      id: "s2",
      title: "two",
      cwd: "D:/p",
      updatedAt: Date.now(),
      status: "idle",
    });
    stubSelect("s1", {
      items: Array.from({ length: TRANSCRIPT_TURN_WINDOW }, (_, i) =>
        userItem(`s1-${i}`, `msg-${i}`),
      ),
    });
    await selectSession("s1");
    expect(getState().itemsBySession.s1).toHaveLength(TRANSCRIPT_TURN_WINDOW);

    const g = globalThis as unknown as { window?: { desktop?: Record<string, unknown> } };
    const desktop = g.window!.desktop as {
      loadOlderMessages: ReturnType<typeof vi.fn>;
      selectSession: ReturnType<typeof vi.fn>;
    };
    desktop.loadOlderMessages = vi.fn().mockResolvedValue({
      items: Array.from({ length: 8 }, (_, i) => userItem(`old-${i}`, `old-${i}`)),
      total: 40,
      hasMore: true,
      hasNewer: true,
    });
    await loadOlderMessages("s1");
    expect(getState().hasNewerBySession.s1).toBe(true);

    stubSelect("s2");
    await selectSession("s2");

    stubSelect("s1", {
      items: Array.from({ length: 8 }, (_, i) =>
        textItem(`tail-${i}`, `tail-${i}`),
      ),
    });
    await selectSession("s1");

    const again = g.window!.desktop as { selectSession: ReturnType<typeof vi.fn> };
    expect(again.selectSession).toHaveBeenCalled();
    expect(getState().hasNewerBySession.s1).toBe(false);
    expect(getState().itemsBySession.s1[0]).toMatchObject({ id: "tail-0" });
  });
});
