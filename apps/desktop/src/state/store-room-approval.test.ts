import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IPC,
  type PublicSettings,
  type RoomPermAskPayload,
} from "@claude-desktop/shared";
import type { DesktopApi } from "../lib/desktop-api";
import { RoomPermAskModal } from "../components/RoomPermAskModal";
import {
  __resetStoreForTests,
  bootstrapStore,
  clearRoomPermAsk,
  getState,
  respondRoomPermAsk,
  subscribe,
} from "./store";

type DesktopListener = (...args: unknown[]) => void;

function createDesktopBoundary() {
  const listeners = new Map<string, Set<DesktopListener>>();
  const settings: PublicSettings = {
    cpaExePath: "",
    cpaConfigPath: "",
    cpaPort: 8317,
    defaultModel: "test-model",
    models: [],
    permissionMode: "default",
    shutdownCpaOnQuit: false,
    defaultContextLimit: 200_000,
    modelContextLimits: {},
    hasToken: false,
  };
  const desktop = {
    on(channel: string, listener: DesktopListener) {
      const channelListeners = listeners.get(channel) ?? new Set<DesktopListener>();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => { channelListeners.delete(listener); };
    },
    getSettings: async () => settings,
    getCpaStatus: async () => ({ state: "unknown" as const }),
    listSessions: async () => [],
    respondRoomPermAsk: vi.fn<DesktopApi["respondRoomPermAsk"]>()
      .mockResolvedValue({ ok: true }),
  } satisfies Pick<DesktopApi,
    "on" | "getSettings" | "getCpaStatus" | "listSessions" | "respondRoomPermAsk"
  >;
  return {
    desktop,
    emit(payload: RoomPermAskPayload | {
      roomId: string;
      requestId: string;
      resolved: true;
    }) {
      for (const listener of listeners.get(IPC.roomPermAsk) ?? []) listener(payload);
    },
  };
}

function ask(requestId: string, roomId = "room-1"): RoomPermAskPayload {
  return {
    requestId,
    roomId,
    roomName: `Room ${roomId}`,
    requesterName: `Requester ${requestId}`,
    seatName: `Seat ${requestId}`,
    projectPath: `D:/projects/${roomId}`,
    text: `Task ${requestId}`,
  };
}

function deferredResponse() {
  let resolve!: (value: { ok: boolean }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ ok: boolean }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function expectPending(...requests: RoomPermAskPayload[]) {
  expect(getState().roomPermAsk).toBe(requests[0] ?? null);
  expect(getState().roomPermAskQueue).toEqual(requests);
}

let boundary: ReturnType<typeof createDesktopBoundary>;

beforeEach(async () => {
  __resetStoreForTests();
  boundary = createDesktopBoundary();
  vi.stubGlobal("window", { desktop: boundary.desktop });
  await bootstrapStore();
  expect(getState().lastError).toBeNull();
});

afterEach(() => {
  __resetStoreForTests();
  vi.unstubAllGlobals();
});

describe("room approval queue through desktop subscriptions", () => {
  it("starts with no pending approval", () => {
    expectPending();
  });

  it("keeps requests from different rooms in arrival order with an atomic head", () => {
    const a = ask("A");
    const b = ask("B", "room-2");
    const observed: ReturnType<typeof getState>[] = [];
    const unsubscribe = subscribe(() => {
      observed.push(getState());
    });
    try {
      boundary.emit(a);
      boundary.emit(b);
      expectPending(a, b);
      expect(observed.map((state) => state.roomPermAsk?.requestId)).toEqual(["A", "A"]);
      for (const state of observed) {
        expect(state.roomPermAsk).toBe(state.roomPermAskQueue[0]);
      }
    } finally {
      unsubscribe();
    }
  });

  it.each([true, false])("advances to B after answering A with allow=%s", async (allow) => {
    const a = ask("A");
    const b = ask("B");
    boundary.emit(a);
    boundary.emit(b);

    await respondRoomPermAsk("A", allow);

    expectPending(b);
    expect(boundary.desktop.respondRoomPermAsk).toHaveBeenCalledWith("A", allow);
    await respondRoomPermAsk("B", false);
    expectPending();
  });

  it("advances FIFO when another window resolves the head", () => {
    const a = ask("A");
    const b = ask("B");
    const c = ask("C");
    [a, b, c].forEach(boundary.emit);

    boundary.emit({ roomId: a.roomId, requestId: "A", resolved: true });
    expectPending(b, c);
    boundary.emit({ roomId: b.roomId, requestId: "B", resolved: true });
    expectPending(c);
    boundary.emit({ roomId: c.roomId, requestId: "C", resolved: true });
    expectPending();
  });

  it.each(["B", "C"])("removes only non-head resolved request %s", (requestId) => {
    const a = ask("A");
    const b = ask("B");
    const c = ask("C");
    [a, b, c].forEach(boundary.emit);

    boundary.emit({ roomId: a.roomId, requestId, resolved: true });

    expectPending(a, requestId === "B" ? c : b);
  });

  it("ignores duplicate IDs without replacing payloads or reordering requests", async () => {
    const a = ask("A");
    const b = ask("B");
    boundary.emit(a);
    boundary.emit(b);
    boundary.emit({ ...a, text: "duplicate A" });
    boundary.emit({ ...b, text: "duplicate B" });

    expectPending(a, b);
    await respondRoomPermAsk("A", true);
    expectPending(b);
    await respondRoomPermAsk("B", true);
    expectPending();
  });

  it("ignores unknown and repeated resolved events", () => {
    const a = ask("A");
    const b = ask("B");
    boundary.emit(a);
    boundary.emit(b);
    boundary.emit({ roomId: a.roomId, requestId: "unknown", resolved: true });
    expectPending(a, b);
    boundary.emit({ roomId: a.roomId, requestId: "A", resolved: true });
    boundary.emit({ roomId: a.roomId, requestId: "A", resolved: true });
    expectPending(b);
  });

  it("clears the entire queue and permits fresh approvals", () => {
    boundary.emit(ask("A"));
    boundary.emit(ask("B"));

    clearRoomPermAsk();
    expectPending();
    const next = ask("A");
    boundary.emit(next);
    boundary.emit({ roomId: "room-1", requestId: "B", resolved: true });
    expectPending(next);
  });

  it("resets the queue and removes old subscriptions before bootstrapping again", async () => {
    boundary.emit(ask("A"));
    boundary.emit(ask("B"));

    __resetStoreForTests();
    expectPending();
    boundary.emit(ask("ignored-before-bootstrap"));
    expectPending();
    await bootstrapStore();
    const next = ask("A");
    boundary.emit(next);
    expectPending(next);
  });

  it("preserves approvals arriving while a local response is pending", async () => {
    const a = ask("A");
    const b = ask("B");
    const pending = deferredResponse();
    boundary.desktop.respondRoomPermAsk.mockReturnValueOnce(pending.promise);
    boundary.emit(a);
    const response = respondRoomPermAsk("A", true);
    boundary.emit(b);
    pending.resolve({ ok: true });
    await response;

    expectPending(b);
  });

  it("does not advance again when resolved arrives before the response completes", async () => {
    const a = ask("A");
    const b = ask("B");
    const c = ask("C");
    const pending = deferredResponse();
    boundary.desktop.respondRoomPermAsk.mockReturnValueOnce(pending.promise);
    boundary.emit(a);
    boundary.emit(b);
    const response = respondRoomPermAsk("A", true);
    boundary.emit({ roomId: a.roomId, requestId: "A", resolved: true });
    boundary.emit(c);
    pending.resolve({ ok: true });
    await response;

    expectPending(b, c);
  });

  it("preserves C when concurrent responses finish in reverse order", async () => {
    const c = ask("C");
    const pendingA = deferredResponse();
    const pendingB = deferredResponse();
    boundary.desktop.respondRoomPermAsk
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);
    [ask("A"), ask("B"), c].forEach(boundary.emit);
    const responseA = respondRoomPermAsk("A", true);
    boundary.emit({ roomId: "room-1", requestId: "A", resolved: true });
    const responseB = respondRoomPermAsk("B", false);
    pendingB.resolve({ ok: true });
    await responseB;
    pendingA.resolve({ ok: true });
    await responseA;

    expectPending(c);
  });

  it("limits existing failure cleanup to the answered request", async () => {
    const b = ask("B");
    const pending = deferredResponse();
    boundary.desktop.respondRoomPermAsk.mockReturnValueOnce(pending.promise);
    boundary.emit(ask("A"));
    boundary.emit(b);
    const response = respondRoomPermAsk("A", true);
    pending.reject(new Error("desktop disconnected"));
    await expect(response).rejects.toThrow("desktop disconnected");

    expectPending(b);
  });

  it.each(["clear", "reset"])("ignores a stale response after %s and ID reuse", async (action) => {
    const pending = deferredResponse();
    boundary.desktop.respondRoomPermAsk.mockReturnValueOnce(pending.promise);
    boundary.emit(ask("A"));
    const response = respondRoomPermAsk("A", true);
    if (action === "clear") {
      clearRoomPermAsk();
    } else {
      __resetStoreForTests();
      await bootstrapStore();
    }
    const next = ask("A", "room-2");
    boundary.emit(next);
    pending.resolve({ ok: true });
    await response;

    expectPending(next);
  });

  it("does not remove a later request when the response started without a match", async () => {
    const pending = deferredResponse();
    boundary.desktop.respondRoomPermAsk.mockReturnValueOnce(pending.promise);
    const response = respondRoomPermAsk("A", false);
    const next = ask("A");
    boundary.emit(next);
    pending.resolve({ ok: true });
    await response;

    expectPending(next);
  });
});

describe("RoomPermAskModal with the real store", () => {
  function renderModal() {
    return renderToStaticMarkup(React.createElement(RoomPermAskModal));
  }

  it("renders nothing for an empty queue", () => {
    expect(renderModal()).toBe("");
  });

  it("shows the pending count including the current approval", () => {
    boundary.emit(ask("A"));
    expect(renderModal()).toContain("待审批：1");
    boundary.emit(ask("B"));
    expect(renderModal()).toContain("待审批：2");
    boundary.emit({ roomId: "room-1", requestId: "B", resolved: true });
    expect(renderModal()).toContain("待审批：1");
  });

  it("shows the head as approvals advance", async () => {
    boundary.emit(ask("A"));
    boundary.emit(ask("B"));
    const initial = renderModal();
    expect(initial).toContain("Task A");
    expect(initial).not.toContain("Task B");
    expect(initial).toContain("待审批：2");

    await respondRoomPermAsk("A", true);
    const next = renderModal();
    expect(next).toContain("Task B");
    expect(next).not.toContain("Task A");
    expect(next).toContain("待审批：1");

    boundary.emit({ roomId: "room-1", requestId: "B", resolved: true });
    expect(renderModal()).toBe("");
  });
});
