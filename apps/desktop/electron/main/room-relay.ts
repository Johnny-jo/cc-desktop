import { WebSocket, type RawData } from "ws";

/**
 * Self-hosted room relay client (host side).
 *
 * The host dials OUT to a dumb relay (scripts/room-relay-server.mjs) running
 * on the user's own VPS: one control channel registers a 12-hex room id, then
 * each incoming guest gets a dedicated work channel that bridges ws payloads
 * to the local room server. Same trust model as the Cloudflare tunnel — room
 * frames are AEAD-encrypted end to end, the relay only forwards ciphertext.
 *
 * Every failure resolves to `{ ok: false }`; callers keep the room LAN-only.
 */

/** Default wait for the relay's first {"t":"ready"} handshake. */
export const ROOM_RELAY_READY_TIMEOUT_MS = 15_000;
/** ctl reconnect cadence after an established channel drops. */
const ROOM_RELAY_RECONNECT_MS = 3_000;
/** Cap on payloads buffered while the local ws hop is still opening. */
const RELAY_BRIDGE_BUFFER_MAX = 256;

export type RoomRelayResult =
  | { ok: true; url: string; kill: () => void }
  | { ok: false; error: string };

type Bridge = { work: WebSocket; local: WebSocket | null };

/**
 * Register opts.roomId on the relay and resolve with the public join URL
 * (`<relay>/r/<id>`). The ctl channel reconnects every 3s after a drop and
 * re-registers the same room id, so the URL stays valid; kill() stops
 * everything and is idempotent.
 */
export function startRoomRelay(opts: {
  relay: string;
  token?: string;
  roomId: string;
  localPort: number;
  timeoutMs?: number;
}): Promise<RoomRelayResult> {
  const base = opts.relay.trim().replace(/\/+$/, "");
  if (!/^wss?:\/\//i.test(base)) {
    return Promise.resolve({
      ok: false,
      error: "中继地址须以 ws:// 或 wss:// 开头",
    });
  }
  const roomId = opts.roomId.trim().toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(roomId)) {
    return Promise.resolve({ ok: false, error: "中继 roomId 须为 12 位 hex" });
  }
  const timeoutMs = opts.timeoutMs ?? ROOM_RELAY_READY_TIMEOUT_MS;
  const token = opts.token ?? "";
  const auth = `token=${encodeURIComponent(token)}`;

  return new Promise((resolve) => {
    let settled = false;
    let killed = false;
    let ctl: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    const bridges = new Set<Bridge>();

    const kill = () => {
      if (killed) return;
      killed = true;
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
      try {
        ctl?.close();
      } catch {
        // ignore
      }
      ctl = null;
      for (const b of [...bridges]) dropBridge(b);
      bridges.clear();
    };

    const settle = (res: RoomRelayResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      if (!res.ok) kill();
      resolve(res);
    };

    const readyTimer = setTimeout(() => {
      settle({ ok: false, error: "中继握手超时" });
    }, timeoutMs);

    const scheduleReconnect = () => {
      if (killed || reconnect) return;
      reconnect = setTimeout(() => {
        reconnect = null;
        connect();
      }, ROOM_RELAY_RECONNECT_MS);
    };

    function dropBridge(b: Bridge): void {
      if (!bridges.has(b)) return;
      bridges.delete(b);
      try {
        b.work.close();
      } catch {
        // ignore
      }
      try {
        b.local?.close();
      } catch {
        // ignore
      }
    }

    /**
     * Per-guest bridge: relay work channel ↔ local room server. The local
     * hop is a ws client (the room server speaks the ws protocol — a raw
     * TCP socket would never complete its HTTP upgrade). Payloads that
     * arrive before the local hop opens are buffered, then flushed.
     */
    const openWork = (seq: number) => {
      if (killed) return;
      let work: WebSocket;
      try {
        work = new WebSocket(`${base}/work?id=${roomId}&seq=${seq}&${auth}`);
      } catch {
        return;
      }
      const bridge: Bridge = { work, local: null };
      bridges.add(bridge);
      const buffered: Array<[RawData, boolean]> = [];
      work.on("open", () => {
        if (killed) {
          dropBridge(bridge);
          return;
        }
        let local: WebSocket;
        try {
          local = new WebSocket(`ws://127.0.0.1:${opts.localPort}`);
        } catch {
          dropBridge(bridge);
          return;
        }
        bridge.local = local;
        local.on("open", () => {
          for (const [d, bin] of buffered.splice(0)) {
            try {
              local.send(d, { binary: bin });
            } catch {
              break;
            }
          }
        });
        local.on("message", (d, bin) => {
          if (work.readyState === WebSocket.OPEN) {
            try {
              work.send(d, { binary: bin });
            } catch {
              // ignore
            }
          }
        });
        local.on("close", () => dropBridge(bridge));
        local.on("error", () => dropBridge(bridge));
      });
      work.on("message", (d, bin) => {
        const local = bridge.local;
        if (local && local.readyState === WebSocket.OPEN) {
          try {
            local.send(d, { binary: bin });
          } catch {
            // ignore
          }
        } else if (buffered.length < RELAY_BRIDGE_BUFFER_MAX) {
          buffered.push([d, bin]);
        }
      });
      work.on("close", () => dropBridge(bridge));
      work.on("error", () => dropBridge(bridge));
    };

    const connect = () => {
      if (killed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${base}/ctl?id=${roomId}&${auth}`);
      } catch {
        scheduleReconnect();
        return;
      }
      ctl = ws;
      ws.on("message", (data) => {
        let msg: { t?: unknown; seq?: unknown } | null = null;
        try {
          msg = JSON.parse(String(data)) as { t?: unknown; seq?: unknown };
        } catch {
          msg = null;
        }
        if (!msg) return;
        if (msg.t === "ready") {
          settle({ ok: true, url: `${base}/r/${roomId}`, kill });
          return;
        }
        if (msg.t === "work" && Number.isInteger(msg.seq)) {
          openWork(msg.seq as number);
        }
      });
      ws.on("close", (code) => {
        if (ctl === ws) ctl = null;
        if (killed) return;
        if (!settled) {
          if (code === 4409) settle({ ok: false, error: "中继 id 被占用" });
          else if (code === 4403) settle({ ok: false, error: "中继 token 错误" });
          else settle({ ok: false, error: "中继服务器不可达" });
          return;
        }
        // Established channel dropped — re-register the same room id.
        scheduleReconnect();
      });
      ws.on("error", () => {
        // A close event follows; settle early only for the first handshake.
        if (!settled) settle({ ok: false, error: "中继服务器不可达" });
      });
    };

    connect();
  });
}
