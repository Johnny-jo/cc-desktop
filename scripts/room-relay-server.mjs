#!/usr/bin/env node
/**
 * room-relay-server.mjs — dumb WebSocket relay for ccDesktop room hosting.
 *
 * Deploy on a public VPS:
 *   npm i ws
 *   node room-relay-server.mjs --port 7600 [--token xxx]
 *
 * One port, three ws endpoints split by URL path:
 *   /ctl?id=<12hex>&token=<t>  host control channel — registers the room id,
 *                              receives {"t":"work","seq"} pairing requests.
 *   /work?id&seq&token=<t>    host work channel — one per guest; paired with
 *                              the pending guest holding the same seq.
 *   /r/<id>                   guest endpoint — room guests connect here.
 *
 * The relay forwards ws message payloads verbatim and never parses them:
 * room traffic is AEAD-encrypted end to end, so the relay sees ciphertext only.
 */
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Resolve `ws` next to this script first (VPS: `npm i ws` alongside the file),
// then fall back to the repo's apps/desktop install (in-repo tests).
function loadWs() {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    here,
    path.resolve(path.dirname(here), "..", "apps", "desktop", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)("ws");
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "room-relay: cannot resolve `ws` — run `npm i ws` next to this script",
  );
}

const { WebSocketServer } = loadWs();

function parseArgs(argv) {
  let port = 7600;
  let token = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1] !== undefined) {
      port = Number(argv[++i]);
    } else if (argv[i] === "--token" && argv[i + 1] !== undefined) {
      token = argv[++i];
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("room-relay: --port must be an integer in 1..65535");
    process.exit(1);
  }
  return { port, token };
}

const { port, token } = parseArgs(process.argv.slice(2));

const OPEN = 1;
/** Ping idle hops so a proxy / NAT does not drop a guest waiting for approval. */
const HEARTBEAT_MS = 15_000;
/** Guests waiting for their work channel, per room. */
const MAX_PENDING_PER_ROOM = 32;
/** A pending guest is dropped when no work channel shows up in time. */
const PAIR_TIMEOUT_MS = 10_000;
/** Payloads buffered per pending guest (the handshake arrives pre-pairing). */
const MAX_BUFFERED_PER_GUEST = 256;

/** rooms: Map<id, { ctl, seq, pending: Map<seq, entry>, sockets: Set<ws> }> */
const rooms = new Map();
let pairedTotal = 0;

function log(line) {
  // Single-line stdout logs only; never log tokens.
  console.log(`room-relay ${line}`);
}

function tokenOk(given) {
  if (!token) return true; // no --token configured → no auth
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function closeQuiet(ws, code) {
  try {
    ws.close(code);
  } catch {
    // ignore
  }
}

function attachHeartbeat(ws) {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", () => {
    ws.isAlive = true;
  });
}

/** ctl dropped → the whole room (guests + work channels) goes away. */
function teardownRoom(id, room) {
  if (rooms.get(id) !== room) return;
  rooms.delete(id);
  for (const entry of room.pending.values()) clearTimeout(entry.timer);
  room.pending.clear();
  for (const ws of room.sockets) closeQuiet(ws);
  room.sockets.clear();
  log(`ctl closed id=${id} rooms=${rooms.size}`);
}

/** Bidirectional verbatim forwarding between a guest and its work channel. */
function pipe(room, guest, work, label) {
  room.sockets.add(work);
  pairedTotal += 1;
  log(`paired ${label} total=${pairedTotal}`);
  guest.on("message", (data, isBinary) => {
    if (work.readyState === OPEN) {
      try {
        work.send(data, { binary: isBinary });
      } catch {
        // ignore
      }
    }
  });
  work.on("message", (data, isBinary) => {
    if (guest.readyState === OPEN) {
      try {
        guest.send(data, { binary: isBinary });
      } catch {
        // ignore
      }
    }
  });
  const drop = () => {
    closeQuiet(guest);
    closeQuiet(work);
  };
  guest.on("close", drop);
  guest.on("error", drop);
  work.on("close", drop);
  work.on("error", drop);
}

function onCtl(url, ws) {
  if (!tokenOk(url.searchParams.get("token"))) {
    closeQuiet(ws, 4403);
    return;
  }
  const id = (url.searchParams.get("id") ?? "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(id)) {
    closeQuiet(ws, 4400);
    return;
  }
  const existing = rooms.get(id);
  if (existing && existing.ctl.readyState === OPEN) {
    closeQuiet(ws, 4409); // room id already registered
    return;
  }
  if (existing) teardownRoom(id, existing); // stale ctl — clean leftovers
  const room = { ctl: ws, seq: 0, pending: new Map(), sockets: new Set([ws]) };
  rooms.set(id, room);
  attachHeartbeat(ws);
  try {
    ws.send(JSON.stringify({ t: "ready", id }));
  } catch {
    // ignore
  }
  log(`ctl registered id=${id} rooms=${rooms.size}`);
  ws.on("close", () => teardownRoom(id, room));
  ws.on("error", () => {});
}

function onWork(url, ws) {
  if (!tokenOk(url.searchParams.get("token"))) {
    closeQuiet(ws, 4403);
    return;
  }
  const id = (url.searchParams.get("id") ?? "").toLowerCase();
  const seq = Number(url.searchParams.get("seq"));
  const room = rooms.get(id);
  const entry =
    room && Number.isInteger(seq) ? room.pending.get(seq) : undefined;
  if (!room || room.ctl.readyState !== OPEN || !entry) {
    closeQuiet(ws, 4404);
    return;
  }
  // Stop buffering before pipe() attaches its own guest message handler.
  room.pending.delete(seq);
  clearTimeout(entry.timer);
  attachHeartbeat(ws);
  pipe(room, entry.ws, ws, `${id}#${seq}`);
  for (const [data, isBinary] of entry.buf.splice(0)) {
    try {
      ws.send(data, { binary: isBinary });
    } catch {
      break;
    }
  }
}

function onGuest(url, ws) {
  const m = /^\/r\/([0-9a-f]{12})$/i.exec(url.pathname);
  const id = m ? m[1].toLowerCase() : "";
  const room = id ? rooms.get(id) : undefined;
  if (!room || room.ctl.readyState !== OPEN) {
    closeQuiet(ws, 4404);
    return;
  }
  if (room.pending.size >= MAX_PENDING_PER_ROOM) {
    closeQuiet(ws, 4429);
    return;
  }
  const seq = ++room.seq;
  const entry = { ws, buf: [], timer: null };
  entry.timer = setTimeout(() => {
    if (room.pending.delete(seq)) closeQuiet(ws, 4408);
  }, PAIR_TIMEOUT_MS);
  room.pending.set(seq, entry);
  room.sockets.add(ws);
  attachHeartbeat(ws);
  // Buffer while pending: the guest sends its handshake immediately after
  // connect, before the host's work channel has arrived.
  ws.on("message", (data, isBinary) => {
    if (room.pending.has(seq) && entry.buf.length < MAX_BUFFERED_PER_GUEST) {
      entry.buf.push([data, isBinary]);
    }
  });
  ws.on("close", () => {
    const cur = room.pending.get(seq);
    if (cur) {
      room.pending.delete(seq);
      clearTimeout(cur.timer);
    }
  });
  ws.on("error", () => {});
  try {
    room.ctl.send(JSON.stringify({ t: "work", seq }));
  } catch {
    // ctl died between the checks — teardown cleans the pending entry up.
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("room-relay\n");
});
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  let url;
  try {
    url = new URL(req.url ?? "", "http://relay.local");
  } catch {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      if (url.pathname === "/ctl") onCtl(url, ws);
      else if (url.pathname === "/work") onWork(url, ws);
      else onGuest(url, ws);
    } catch {
      closeQuiet(ws);
    }
  });
});

server.on("error", (err) => {
  console.error(`room-relay: ${err.message}`);
  process.exit(1);
});

setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of [...room.sockets]) {
      if (ws.readyState !== OPEN) continue;
      if (ws.isAlive === false) {
        closeQuiet(ws);
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }
}, HEARTBEAT_MS).unref?.();

server.listen(port, () => {
  const addr = server.address();
  const at = addr && typeof addr === "object" ? `0.0.0.0:${addr.port}` : "?";
  console.log(`room-relay listening on ${at}`);
});
