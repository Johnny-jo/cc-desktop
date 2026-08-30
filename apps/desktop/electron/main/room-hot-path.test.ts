import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@claude-desktop/shared";
import type { RoomArchive } from "./room-archive";
import { RoomMetrics } from "./room-metrics";
import { ROOM_PERSIST_DEBOUNCE_MS, RoomService } from "./room-service";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

const dirs: string[] = [];
const services: RoomService[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const service of services.splice(0)) service.disposeAll();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-hot-path-"));
  dirs.push(userDataDir);
  const saveRoom = vi.fn();
  const archive = {
    database: null,
    loadIndex: () => [],
    saveRoom,
    removeRoom: vi.fn(),
  } as unknown as RoomArchive;
  const sendToAllWindows = vi.fn();
  const service = new RoomService({
    getWindow: () => null,
    sendToAllWindows,
    sessions: {
      syncExtras: vi.fn(),
      abort: vi.fn(),
    } as unknown as SessionManager,
    settings: {
      get: () => ({ lastProjectPath: userDataDir }),
    } as unknown as SettingsStore,
    archive,
    userDataDir,
    metrics: new RoomMetrics(() => undefined),
  });
  services.push(service);

  const room = {
    roomId: "room-hot",
    name: "hot",
    password: "",
    port: 18765,
    requireMods: false,
    autoApprove: true,
    encrypt: true,
    hostFingerprint: "",
    deviceKeys: {},
    connections: new Map(),
    pendingByFp: new Map(),
    blacklist: new Set(),
    knownDevices: new Map(),
    modChecksum: "",
    status: "open",
    hostUserId: "host",
    hostLabel: "host",
    localUserId: "host",
    localRole: "host",
    members: [{ userId: "host", name: "host", role: "host", online: true }],
    seats: [],
    items: [],
    seq: 1,
    server: null,
    guests: new Set(),
    client: null,
  };
  const internals = service as unknown as {
    rooms: Map<string, typeof room>;
    append: (
      target: typeof room,
      item: { kind: "system"; text: string; authorLabel: string },
    ) => void;
    pushState: (target: typeof room) => void;
    pushLive: (target: typeof room) => void;
  };
  internals.rooms.set(room.roomId, room);
  return { internals, room, saveRoom, sendToAllWindows };
}

describe("Room hot path", () => {
  it("coalesces append + repeated pushState into one 400ms save", () => {
    vi.useFakeTimers();
    const { internals, room, saveRoom } = fixture();

    internals.append(room, {
      kind: "system",
      text: "one",
      authorLabel: "system",
    });
    internals.pushState(room);
    internals.pushState(room);

    vi.advanceTimersByTime(ROOM_PERSIST_DEBOUNCE_MS - 1);
    expect(saveRoom).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(saveRoom).toHaveBeenCalledTimes(1);
    expect(saveRoom.mock.calls[0]?.[0].items).toHaveLength(1);
  });

  it("sends live progress as a small patch and never persists it", () => {
    const { internals, room, saveRoom, sendToAllWindows } = fixture();
    const guestSend = vi.fn();
    room.guests.add({ readyState: 1, send: guestSend } as never);
    Object.assign(room, {
      liveExec: new Map([
        [
          "turn-1",
          {
            turnId: "turn-1",
            seatId: "seat-1",
            text: "stream",
            at: 1,
          },
        ],
      ]),
    });

    internals.pushLive(room);

    expect(saveRoom).not.toHaveBeenCalled();
    expect(sendToAllWindows).toHaveBeenCalledWith(
      IPC.roomEvent,
      expect.objectContaining({
        roomId: room.roomId,
        livePatch: {
          liveExec: [expect.objectContaining({ text: "stream" })],
        },
      }),
    );
    const frame = JSON.parse(guestSend.mock.calls[0]?.[0] as string) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(frame.type).toBe("state.live");
    expect(frame.payload).not.toHaveProperty("items");
  });
});
