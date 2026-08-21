import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeRoomInvite, type RoomSnapshot } from "@claude-desktop/shared";
import {
  parseQuickTunnelUrl,
  readNamedTunnelConfig,
  startQuickTunnel,
  startRoomTunnel,
  tunnelArgs,
  type RoomTunnelResult,
} from "./room-tunnel";
import { resolveCloudflared } from "./runtime-paths";
import { RoomService } from "./room-service";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

// Fake cloudflared binaries are plain node scripts run via process.execPath —
// real binaries are never committed to the repo (no real CF tokens either).
const QUICK_FAKE = `// fake cloudflared quick tunnel: print the URL, then stay alive
console.log("INF +--------------------------------------------------------------------------------------------+");
console.log("INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");
console.log("INF |  https://abc-def-123.trycloudflare.com                                                       |");
setInterval(() => {}, 1000);
`;
const SILENT_FAKE = `// fake cloudflared that never prints a URL (timeout path)
setInterval(() => {}, 1000);
`;

const dirs: string[] = [];
const kills: Array<() => void> = [];
const services: RoomService[] = [];

afterEach(() => {
  for (const kill of kills.splice(0)) {
    try {
      kill();
    } catch {
      // ignore
    }
  }
  for (const s of services.splice(0)) {
    try {
      s.disposeAll();
    } catch {
      // ignore
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  vi.unstubAllEnvs();
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-tunnel-"));
  dirs.push(d);
  return d;
}

function writeFake(name: string, body: string): string {
  const p = path.join(tmp(), name);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

function keep(res: RoomTunnelResult): RoomTunnelResult {
  if (res.ok) kills.push(res.kill);
  return res;
}

describe("parseQuickTunnelUrl", () => {
  it("extracts the first trycloudflare URL and rewrites it to wss", () => {
    const line =
      "2026-08-21T12:00:00Z INF |  https://abc-def-123.trycloudflare.com  |";
    expect(parseQuickTunnelUrl(line)).toBe(
      "wss://abc-def-123.trycloudflare.com",
    );
  });

  it("returns null when no quick-tunnel URL is present", () => {
    expect(parseQuickTunnelUrl("INF Waiting for login...")).toBeNull();
    expect(parseQuickTunnelUrl("https://example.com")).toBeNull();
  });
});

describe("tunnelArgs", () => {
  it("builds quick-tunnel args", () => {
    expect(tunnelArgs(18765, null)).toEqual([
      "tunnel",
      "--url",
      "http://127.0.0.1:18765",
      "--no-autoupdate",
    ]);
  });

  it("builds named-tunnel args with the token", () => {
    expect(tunnelArgs(18765, { token: "fake-token", wss: "wss://x" })).toEqual([
      "tunnel",
      "run",
      "--token",
      "fake-token",
      "--no-autoupdate",
    ]);
  });
});

describe("readNamedTunnelConfig", () => {
  it("returns null when the file is missing or has no token", () => {
    const d = tmp();
    expect(readNamedTunnelConfig(d)).toBeNull();
    fs.writeFileSync(
      path.join(d, "cloudflare-tunnel.json"),
      JSON.stringify({ wss: "wss://x" }),
      "utf8",
    );
    expect(readNamedTunnelConfig(d)).toBeNull();
  });

  it("reads token + wss from userData/cloudflare-tunnel.json", () => {
    const d = tmp();
    fs.writeFileSync(
      path.join(d, "cloudflare-tunnel.json"),
      JSON.stringify({ token: "fake-token", wss: "wss://room.example.com" }),
      "utf8",
    );
    expect(readNamedTunnelConfig(d)).toEqual({
      token: "fake-token",
      wss: "wss://room.example.com",
    });
  });
});

describe("resolveCloudflared", () => {
  it("prefers env.cloudflaredPath when it exists", () => {
    const fake = writeFake("cloudflared.exe", QUICK_FAKE);
    expect(
      resolveCloudflared({
        isPackaged: false,
        userDataDir: tmp(),
        cloudflaredPath: fake,
      }),
    ).toBe(fake);
  });

  it("finds the bundled extraResources binary", () => {
    const resources = path.join(tmp(), "resources");
    const bin = path.join(
      resources,
      "bin",
      "cloudflared",
      process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
    );
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "", "utf8");
    expect(
      resolveCloudflared({ isPackaged: true, userDataDir: tmp(), resourcesPath: resources }),
    ).toBe(bin);
  });

  it("returns null when nothing resolves", () => {
    vi.stubEnv("PATH", "");
    expect(
      resolveCloudflared({ isPackaged: false, userDataDir: tmp() }),
    ).toBeNull();
  });
});

describe("startQuickTunnel", () => {
  it("spawns cloudflared and parses the quick-tunnel URL", async () => {
    const fake = writeFake("fake-cloudflared.js", QUICK_FAKE);
    const res = keep(
      await startQuickTunnel({ port: 18765, cloudflaredPath: fake }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.wss).toBe("wss://abc-def-123.trycloudflare.com");
  });

  it("times out when no URL appears and kills the child", async () => {
    const fake = writeFake("fake-silent.js", SILENT_FAKE);
    const res = await startQuickTunnel({
      port: 18765,
      cloudflaredPath: fake,
      timeoutMs: 300,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("隧道启动超时");
  });

  it("reports a missing binary without throwing", async () => {
    const res = await startQuickTunnel({
      port: 18765,
      cloudflaredPath: path.join(tmp(), "no-such-cloudflared.exe"),
      timeoutMs: 3000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("未找到 cloudflared");
  });
});

describe("startRoomTunnel", () => {
  it("fails cleanly when no cloudflared binary exists", async () => {
    vi.stubEnv("PATH", "");
    const res = await startRoomTunnel({
      port: 18765,
      env: { isPackaged: false, userDataDir: tmp() },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("未找到 cloudflared");
  });

  it("uses the named tunnel config wss without leaking the token", async () => {
    const userDataDir = tmp();
    fs.writeFileSync(
      path.join(userDataDir, "cloudflare-tunnel.json"),
      JSON.stringify({
        token: "fake-named-token",
        wss: "wss://room.example.com",
      }),
      "utf8",
    );
    const fake = writeFake("fake-named.js", SILENT_FAKE);
    const res = keep(
      await startRoomTunnel({
        port: 18765,
        env: { isPackaged: false, userDataDir, cloudflaredPath: fake },
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.wss).toBe("wss://room.example.com");
    // The token must never appear in the result (nor in invites / IPC).
    expect(JSON.stringify(res)).not.toContain("fake-named-token");
  });
});

// --- RoomService integration -------------------------------------------------

function mockWindow() {
  return () =>
    ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: () => {} },
    }) as never;
}

function mockSessions() {
  return {
    start: vi.fn().mockResolvedValue("sess-agent"),
    continue: vi.fn().mockResolvedValue(undefined),
    getTranscript: vi.fn().mockReturnValue([]),
    abort: vi.fn(),
    syncExtras: vi.fn(),
  } as unknown as SessionManager;
}

function mockSettings(project: string) {
  return {
    get: vi.fn().mockReturnValue({ lastProjectPath: project }),
  } as unknown as SettingsStore;
}

function makeRooms(cloudflaredPath?: string): RoomService {
  const userDataDir = tmp();
  const rooms = new RoomService({
    getWindow: mockWindow(),
    sessions: mockSessions(),
    settings: mockSettings(userDataDir),
    userDataDir,
    archive: null,
    ...(cloudflaredPath ? { cloudflaredPath } : {}),
  });
  services.push(rooms);
  return rooms;
}

async function createTunnelHost(
  rooms: RoomService,
  opts?: { encrypt?: boolean },
): Promise<RoomSnapshot> {
  let last = "create failed";
  for (let i = 0; i < 10; i++) {
    const res = await rooms.create({
      name: "t",
      port: 21000 + Math.floor(Math.random() * 20000),
      autoApprove: true,
      tunnel: true,
      ...(opts?.encrypt !== undefined ? { encrypt: opts.encrypt } : {}),
    });
    if (res.ok && res.room) return res.room;
    last = res.error ?? last;
  }
  throw new Error(last);
}

describe("RoomService tunnel option", () => {
  it("create({ tunnel: true }) merges the trycloudflare wss into the invite and forces encrypt", async () => {
    const fake = writeFake("fake-cloudflared-quick.js", QUICK_FAKE);
    const rooms = makeRooms(fake);
    const room = await createTunnelHost(rooms, { encrypt: false });
    expect(room.encrypt).toBe(true);

    const inv = rooms.invite(room.roomId);
    expect(inv.ok).toBe(true);
    const decoded = decodeRoomInvite(inv.secret!);
    expect(decoded.wss).toContain("wss://abc-def-123.trycloudflare.com");
  });

  it("tunnel failure degrades to a LAN room without crashing create", async () => {
    vi.stubEnv("PATH", "");
    const rooms = makeRooms(path.join(tmp(), "no-such-cloudflared.exe"));
    const room = await createTunnelHost(rooms);
    expect(room.encrypt).toBe(true);
    const inv = rooms.invite(room.roomId);
    expect(inv.ok).toBe(true);
    const decoded = decodeRoomInvite(inv.secret!);
    expect(decoded.wss ?? []).toEqual([]);
  });
});
