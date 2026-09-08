/** Source for scripts/room-relay-server.mjs; build with scripts/build-room-server.mjs. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { RoomService } from "../main/room-service";
import { RoomArchive } from "../main/room-archive";
import { AppDatabase } from "../main/app-database";
import type { SessionManager } from "../main/session-manager";
import type { SettingsStore } from "../main/settings-store";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? "" : fallback;
}

async function main() {
  const port = Number(arg("port", "7600"));
  const token = arg("token", process.env.ROOM_SERVER_TOKEN ?? "");
  const dataDir = path.resolve(arg("data-dir", process.env.ROOM_SERVER_DATA_DIR ?? "./room-data"));
  const publicUrl = new URL(arg("public-url", process.env.ROOM_SERVER_PUBLIC_URL ?? `ws://127.0.0.1:${port}`));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  if (token.length < 24) throw new Error("ROOM_SERVER_TOKEN must contain at least 24 characters");
  if (!["ws:", "wss:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || !["", "/"].includes(publicUrl.pathname)) throw new Error("public-url must be a ws(s) origin without credentials/path/query");
  if (publicUrl.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname)) throw new Error("Public deployment requires wss:// behind a TLS reverse proxy");
  process.umask(0o077);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const database = AppDatabase.open(dataDir);
  if (!database) throw new Error("SQLite unavailable; use Node.js 22.13+ or 24, and a writable data directory");
  const routes = new Map<string, WebSocketServer>();
  const rooms = new RoomService({
    getWindow: () => null, userDataDir: dataDir,
    archive: new RoomArchive(dataDir, database),
    settings: { get: () => ({ lastProjectPath: null, agents: [] }) } as unknown as SettingsStore,
    sessions: new Proxy({}, { get: () => () => { throw new Error("Agent execution is disabled on chat server"); } }) as SessionManager,
    hostedTransport: (id, accept) => {
      const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
      routes.set(id, wss);
      wss.on("connection", accept);
      wss.on("close", () => { if (routes.get(id) === wss) routes.delete(id); });
      return wss;
    },
  });
  let creating = false;
  let closing = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/healthz" && req.method === "GET") return reply(200, { ok: !closing, service: "cc-room-server", version: 2 });
    if (req.url !== "/api/rooms" || req.method !== "POST") return reply(404, { ok: false, error: "Legacy relay protocol has been removed" });
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return reply(401, { ok: false, error: "建群令牌无效" });
    if (closing || creating) return reply(503, { ok: false, error: "服务器忙，请稍后重试" });
    if (rooms.list().length >= 40) return reply(409, { ok: false, error: "服务器已达到 40 个房间上限" });
    creating = true;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) { reply(413, { ok: false, error: "请求过大" }); req.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80 ||
        typeof input.password !== "string" || input.password.length > 256 ||
        typeof input.autoApprove !== "boolean" || typeof input.ownerFp !== "string" || !/^[a-f0-9]{64}$/.test(input.ownerFp)) {
        return reply(400, { ok: false, error: "建群参数无效" });
      }
      if (input.autoApprove && input.password.trim().length < 8) return reply(400, { ok: false, error: "自动放行的托管群必须设置至少 8 位密码" });
      const result = await rooms.create({ name: input.name, password: input.password,
        autoApprove: input.autoApprove, encrypt: true, hostedOwnerFp: input.ownerFp });
      if (!result.ok || !result.room) return reply(500, { ok: false, error: "房间创建失败" });
      reply(201, { ok: true, roomId: result.room.roomId,
        url: `${publicUrl.origin}/r/${result.room.roomId}`, fingerprint: result.room.hostFingerprint });
    } catch {
      reply(400, { ok: false, error: "请求或存储失败" });
    } finally { creating = false; }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("upgrade", (req, socket, head) => {
    const match = /^\/r\/([a-f0-9-]{36})$/.exec(req.url ?? "");
    const wss = match ? routes.get(match[1]) : undefined;
    if (closing || !wss || wss.clients.size >= 128) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  const stop = () => {
    if (closing) return;
    closing = true;
    rooms.disposeAll();
    for (const wss of routes.values()) for (const client of wss.clients) client.terminate();
    database.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  server.listen(port, arg("host", "127.0.0.1"), () => console.log(`room-server v2 listening on ${port}`));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
