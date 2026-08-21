import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeRoomInvite, type RoomSnapshot } from "@claude-desktop/shared";
import { RoomService } from "./room-service";
import { RoomMetrics } from "./room-metrics";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

// Test-only self-signed pair for 127.0.0.1 (generated with openssl, never
// shipped; the guest side accepts it via the wssRejectUnauthorized test hook).
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC1748+WXaoUEr1
LbypXekavZiSQOFxNrcd/je/tDARw/SjzC/02/VImvxUIa52sUNUv/55tuMZzIii
fO/g/QSs/ZK6/VRuE1C5uYxbCloJD7XZtRg5qC6xxWtixw/TE6s2RaohCEUcj53F
ZRJTaJVRPViBUTWqR5MY9ktdo9Nubpfi4moXSCxVwc3l51mDJ4f6J7aSWbo/4jgz
AkDpQb76XsGUrLU8UqrVgU7IFVgr0fJK6o5gqChTr0S7oJOFQYLdRjWhowVhjmru
0HVu9yiugm7DJ1vQSR924XDxoZGroIWvSFMdWLYY0OCdScgGLNhCRWYxyjacP5DP
uLLOCbfJAgMBAAECggEAAXvw2Vh0P3zeqxjgLgWEt1WOa04OwqaTL42X3inb5QDT
OMjAJ8fRGBbdewoGibKSfZxCY5q/Cwt0C/vbgCR/fNaKPJmAidFWnWNXAepa/QD7
kR527Zo99JsafFjMCBt8cbtrRq4u7G6UQHl0dMSu1EmjNHp5cxLefqf34nhJtFnn
LkHAmR9yL9u5QuKwERDr38cnTEmO2KniG2+xwUfgEKgBZPBU/W9Dl2zWTIOgjtVF
ipceS2ok1i+WXjnemKv9NxlDfTOaZsA+R5kwdMXGhNjKiI7KHh/vmGPcSVFLwZmW
jJxQZ8EFyAr0aGh0ZobT/ggtmQUElCeiRIzTXIyFMQKBgQDbUqtT+h2Czu6jO49t
Jt6eAcndJbWc6OQmo57ySTeXwz732XnyTF04ofVj4gV828RyBnwQvtIxnTmRo0wv
vUjlwqJNc2H89qbeOHEEf0iT/JWcmL9WxPOvmDY8KblUdcqMIGzu93ICKzRVl75f
Bi+sJonk1XTBE3+KitG0mtxF1QKBgQDUXFOiv8VFsJh8KkPnMDDuj4JL4qppk0wA
jmlH6RHU33wFehHNA34cHMRk1gtr3QGUIC3ygwCkoGmIFpjQGxnj+g3/ZgeUQN4p
zdEhJZy5VihP6YQtGmcyd5EvJ5pJ6lUjtx9nCLzPSEMxjf19arUqVBA7rHwv56Rk
IEKWBRUgJQKBgB8cCtFOmQEE+TSOLjn9WXZwKoID507qefJBIzqayBfuye++GV4V
FuQBlR0l4kFjqunBobd+WbJP6uqNjzD2WHC+uubhhvSqx+CdgOpyY4kaOt6LjBhy
t14g6RB/mpowWxqlPs5mqvVDy5iYfZhc+EYi8UxUOstoSJ8OMdC8ZqJBAoGBAJB+
AapLMb8pWZeianFzqNepbc6Ue786Kgx22cvEGg3twkU3ucT1C2m1aSvzN/I8fkZ7
XsgTuuxI+YVPWsq+pe8oxT1x/tYxDPkEwbb8EJdKuEMncHf/7xe3o2GiYKjKeQPE
JenFWDLxyEZ/hms/n+UdLa5svlMaGhDGoofRDX7BAoGAF9FsTfFe3qQycIOq1Zh1
tYhtb+b4SAzCsXXApm+hjneM7l4WuCjvow2uTW1f9F4YcCS71W7szt2HmxoIFPqE
7zeKTQoTuqbpHCj82Mbc1dJcNNqDBGq8EyTPJ3WosfvkLwWHPAxmzz5tXS4TXK7l
zXBQeK69NnCW3JRgHvVGG/4=
-----END PRIVATE KEY-----`;
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUP+6rOg5zTUfeymqnBezY+VAkDs0wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDgyMTE0MDU1MFoXDTM2MDgx
ODE0MDU1MFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAte+PPll2qFBK9S28qV3pGr2YkkDhcTa3Hf43v7QwEcP0
o8wv9Nv1SJr8VCGudrFDVL/+ebbjGcyIonzv4P0ErP2Suv1UbhNQubmMWwpaCQ+1
2bUYOaguscVrYscP0xOrNkWqIQhFHI+dxWUSU2iVUT1YgVE1qkeTGPZLXaPTbm6X
4uJqF0gsVcHN5edZgyeH+ie2klm6P+I4MwJA6UG++l7BlKy1PFKq1YFOyBVYK9Hy
SuqOYKgoU69Eu6CThUGC3UY1oaMFYY5q7tB1bvcoroJuwydb0EkfduFw8aGRq6CF
r0hTHVi2GNDgnUnIBizYQkVmMco2nD+Qz7iyzgm3yQIDAQABo28wbTAdBgNVHQ4E
FgQUpcwnASOIxHVcrOtInNlcuVYqUr8wHwYDVR0jBBgwFoAUpcwnASOIxHVcrOtI
nNlcuVYqUr8wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAD55LkYEoY52MgE1rvqjWyWNjKH/5oN/
3HVb5BoAEm6hl4FyoAFyMzlAcr72iWS47dwMjO6uT2E0xt5W4L7Bo9Bo6D7tORXC
jvXR4DbaIsPM9xXrtKO6LODS5n6QvUUalxwhxyqIWKLSXF+uuzJ7rrQDMAKF9Bln
pe7sCC13veliw8pZSYj5VdWmCchTCAxyheXk5LNzcuQ2b7tHi37uT+ujpUBGs5GU
bMJgbwCx/wen2orwP+ahnDFxsaRaaTRSyuTLzFvq/ZCxLBvieH35vU2zF4v3lXWO
P8OqDFIEebOEMd3exL4AZMyuKQCS1eBRJnB/fQOvlfJOvu/ilTWTkRM=
-----END CERTIFICATE-----`;

const dirs: string[] = [];
const services: RoomService[] = [];
const tlsServers: tls.Server[] = [];

afterEach(() => {
  for (const s of [...services].reverse()) {
    try {
      s.disposeAll();
    } catch {
      // ignore
    }
  }
  services.length = 0;
  for (const s of tlsServers) {
    try {
      s.close();
    } catch {
      // ignore
    }
  }
  tlsServers.length = 0;
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-path-"));
  dirs.push(d);
  return d;
}

function mockWindow(onSend?: (channel: string, payload: unknown) => void) {
  return () =>
    ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => onSend?.(channel, payload),
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
  } as unknown as SessionManager;
}

function mockSettings(project: string) {
  return {
    get: vi.fn().mockReturnValue({ lastProjectPath: project }),
  } as unknown as SettingsStore;
}

function makeRooms(
  onSend?: (channel: string, payload: unknown) => void,
): RoomService {
  const userDataDir = tmp();
  const rooms = new RoomService({
    getWindow: mockWindow(onSend),
    sessions: mockSessions(),
    settings: mockSettings(userDataDir),
    userDataDir,
    archive: null,
    // Keep the [room-metrics] console.info lines out of the test output.
    metrics: new RoomMetrics(() => {}),
  });
  services.push(rooms);
  return rooms;
}

async function createHost(
  rooms: RoomService,
  opts?: {
    name?: string;
    password?: string;
    encrypt?: boolean;
    autoApprove?: boolean;
  },
): Promise<{ room: RoomSnapshot; port: number }> {
  let last = "";
  for (let i = 0; i < 10; i++) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const res = await rooms.create({
      name: opts?.name ?? "t",
      port,
      password: opts?.password,
      encrypt: opts?.encrypt,
      autoApprove: opts?.autoApprove ?? true,
    });
    if (res.ok && res.room) return { room: res.room, port };
    last = res.error ?? "create failed";
  }
  throw new Error(last);
}

/** Test view over private RoomService internals. */
type PathProbe = {
  rooms: Map<string, { joinInfo?: { path?: string } }>;
  /** Test hook: false accepts self-signed wss certs (production never sets). */
  wssRejectUnauthorized?: boolean;
};

function joinedPath(rooms: RoomService, roomId: string): string | undefined {
  return (rooms as unknown as PathProbe).rooms.get(roomId)?.joinInfo?.path;
}

describe("room path racing (T0 LAN / T1 wss)", () => {
  it("tries second LAN host if the first refuses", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });
    const guest = makeRooms();
    const res = await guest.join({
      // TEST-NET-1: guaranteed unroutable, so the first candidate never opens.
      host: "192.0.2.1",
      hosts: ["127.0.0.1"],
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(res.ok).toBe(true);
    expect(joinedPath(guest, room.roomId)).toBe("T0");
  });

  it("prefers a live wss candidate when LAN is dead", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });

    // Test-only TLS terminator piping into the host's plaintext ws port
    // (S1 never terminates TLS inside RoomService itself).
    const tlsServer = tls.createServer(
      { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
      (sock) => {
        const up = net.connect(port, "127.0.0.1");
        sock.on("error", () => up.destroy());
        up.on("error", () => sock.destroy());
        sock.pipe(up);
        up.pipe(sock);
      },
    );
    tlsServers.push(tlsServer);
    await new Promise<void>((resolve) =>
      tlsServer.listen(0, "127.0.0.1", resolve),
    );
    const tlsPort = (tlsServer.address() as net.AddressInfo).port;

    // A port that was listening moments ago and is now closed.
    const deadPort = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });

    const guest = makeRooms();
    // Test hook: accept the self-signed cert. Production keeps CA checks on.
    (guest as unknown as PathProbe).wssRejectUnauthorized = false;
    const res = await guest.join({
      host: "127.0.0.1",
      port: deadPort,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
      wss: [`wss://127.0.0.1:${tlsPort}`],
    });
    expect(res.ok).toBe(true);
    expect(joinedPath(guest, room.roomId)).toBe("T1");
  });

  it("refuses encrypt:false when publicWss is set", async () => {
    const rooms = makeRooms();
    let created: { ok: boolean; room?: RoomSnapshot; error?: string } | null =
      null;
    for (let i = 0; i < 10 && !created?.ok; i++) {
      created = await rooms.create({
        name: "t",
        port: 21000 + Math.floor(Math.random() * 20000),
        encrypt: false,
        publicWss: "wss://room.example.com",
        autoApprove: true,
      });
    }
    expect(created?.ok).toBe(true);
    expect(created?.room?.encrypt).toBe(true);

    // The public wss endpoint lands in the CDR2 invite's u array.
    const inv = rooms.invite(created!.room!.roomId);
    expect(inv.ok).toBe(true);
    const payload = decodeRoomInvite(inv.secret ?? "");
    expect(payload.wss).toEqual(["wss://room.example.com"]);
  });
});
