import { beforeEach, describe, expect, it, vi } from "vitest";

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

vi.stubGlobal("localStorage", makeStorage());
import {
  isRoomMuted,
  loadRoomMuted,
  roomNotifyBody,
  roomNotifyDecision,
  setRoomMuted,
} from "./room-notify";

beforeEach(() => {
  localStorage.clear();
});

describe("room muted storage", () => {
  it("round-trips per-room mute flags", () => {
    expect(isRoomMuted("r1")).toBe(false);
    setRoomMuted("r1", true);
    setRoomMuted("r2", true);
    expect(isRoomMuted("r1")).toBe(true);
    expect(loadRoomMuted().size).toBe(2);
    setRoomMuted("r1", false);
    expect(isRoomMuted("r1")).toBe(false);
    expect(isRoomMuted("r2")).toBe(true);
  });
});

describe("roomNotifyDecision", () => {
  const base = {
    kind: "user",
    authorUserId: "user-b",
    text: "在吗",
    myUserId: "user-a",
    mySeatId: "human-a",
    seats: [{ id: "human-a", name: "乔尼" }, { id: "other", name: "乔尼" }],
    muted: false,
    isActiveAndFocused: false,
  };

  it("notifies for someone else's message", () => {
    expect(roomNotifyDecision(base)).toEqual({ notify: true, mention: false });
  });

  it("never notifies for my own message", () => {
    expect(
      roomNotifyDecision({ ...base, authorUserId: "user-a" }).notify,
    ).toBe(false);
  });

  it("ignores system/tool/game kinds and system authors", () => {
    expect(roomNotifyDecision({ ...base, kind: "system" }).notify).toBe(false);
    expect(roomNotifyDecision({ ...base, kind: "tool" }).notify).toBe(false);
    expect(roomNotifyDecision({ ...base, authorUserId: null }).notify).toBe(
      false,
    );
  });

  it("ignores recalled messages", () => {
    expect(roomNotifyDecision({ ...base, recalled: true }).notify).toBe(false);
  });

  it("detects @me by validated seat metadata", () => {
    const d = roomNotifyDecision({ ...base, text: "@乔尼 看下这个", mentions: [{ seatId: "human-a", start: 0, end: 3 }] });
    expect(d).toEqual({ notify: true, mention: true });
  });

  it("muted room: normal messages suppressed, @me still pops", () => {
    expect(roomNotifyDecision({ ...base, muted: true }).notify).toBe(false);
    const d = roomNotifyDecision({
      ...base,
      muted: true,
      text: "@乔尼 在吗",
      mentions: [{ seatId: "human-a", start: 0, end: 3 }],
    });
    expect(d).toEqual({ notify: true, mention: true });
  });

  it("suppresses everything while the room is active and focused", () => {
    expect(
      roomNotifyDecision({ ...base, isActiveAndFocused: true }).notify,
    ).toBe(false);
    expect(
      roomNotifyDecision({
        ...base,
        isActiveAndFocused: true,
        text: "@乔尼 hi",
      }).notify,
    ).toBe(false);
  });

  it("ordinary assistant prose does not produce extra notifications", () => {
    expect(roomNotifyDecision({ ...base, kind: "assistant" }).notify).toBe(
      false,
    );
  });
  it("notifies for a structured assistant tool mention with a null author", () => {
    expect(roomNotifyDecision({ ...base, kind: "assistant", authorUserId: null,
      text: "@乔尼 看下", mentions: [{ seatId: "human-a", start: 0, end: 3 }], muted: true,
    })).toEqual({ notify: true, mention: true });
  });
  it("does not treat pasted names, duplicate display names or invalid ranges as @me", () => {
    for (const mentions of [undefined, [{ seatId: "other", start: 0, end: 3 }], [{ seatId: "human-a", start: 1, end: 4 }]]) {
      expect(roomNotifyDecision({ ...base, text: "@乔尼 看下", muted: true, mentions }))
        .toEqual({ notify: false, mention: false });
    }
  });
});

describe("roomNotifyBody", () => {
  it("prefixes [有人@我] on mentions and truncates", () => {
    expect(roomNotifyBody("@乔尼 看下", true)).toBe("[有人@我] @乔尼 看下");
    expect(roomNotifyBody("普通消息", false)).toBe("普通消息");
    const long = "x".repeat(200);
    expect(roomNotifyBody(long, false).length).toBe(120);
  });

  it("collapses newlines for the notification body", () => {
    expect(roomNotifyBody("a\nb\nc", false)).toBe("a b c");
  });
});
