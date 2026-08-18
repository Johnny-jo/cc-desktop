import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { hashModFiles } from "@claude-desktop/shared/mod-hash";
import {
  ROOM_PROTOCOL_VERSION,
  makeRoomFrame,
  parseRoomFrame,
  type ModOfferPayload,
  type RoomSnapshot,
} from "@claude-desktop/shared";
import { RoomService, ROOM_MOD_BUNDLE_CHUNK } from "./room-service";
import { loadModCache } from "./mod-package";
import { parseKernelManifest } from "./mod-kernel";
import { getKernelCacheDir } from "./runtime-paths";
import { RoomArchive } from "./room-archive";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";
import type { RuntimePathEnv } from "./runtime-paths";

const dirs: string[] = [];
const services: RoomService[] = [];

afterEach(() => {
  for (const s of [...services].reverse()) {
    try {
      s.disposeAll();
    } catch {
      // ignore
    }
  }
  services.length = 0;
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dirs.length = 0;
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-mod-"));
  dirs.push(d);
  return d;
}

const FIXTURE_HOST = `
export function createGame() {
  return {
    initialState() { return { n: 0, phase: "lobby", secrets: {}, agentIds: {} }; },
    reduce(state, intent, ctx) {
      if (intent.name === "boom") throw new Error("boom");
      if (intent.name === "mod.start") {
        const secrets = {};
        const agentIds = {};
        for (const s of ctx.seats) {
          secrets[s.id] = "priv-" + s.id;
          if (s.kind === "agent") agentIds[s.id] = true;
        }
        return { n: 0, phase: "play", secrets: secrets, agentIds: agentIds };
      }
      if (intent.name === "mod.end") {
        return Object.assign({}, state, { phase: "ended" });
      }
      if (intent.name === "inc") {
        return Object.assign({}, state, { n: state.n + 1 });
      }
      return state;
    },
    getPublicView(state) { return { n: state.n, phase: state.phase }; },
    getSeatView(state, seatId) {
      return { n: state.n, seatId: seatId, secret: state.secrets[seatId] || null };
    },
    getActions() { return [{ name: "inc" }]; },
    getPrompt() { return "increment"; },
    shouldPromptAgent(state, seatId) { return Boolean(state.agentIds && state.agentIds[seatId]); },
  };
}
`;

const FIXTURE_MANIFEST = {
  id: "fixture-counter",
  name: "Fixture",
  version: "1.0.0",
  hostApi: 1,
  permissions: [] as string[],
  seats: { min: 2, max: 4, roles: [] as string[] },
  agent: true,
};

function writeFixture(dir: string, hostJs = FIXTURE_HOST): {
  dir: string;
  checksum: string;
  manifestSource: string;
  hostJs: string;
} {
  fs.mkdirSync(dir, { recursive: true });
  const manifestSource = JSON.stringify(FIXTURE_MANIFEST, null, 2);
  fs.writeFileSync(path.join(dir, "manifest.json"), manifestSource, "utf8");
  fs.writeFileSync(path.join(dir, "host.js"), hostJs, "utf8");
  return {
    dir,
    checksum: hashModFiles(manifestSource, hostJs),
    manifestSource,
    hostJs,
  };
}

type RoomEvent = {
  roomId: string;
  room?: RoomSnapshot;
  mod?: {
    offer?: ModOfferPayload;
    publicView?: unknown;
    seatView?: unknown;
    seatViews?: Record<string, unknown>;
    seq?: number;
    fail?: string;
    actions?: Record<string, { params?: unknown; hint?: string }>;
  };
};

function mockWindow(events: RoomEvent[]) {
  return () =>
    ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (_ch: string, payload: RoomEvent) => {
          events.push(payload);
        },
      },
    }) as never;
}

function mockSessions() {
  return {
    start: vi.fn().mockResolvedValue("sess-agent"),
    continue: vi.fn().mockResolvedValue(undefined),
    getTranscript: vi.fn().mockReturnValue([]),
    abort: vi.fn(),
    syncExtras: vi.fn(),
  } as unknown as SessionManager & {
    start: ReturnType<typeof vi.fn>;
    continue: ReturnType<typeof vi.fn>;
    getTranscript: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    syncExtras: ReturnType<typeof vi.fn>;
  };
}

function mockSettings(project: string) {
  return {
    get: vi.fn().mockReturnValue({ lastProjectPath: project }),
  } as unknown as SettingsStore;
}

function makeRooms(opts?: {
  events?: RoomEvent[];
  sessions?: SessionManager;
  userDataDir?: string;
  archive?: RoomArchive | null;
}): { rooms: RoomService; sessions: ReturnType<typeof mockSessions>; userDataDir: string } {
  const userDataDir = opts?.userDataDir ?? tmp();
  const sessions = (opts?.sessions ?? mockSessions()) as ReturnType<typeof mockSessions>;
  const rooms = new RoomService({
    getWindow: mockWindow(opts?.events ?? []),
    sessions,
    settings: mockSettings(userDataDir),
    userDataDir,
    archive: opts?.archive ?? null,
  });
  services.push(rooms);
  return { rooms, sessions, userDataDir };
}

async function createHost(
  rooms: RoomService,
  name = "t",
): Promise<{ room: RoomSnapshot; port: number }> {
  let last = "";
  for (let i = 0; i < 10; i++) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const res = await rooms.create({ name, port });
    if (res.ok && res.room) return { room: res.room, port };
    last = res.error ?? "create failed";
  }
  throw new Error(last);
}

function waitOpen(ws: WebSocket, ms = 5000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), ms);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function waitType(
  ws: WebSocket,
  type: string,
  ms = 5000,
): Promise<ReturnType<typeof parseRoomFrame>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${type}`)), ms);
    const onMsg = (data: import("ws").RawData) => {
      const frame = parseRoomFrame(String(data));
      if (frame?.type === type || frame?.type === "error") {
        clearTimeout(t);
        ws.off("message", onMsg);
        resolve(frame);
      }
    };
    ws.on("message", onMsg);
  });
}

function envFor(userDataDir: string): RuntimePathEnv {
  return { isPackaged: false, userDataDir, platform: "win32" };
}

describe("room mod handshake + play loop", () => {
  it("host enable + guest hello receives offer with real checksum (no join)", async () => {
    const { rooms } = makeRooms();
    const pack = writeFixture(path.join(tmp(), "pack"));
    const { room, port } = await createHost(rooms);
    const en = await rooms.enableMod(room.roomId, pack.dir);
    expect(en.ok).toBe(true);
    expect(en.offer?.checksum).toBe(pack.checksum);

    const beforeMembers = rooms.get(room.roomId)!.members.length;
    const beforeSeats = rooms.get(room.roomId)!.seats.length;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    const pending = waitType(ws, "mod.offer");
    ws.send(
      JSON.stringify(
        makeRoomFrame("pending", 1, "hello", { protocol: ROOM_PROTOCOL_VERSION }),
      ),
    );
    const frame = await pending;
    ws.close();
    expect(frame?.type).toBe("mod.offer");
    const offer = frame?.payload as ModOfferPayload;
    expect(offer.checksum).toBe(pack.checksum);
    expect(offer.size).toBeGreaterThan(0);
    expect(offer.id).toBe("fixture-counter");

    const snap = rooms.get(room.roomId)!;
    expect(snap.members.length).toBe(beforeMembers);
    expect(snap.seats.length).toBe(beforeSeats);

    const peeked = await rooms.peek({ host: "127.0.0.1", port });
    expect(peeked.ok).toBe(true);
    expect(peeked.offer?.checksum).toBe(pack.checksum);
  });

  it("guest join without checksum rejected; matching checksum accepted", async () => {
    const { rooms } = makeRooms();
    const pack = writeFixture(path.join(tmp(), "pack"));
    const { room, port } = await createHost(rooms);
    await rooms.enableMod(room.roomId, pack.dir);

    const guestBad = makeRooms();
    const no = await guestBad.rooms.join({
      host: "127.0.0.1",
      port,
    });
    expect(no.ok).toBe(false);
    expect(no.error).toMatch(/模组校验码不一致/);

    const guestOk = makeRooms();
    const yes = await guestOk.rooms.join({
      host: "127.0.0.1",
      port,
      modChecksum: pack.checksum,
    });
    expect(yes.ok).toBe(true);
    expect(yes.room?.modChecksum).toBe(pack.checksum);
    expect(rooms.get(room.roomId)!.members.length).toBe(2);
  });

  it("guest fetch writes cache matching hashModFiles", async () => {
    const { rooms } = makeRooms();
    const pack = writeFixture(path.join(tmp(), "pack"));
    const { room, port } = await createHost(rooms);
    await rooms.enableMod(room.roomId, pack.dir);

    const guestDir = tmp();
    const guest = makeRooms({ userDataDir: guestDir });
    const fetched = await guest.rooms.fetchMod({
      host: "127.0.0.1",
      port,
      checksum: pack.checksum,
    });
    expect(fetched.ok).toBe(true);
    expect(fetched.checksum).toBe(pack.checksum);
    const cached = loadModCache(envFor(guestDir), pack.checksum);
    expect(cached.checksum).toBe(hashModFiles(pack.manifestSource, pack.hostJs));
    expect(rooms.get(room.roomId)!.members.length).toBe(1);
  });

  it("guest fetch accumulates every bundle chunk when envelope > BUNDLE_CHUNK", async () => {
    const { rooms } = makeRooms();
    const pad = `\n/* ${"x".repeat(ROOM_MOD_BUNDLE_CHUNK)} */\n`;
    const pack = writeFixture(path.join(tmp(), "pack-big"), FIXTURE_HOST + pad);
    expect(Buffer.byteLength(JSON.stringify({
      manifest: pack.manifestSource,
      hostJs: pack.hostJs,
    }), "utf8")).toBeGreaterThan(ROOM_MOD_BUNDLE_CHUNK);

    const { room, port } = await createHost(rooms);
    const en = await rooms.enableMod(room.roomId, pack.dir);
    expect(en.ok).toBe(true);
    expect(en.offer!.size).toBeGreaterThan(ROOM_MOD_BUNDLE_CHUNK);

    const guestDir = tmp();
    const guest = makeRooms({ userDataDir: guestDir });
    const fetched = await guest.rooms.fetchMod({
      host: "127.0.0.1",
      port,
      checksum: pack.checksum,
    });
    expect(fetched.ok).toBe(true);
    expect(fetched.checksum).toBe(pack.checksum);
    const cached = loadModCache(envFor(guestDir), pack.checksum);
    expect(cached.checksum).toBe(hashModFiles(pack.manifestSource, pack.hostJs));
  });

  it("enableMod after join pushStates checksum so guest persist/reconnect uses it", async () => {
    const { rooms } = makeRooms();
    const { room, port } = await createHost(rooms);
    const guestDir = tmp();
    const archive = new RoomArchive(guestDir);
    const guest = makeRooms({ userDataDir: guestDir, archive });
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    expect(joined.ok).toBe(true);
    expect(joined.room?.modChecksum).toBe("");

    const pack = writeFixture(path.join(tmp(), "pack"));
    const en = await rooms.enableMod(room.roomId, pack.dir);
    expect(en.ok).toBe(true);

    await vi.waitFor(() => {
      expect(guest.rooms.get(room.roomId)?.modChecksum).toBe(pack.checksum);
    });
    const stored = archive.loadRoom(room.roomId);
    expect(stored?.join?.modChecksum).toBe(pack.checksum);
    expect(stored?.requireMods).toBe(true);
  });

  it("enableMod rejects a pack whose envelope exceeds 512KB", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms);
    const huge = FIXTURE_HOST + `\n/* ${"y".repeat(520 * 1024)} */\n`;
    const pack = writeFixture(path.join(tmp(), "pack-huge"), huge);
    const en = await rooms.enableMod(room.roomId, pack.dir);
    expect(en.ok).toBe(false);
    expect(en.error).toMatch(/超过|exceeds/);
    expect(rooms.get(room.roomId)!.modChecksum).toBe("");
  });

  it("start rejects if seat count outside min/max", async () => {
    const { rooms } = makeRooms();
    const pack = writeFixture(path.join(tmp(), "pack"));
    const { room } = await createHost(rooms);
    await rooms.enableMod(room.roomId, pack.dir);
    const rejected = await rooms.startMod(room.roomId);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/席位数量/);

    rooms.addSeat(room.roomId, "human", "p2");
    const ok = await rooms.startMod(room.roomId);
    expect(ok.ok).toBe(true);
  });

  it("intent updates publicView for all; private seatView only for occupant; no state on snapshot", async () => {
    const hostEvents: RoomEvent[] = [];
    const guestEvents: RoomEvent[] = [];
    const { rooms } = makeRooms({ events: hostEvents });
    const pack = writeFixture(path.join(tmp(), "pack"));
    const { room, port } = await createHost(rooms);
    await rooms.enableMod(room.roomId, pack.dir);

    const guest = makeRooms({ events: guestEvents });
    const joined = await guest.rooms.join({
      host: "127.0.0.1",
      port,
      modChecksum: pack.checksum,
    });
    expect(joined.ok).toBe(true);
    const started = await rooms.startMod(room.roomId);
    expect(started.ok).toBe(true);

    await vi.waitFor(() => {
      const last = [...guestEvents].reverse().find((e) => e.mod?.publicView);
      expect((last?.mod?.publicView as { n?: number })?.n).toBe(0);
    });

    const guestSnap = guest.rooms.get(joined.room!.roomId)!;
    const guestSeat = guestSnap.seats.find(
      (s) => s.occupantUserId === guestSnap.localUserId,
    );
    expect(guestSeat).toBeTruthy();
    const hostSeat = rooms.get(room.roomId)!.seats.find((s) => s.kind === "human");
    expect(hostSeat).toBeTruthy();

    const act = await guest.rooms.modIntent(
      joined.room!.roomId,
      guestSeat!.id,
      "inc",
      {},
    );
    expect(act.ok).toBe(true);

    await vi.waitFor(() => {
      const g = [...guestEvents].reverse().find((e) => e.mod?.publicView);
      expect((g?.mod?.publicView as { n?: number })?.n).toBe(1);
    });
    await vi.waitFor(() => {
      const h = [...hostEvents].reverse().find((e) => e.mod?.publicView);
      expect((h?.mod?.publicView as { n?: number })?.n).toBe(1);
    });

    const guestMod = [...guestEvents].reverse().find((e) => e.mod?.seatViews)?.mod;
    const hostMod = [...hostEvents].reverse().find((e) => e.mod?.seatViews)?.mod;
    const guestView = (guestMod?.seatViews?.[guestSeat!.id] ??
      guestMod?.seatView) as { secret?: string; seatId?: string };
    const hostView = (hostMod?.seatViews?.[hostSeat!.id] ??
      hostMod?.seatView) as { secret?: string; seatId?: string };

    expect(guestView?.seatId).toBe(guestSeat!.id);
    expect(guestView?.secret).toBe(`priv-${guestSeat!.id}`);
    expect(hostView?.seatId).toBe(hostSeat!.id);
    expect(hostView?.secret).toBe(`priv-${hostSeat!.id}`);
    expect(hostView?.secret).not.toBe(guestView?.secret);
    expect(hostMod?.seatViews?.[guestSeat!.id]).toBeUndefined();
    expect(guestMod?.seatViews?.[hostSeat!.id]).toBeUndefined();
    expect(hostMod?.actions).toHaveProperty("inc");
    expect(guestMod?.actions).toHaveProperty("inc");

    const snap = rooms.get(room.roomId)!;
    expect(snap).not.toHaveProperty("state");
    expect(snap).not.toHaveProperty("publicView");
    expect(JSON.stringify(snap)).not.toContain("priv-");
    expect(JSON.stringify(snap)).not.toMatch(/"secrets"/);
  });

  it("worker/runtime fail keeps room listable and WS open", async () => {
    const { rooms } = makeRooms();
    const pack = writeFixture(path.join(tmp(), "pack"));
    const { room, port } = await createHost(rooms);
    await rooms.enableMod(room.roomId, pack.dir);
    rooms.addSeat(room.roomId, "human", "p2");
    await rooms.startMod(room.roomId);

    const hostSeat = rooms.get(room.roomId)!.seats[0]!;
    const boom = await rooms.modIntent(room.roomId, hostSeat.id, "boom", {});
    expect(boom.ok).toBe(false);

    const listed = rooms.list();
    expect(listed.some((x) => x.roomId === room.roomId && x.status === "open")).toBe(
      true,
    );

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    const pending = waitType(ws, "mod.offer");
    ws.send(
      JSON.stringify(
        makeRoomFrame("pending", 1, "hello", { protocol: ROOM_PROTOCOL_VERSION }),
      ),
    );
    const frame = await pending;
    expect(frame?.type).toBe("mod.offer");
    ws.close();
  });

  it("injects [room_mod] when shouldPromptAgent; skips when false or taken over", async () => {
    const { rooms, sessions } = makeRooms();
    const pack = writeFixture(path.join(tmp(), "pack"));
    const { room } = await createHost(rooms);
    await rooms.enableMod(room.roomId, pack.dir);

    rooms.addSeat(room.roomId, "human", "p2");
    await rooms.startMod(room.roomId);
    await new Promise((r) => setTimeout(r, 40));
    expect(sessions.start).not.toHaveBeenCalled();
    expect(sessions.continue).not.toHaveBeenCalled();

    const { rooms: rooms2, sessions: sess2 } = makeRooms();
    const { room: room2 } = await createHost(rooms2, "t2");
    await rooms2.enableMod(room2.roomId, pack.dir);
    rooms2.addSeat(room2.roomId, "agent", "Bot");
    await rooms2.startMod(room2.roomId);

    await vi.waitFor(() => {
      expect(sess2.start).toHaveBeenCalled();
    });
    const prompt = sess2.start.mock.calls[0]![0] as { text: string };
    expect(prompt.text.startsWith("[room_mod]")).toBe(true);
    expect(sess2.continue).not.toHaveBeenCalled();

    const agentSeat = rooms2
      .get(room2.roomId)!
      .seats.find((s) => s.kind === "agent")!;
    const humanSeat = rooms2
      .get(room2.roomId)!
      .seats.find((s) => s.kind === "human")!;
    const calls = sess2.start.mock.calls.length + sess2.continue.mock.calls.length;
    rooms2.takeover(room2.roomId, agentSeat.id);
    await rooms2.modIntent(room2.roomId, humanSeat.id, "inc", {});
    await new Promise((r) => setTimeout(r, 60));
    expect(sess2.start.mock.calls.length + sess2.continue.mock.calls.length).toBe(
      calls,
    );
  });

  it("lists shared-memory as kernel and projects it on the snapshot", async () => {
    const { rooms } = makeRooms();
    const listed = rooms.listMods().mods;
    expect(listed.some((p) => p.id === "shared-memory" && p.hostApi === 2)).toBe(true);
    expect(listed.some((p) => p.id === "werewolf" && p.hostApi === 1)).toBe(true);
    const { room } = await createHost(rooms, "kmem");
    const mem = listed.find((p) => p.id === "shared-memory")!;
    const en = rooms.enableKernelMod(room.roomId, mem.packDir);
    expect(en.ok).toBe(true);
    const snap = rooms.get(room.roomId)!;
    expect(snap.kernel?.mods.some((m) => m.id === "shared-memory" && m.state === "active")).toBe(
      true,
    );
  });

  it("keeps chat-glossary pending until shared-memory is on, then rewrites chat", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "glossary");
    const listed = rooms.listMods().mods;
    const gloss = listed.find((p) => p.id === "chat-glossary")!;
    const mem = listed.find((p) => p.id === "shared-memory")!;
    expect(gloss).toBeTruthy();
    expect(rooms.enableKernelMod(room.roomId, gloss.packDir).ok).toBe(true);
    expect(
      rooms
        .get(room.roomId)!
        .kernel?.mods.some((m) => m.id === "chat-glossary" && m.state === "pending"),
    ).toBe(true);
    const seatId = room.seats[0]!.id;
    await rooms.send(room.roomId, seatId, "hi");
    await vi.waitFor(() => {
      expect(
        rooms.get(room.roomId)!.items.some((i) => i.kind === "user" && i.text === "hi"),
      ).toBe(true);
    });
    expect(rooms.enableKernelMod(room.roomId, mem.packDir).ok).toBe(true);
    expect(rooms.setKernelMemory(room.roomId, "hi", "你好").ok).toBe(true);
    await rooms.send(room.roomId, seatId, "say hi");
    await vi.waitFor(() => {
      expect(
        rooms.get(room.roomId)!.items.some((i) => i.kind === "user" && i.text === "say 你好"),
      ).toBe(true);
    });
  });

  it("rejects swapping play and kernel enable entry points", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "cross");
    const listed = rooms.listMods().mods;
    const mem = listed.find((p) => p.id === "shared-memory")!;
    const wolf = listed.find((p) => p.id === "werewolf")!;
    const asPlay = await rooms.enableMod(room.roomId, mem.packDir);
    expect(asPlay.ok).toBe(false);
    expect(asPlay.error).toMatch(/房间扩展/);
    const asKernel = rooms.enableKernelMod(room.roomId, wolf.packDir);
    expect(asKernel.ok).toBe(false);
    expect(asKernel.error).toMatch(/玩法模组/);
  });

  it("caches kernel packs and guests see kernel projection without a checksum", async () => {
    const { rooms, userDataDir } = makeRooms();
    const { room, port } = await createHost(rooms, "konly");
    const mem = rooms.listMods().mods.find((p) => p.id === "shared-memory")!;
    expect(rooms.enableKernelMod(room.roomId, mem.packDir).ok).toBe(true);
    const cached = fs.readdirSync(getKernelCacheDir(envFor(userDataDir)));
    expect(cached.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(getKernelCacheDir(envFor(userDataDir)), cached[0]!, "mod.js"))).toBe(
      true,
    );

    const guest = makeRooms();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    expect(joined.ok).toBe(true);
    expect(joined.room?.modChecksum).toBeFalsy();
    expect(
      joined.room?.kernel?.mods.some((m) => m.id === "shared-memory" && m.state === "active"),
    ).toBe(true);
  });

  it("attaches improve MCP extras when a kernel pack is on, and removes them on unload", async () => {
    const { rooms, sessions } = makeRooms();
    const { room } = await createHost(rooms, "improve-mcp");
    const pulse = rooms.listMods().mods.find((p) => p.id === "room-pulse")!;
    expect(rooms.enableKernelMod(room.roomId, pulse.packDir).ok).toBe(true);
    rooms.addSeat(room.roomId, "agent", "ImpBot");
    const agent = rooms.get(room.roomId)!.seats.find((s) => s.kind === "agent")!;
    await rooms.send(room.roomId, agent.id, "can you improve?");
    await vi.waitFor(() => {
      expect(sessions.start).toHaveBeenCalled();
    });
    const extras = sessions.start.mock.calls[0]![2] as {
      extraMcpServers?: Record<string, unknown>;
      extraAllowedTools?: string[];
    };
    expect(extras.extraMcpServers?.["mod-improve"]).toBeTruthy();
    expect(extras.extraAllowedTools).toEqual(
      expect.arrayContaining(["kernel_propose", "mcp__mod-improve__kernel_propose"]),
    );
    expect(extras.extraMcpServers?.["mod-memory"]).toBeUndefined();
    expect(rooms.disableKernelMod(room.roomId, "room-pulse").ok).toBe(true);
    const leftover = sessions.syncExtras.mock.calls.at(-1)![1] as {
      extraMcpServers?: Record<string, unknown>;
    };
    expect(leftover.extraMcpServers?.["mod-improve"]).toBeUndefined();
  });

  it("attaches memory MCP extras when an agent seat is spoken to", async () => {
    const { rooms, sessions } = makeRooms();
    const { room } = await createHost(rooms, "kmem-agent");
    const mem = rooms.listMods().mods.find((p) => p.id === "shared-memory")!;
    expect(rooms.enableKernelMod(room.roomId, mem.packDir).ok).toBe(true);
    rooms.addSeat(room.roomId, "agent", "MemBot");
    const agent = rooms.get(room.roomId)!.seats.find((s) => s.kind === "agent")!;
    await rooms.send(room.roomId, agent.id, "remember foo=bar");
    await vi.waitFor(() => {
      expect(sessions.start).toHaveBeenCalled();
    });
    const extras = sessions.start.mock.calls[0]![2] as {
      extraMcpServers?: Record<string, unknown>;
      extraAllowedTools?: string[];
      replaceExtras?: boolean;
    };
    expect(extras.replaceExtras).toBe(true);
    expect(extras.extraMcpServers?.["mod-memory"]).toBeTruthy();
    expect(extras.extraMcpServers?.["mod-improve"]).toBeTruthy();
    expect(extras.extraAllowedTools).toEqual(
      expect.arrayContaining(["memory_set", "mcp__mod-memory__memory_set", "kernel_propose"]),
    );
  });

  it("lets the host list, write, and delete shared-memory entries", () => {
    const { rooms } = makeRooms();
    return createHost(rooms, "kmem-kv").then(async ({ room }) => {
      const mem = rooms.listMods().mods.find((p) => p.id === "shared-memory")!;
      expect(rooms.enableKernelMod(room.roomId, mem.packDir).ok).toBe(true);
      expect(rooms.setKernelMemory(room.roomId, "topic", "airport").ok).toBe(true);
      const listed = rooms.listKernelMemory(room.roomId);
      expect(listed.ok).toBe(true);
      expect(listed.entries).toEqual([{ key: "topic", value: "airport" }]);
      expect(rooms.deleteKernelMemory(room.roomId, "topic").ok).toBe(true);
      expect(rooms.listKernelMemory(room.roomId).entries).toEqual([]);
    });
  });

  it("disables a kernel pack and syncs extras off live agent seats", async () => {
    const { rooms, sessions } = makeRooms();
    const { room } = await createHost(rooms, "kmem-off");
    const mem = rooms.listMods().mods.find((p) => p.id === "shared-memory")!;
    expect(rooms.enableKernelMod(room.roomId, mem.packDir).ok).toBe(true);
    rooms.addSeat(room.roomId, "agent", "MemBot");
    const agent = rooms.get(room.roomId)!.seats.find((s) => s.kind === "agent")!;
    await rooms.send(room.roomId, agent.id, "hi");
    await vi.waitFor(() => {
      expect(sessions.start).toHaveBeenCalled();
    });
    const off = rooms.disableKernelMod(room.roomId, "shared-memory");
    expect(off.ok).toBe(true);
    const snap = rooms.get(room.roomId)!;
    expect(
      snap.kernel?.mods.some((m) => m.id === "shared-memory" && m.state === "active") ?? false,
    ).toBe(false);
    expect(sessions.syncExtras).toHaveBeenCalled();
    const leftover = sessions.syncExtras.mock.calls[0]![1] as {
      extraMcpServers?: Record<string, unknown>;
    };
    expect(leftover.extraMcpServers?.["mod-memory"]).toBeUndefined();
  });

  it("ticks schedule jobs without writing pulse text to the timeline", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "pulse");
    const pulse = rooms.listMods().mods.find((p) => p.id === "room-pulse")!;
    expect(pulse).toBeTruthy();
    expect(rooms.enableKernelMod(room.roomId, pulse.packDir).ok).toBe(true);
    const before = rooms.get(room.roomId)!.items.length;
    const ticked = await rooms.tickKernelSchedule(room.roomId);
    expect(ticked.ok).toBe(true);
    const snap = rooms.get(room.roomId)!;
    expect(snap.items.length).toBe(before);
    expect(snap.items.some((i) => i.text === "房间心跳")).toBe(false);
    expect(snap.kernel?.mods.some((m) => m.id === "room-pulse" && m.state === "active")).toBe(
      true,
    );
    expect(rooms.disableKernelMod(room.roomId, "room-pulse").ok).toBe(true);
    const after = rooms.get(room.roomId)!.items.length;
    await rooms.tickKernelSchedule(room.roomId);
    expect(rooms.get(room.roomId)!.items.length).toBe(after);
  });

  it("skips a hook pack after it hits budget.hookPerMin", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "budget");
    const started = rooms.startKernel(room.roomId, [
      {
        manifest: parseKernelManifest({
          id: "once",
          version: "1.0.0",
          hostApi: 2,
          hooks: ["room.chat.in"],
          budget: { hookPerMin: 1 },
        }),
        activate: (ctx) => {
          ctx.hooks.on("room.chat.in", (env) => ({
            action: "replace",
            value: { ...env, text: "once" },
          }));
        },
      },
    ]);
    expect(started.ok).toBe(true);
    const seatId = room.seats[0]!.id;
    await rooms.send(room.roomId, seatId, "first");
    await vi.waitFor(() => {
      expect(
        rooms.get(room.roomId)!.items.some((i) => i.kind === "user" && i.text === "once"),
      ).toBe(true);
    });
    await rooms.send(room.roomId, seatId, "second");
    await vi.waitFor(() => {
      expect(
        rooms.get(room.roomId)!.items.some((i) => i.kind === "user" && i.text === "second"),
      ).toBe(true);
    });
  });

  it("rewrites and drops inbound chat through kernel railway", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "hook");
    const started = rooms.startKernel(room.roomId, [
      {
        manifest: parseKernelManifest({
          id: "filter",
          version: "1.0.0",
          hostApi: 2,
          hooks: ["room.chat.in"],
        }),
        activate: (ctx) => {
          ctx.hooks.on("room.chat.in", (env) => {
            if (env.text === "dropme") return { action: "drop", reason: "nope" };
            return { action: "replace", value: { ...env, text: "rewritten" } };
          });
        },
      },
    ]);
    expect(started.ok).toBe(true);
    const seatId = room.seats[0]!.id;
    await rooms.send(room.roomId, seatId, "hello");
    await vi.waitFor(() => {
      const items = rooms.get(room.roomId)!.items;
      expect(items.some((i) => i.kind === "user" && i.text === "rewritten")).toBe(
        true,
      );
    });
    await rooms.send(room.roomId, seatId, "dropme");
    await vi.waitFor(() => {
      const items = rooms.get(room.roomId)!.items;
      expect(items.some((i) => i.kind === "user" && i.text === "dropme")).toBe(
        false,
      );
      expect(items.some((i) => i.text.includes("消息被模组丢弃"))).toBe(true);
      expect(items.some((i) => i.source === "kernel")).toBe(true);
    });
  });

  const HOOK_V1 = `
    export function activate(ctx) {
      ctx.hooks.on("room.chat.in", function (env) {
        return { action: "replace", value: Object.assign({}, env, { text: "v1" }) };
      });
    }
  `;
  const HOOK_V2 = HOOK_V1.replace("v1", "v2");

  function writeKernelHook(dir: string, id: string, modJs: string): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        hostApi: 2,
        inject: [],
        provides: [],
        permissions: [],
        hooks: ["room.chat.in"],
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "mod.js"), modJs, "utf8");
    return dir;
  }

  it("parks L0 proposals until the host applies them", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "improve-l0");
    const dir = writeKernelHook(path.join(tmp(), "hook"), "rewriter", HOOK_V1);
    expect(rooms.enableKernelMod(room.roomId, dir).ok).toBe(true);
    expect(rooms.setKernelAutonomy(room.roomId, 0).ok).toBe(true);
    const parked = rooms.proposeKernelImprove(room.roomId, "rewriter", HOOK_V2, "try v2");
    expect(parked.ok).toBe(true);
    expect(parked.decision).toBe("pending");
    const seatId = room.seats[0]!.id;
    await rooms.send(room.roomId, seatId, "hello");
    await vi.waitFor(() => {
      expect(rooms.get(room.roomId)!.items.some((i) => i.text === "v1")).toBe(true);
    });
    const pending = rooms.getKernelImprove(room.roomId).proposals?.find((p) => p.status === "pending");
    expect(pending).toBeTruthy();
    expect(rooms.applyKernelProposal(room.roomId, pending!.id).ok).toBe(true);
    await rooms.send(room.roomId, seatId, "hello2");
    await vi.waitFor(() => {
      expect(rooms.get(room.roomId)!.items.some((i) => i.text === "v2")).toBe(true);
    });
  });

  it("auto-applies L1 same-boundary source and rolls back", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "improve-l1");
    const dir = writeKernelHook(path.join(tmp(), "hook"), "rewriter", HOOK_V1);
    expect(rooms.enableKernelMod(room.roomId, dir).ok).toBe(true);
    expect(rooms.setKernelAutonomy(room.roomId, 1).ok).toBe(true);
    const applied = rooms.proposeKernelImprove(room.roomId, "rewriter", HOOK_V2);
    expect(applied.ok).toBe(true);
    expect(applied.status).toBe("applied");
    const seatId = room.seats[0]!.id;
    await rooms.send(room.roomId, seatId, "hello");
    await vi.waitFor(() => {
      expect(rooms.get(room.roomId)!.items.some((i) => i.text === "v2")).toBe(true);
    });
    expect(rooms.getKernelImprove(room.roomId).canRollback).toContain("rewriter");
    expect(rooms.rollbackKernelImprove(room.roomId, "rewriter").ok).toBe(true);
    await rooms.send(room.roomId, seatId, "again");
    await vi.waitFor(() => {
      expect(rooms.get(room.roomId)!.items.some((i) => i.text === "v1")).toBe(true);
    });
  });

  it("rejects forbidden source and missing provide, and keeps memory working", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "improve-bound");
    const mem = rooms.listMods().mods.find((p) => p.id === "shared-memory")!;
    expect(rooms.enableKernelMod(room.roomId, mem.packDir).ok).toBe(true);
    expect(rooms.setKernelAutonomy(room.roomId, 1).ok).toBe(true);
    const bad = rooms.proposeKernelImprove(
      room.roomId,
      "shared-memory",
      "import fs from 'node:fs'; export function activate() {}",
    );
    expect(bad.ok).toBe(false);
    const missing = rooms.proposeKernelImprove(
      room.roomId,
      "shared-memory",
      "export function activate(ctx) {}",
    );
    expect(missing.ok).toBe(false);
    expect(missing.decision).toBe("reject");
    expect(rooms.setKernelMemory(room.roomId, "k", "v").ok).toBe(true);
  });

  it("reloads the applied improve source after disable and re-enable", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "improve-persist");
    const dir = writeKernelHook(path.join(tmp(), "hook"), "rewriter", HOOK_V1);
    expect(rooms.enableKernelMod(room.roomId, dir).ok).toBe(true);
    expect(rooms.setKernelAutonomy(room.roomId, 1).ok).toBe(true);
    expect(rooms.proposeKernelImprove(room.roomId, "rewriter", HOOK_V2).status).toBe("applied");
    expect(rooms.disableKernelMod(room.roomId, "rewriter").ok).toBe(true);
    expect(rooms.enableKernelMod(room.roomId, dir).ok).toBe(true);
    const seatId = room.seats[0]!.id;
    await rooms.send(room.roomId, seatId, "hello");
    await vi.waitFor(() => {
      expect(rooms.get(room.roomId)!.items.some((i) => i.text === "v2")).toBe(true);
    });
  });

  it("re-enables the rolled-back source after disable", async () => {
    const { rooms } = makeRooms();
    const { room } = await createHost(rooms, "improve-persist-rb");
    const dir = writeKernelHook(path.join(tmp(), "hook"), "rewriter", HOOK_V1);
    expect(rooms.enableKernelMod(room.roomId, dir).ok).toBe(true);
    expect(rooms.setKernelAutonomy(room.roomId, 1).ok).toBe(true);
    expect(rooms.proposeKernelImprove(room.roomId, "rewriter", HOOK_V2).status).toBe("applied");
    expect(rooms.rollbackKernelImprove(room.roomId, "rewriter").ok).toBe(true);
    expect(rooms.disableKernelMod(room.roomId, "rewriter").ok).toBe(true);
    expect(rooms.enableKernelMod(room.roomId, dir).ok).toBe(true);
    const seatId = room.seats[0]!.id;
    await rooms.send(room.roomId, seatId, "hello");
    await vi.waitFor(() => {
      expect(rooms.get(room.roomId)!.items.some((i) => i.text === "v1")).toBe(true);
    });
    expect(rooms.get(room.roomId)!.items.some((i) => i.text === "v2")).toBe(false);
  });
});
