import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCloudflared, type RuntimePathEnv } from "./runtime-paths";

/**
 * T2 Cloudflare tunnel for room hosting (plan task 11).
 *
 * Quick tunnel: `cloudflared tunnel --url http://127.0.0.1:<port>` prints an
 * ephemeral https://<name>.trycloudflare.com URL; we rewrite it to wss:// and
 * hand it to the invite. Named tunnel: userData/cloudflare-tunnel.json holds
 * `{ token, wss }` — the token never enters invites, IPC results, or logs.
 *
 * Every failure resolves to `{ ok: false }`; callers keep the room LAN-only.
 */

/** Default wait for cloudflared to print the quick-tunnel URL. */
export const ROOM_TUNNEL_URL_TIMEOUT_MS = 30_000;

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export type RoomTunnelResult =
  | { ok: true; wss: string; kill: () => void }
  | { ok: false; error: string };

/** Named-tunnel settings kept in userData/cloudflare-tunnel.json. */
export type NamedTunnelConfig = {
  /** Tunnel token — never logged, never sent over IPC, never in invites. */
  token: string;
  /** Public wss:// endpoint routed to this tunnel by the user's CF account. */
  wss?: string;
};

/** First trycloudflare URL in a cloudflared log chunk, rewritten to wss://. */
export function parseQuickTunnelUrl(text: string): string | null {
  const m = text.match(QUICK_URL_RE);
  return m ? m[0].replace(/^https:/i, "wss:") : null;
}

/** cloudflared argv for quick vs named tunnels. Pure, for tests. */
export function tunnelArgs(
  port: number,
  named?: NamedTunnelConfig | null,
): string[] {
  if (named) {
    return ["tunnel", "run", "--token", named.token, "--no-autoupdate"];
  }
  return ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"];
}

/** userData/cloudflare-tunnel.json → { token, wss } or null. Never throws. */
export function readNamedTunnelConfig(
  userDataDir: string,
): NamedTunnelConfig | null {
  try {
    const p = path.join(userDataDir, "cloudflare-tunnel.json");
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      token?: unknown;
      wss?: unknown;
    };
    const token = typeof raw.token === "string" ? raw.token.trim() : "";
    if (!token) return null;
    const wss = typeof raw.wss === "string" ? raw.wss.trim() : "";
    return { token, ...(wss ? { wss } : {}) };
  } catch {
    return null;
  }
}

/** Test hook: .js paths run via the current Node so fake binaries work on Windows. */
function spawnCloudflared(binPath: string, args: string[]): ChildProcess {
  const opts: SpawnOptions = { stdio: ["ignore", "pipe", "pipe"] };
  if (/\.(m?js|cjs)$/i.test(binPath)) {
    return spawn(process.execPath, [binPath, ...args], opts);
  }
  return spawn(binPath, args, opts);
}

/**
 * Spawn cloudflared for this room's port.
 * Quick tunnel: parse the first trycloudflare URL from stdout/stderr.
 * Named tunnel (opts.named): the URL comes from the config file, not stdout.
 */
export function startQuickTunnel(opts: {
  port: number;
  cloudflaredPath: string;
  named?: NamedTunnelConfig | null;
  timeoutMs?: number;
}): Promise<RoomTunnelResult> {
  if (opts.named && !opts.named.wss) {
    return Promise.resolve({
      ok: false,
      error: "cloudflare-tunnel.json 缺少 wss 公网地址",
    });
  }
  const timeoutMs = opts.timeoutMs ?? ROOM_TUNNEL_URL_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (res: RoomTunnelResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(res);
    };

    let child: ChildProcess;
    try {
      child = spawnCloudflared(
        opts.cloudflaredPath,
        tunnelArgs(opts.port, opts.named),
      );
    } catch {
      settle({ ok: false, error: "未找到 cloudflared" });
      return;
    }

    const kill = () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    };

    timer = setTimeout(() => {
      kill();
      settle({ ok: false, error: "隧道启动超时" });
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      // Never log cloudflared output — named tokens must not reach logs.
      if (opts.named) return;
      const url = parseQuickTunnelUrl(String(chunk));
      if (url) settle({ ok: true, wss: url, kill });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      kill();
      settle({
        ok: false,
        error: /ENOENT/.test(String(err)) ? "未找到 cloudflared" : "隧道启动失败",
      });
    });
    child.on("exit", () => {
      settle({ ok: false, error: "隧道启动失败（cloudflared 已退出）" });
    });
    child.on("spawn", () => {
      // Named tunnel: the public URL is configured, not printed.
      if (opts.named?.wss) settle({ ok: true, wss: opts.named.wss, kill });
    });
  });
}

/**
 * Resolve cloudflared + the named config, then start the tunnel.
 * Missing binary / bad config resolve to ok:false — callers keep the LAN room.
 */
export function startRoomTunnel(opts: {
  port: number;
  env: RuntimePathEnv;
  timeoutMs?: number;
}): Promise<RoomTunnelResult> {
  const binPath = resolveCloudflared(opts.env);
  if (!binPath) {
    return Promise.resolve({ ok: false, error: "未找到 cloudflared" });
  }
  const named = readNamedTunnelConfig(opts.env.userDataDir);
  return startQuickTunnel({
    port: opts.port,
    cloudflaredPath: binPath,
    named,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
