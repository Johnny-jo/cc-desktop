/**
 * Serializable MCP server configuration stored in app settings.
 *
 * Mirrors the SDK's McpServerConfig but restricted to plain JSON-safe shapes
 * (no in-process `sdk` server instances, which cannot cross IPC or persist).
 * The desktop main process resolves bundled presets to stdio at launch.
 */

export type McpStdioConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  alwaysLoad?: boolean;
};

export type McpSseConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  alwaysLoad?: boolean;
};

export type McpHttpConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  alwaysLoad?: boolean;
};

export type PlaywrightBrowser = "chrome" | "msedge";
export type PlaywrightConnection = "extension" | "isolated" | "cdp";
export type BrowserExtensionSetupRequest = { browser: PlaywrightBrowser; profile?: string };
export type BrowserAuthorizationRequest = BrowserExtensionSetupRequest & { token: string };
export type BrowserAuthorizationStatus = {
  browser: PlaywrightBrowser;
  profileName: string;
  configured: boolean;
};
export type BrowserExtensionSetupStatus = {
  browser: PlaywrightBrowser;
  profileName: string;
  state: "ready" | "pending-download" | "pending-enable";
  message: string;
  registered: boolean;
};
export type ControlServerConfig =
  | { type: "windows-computer" }
  | { type: "playwright"; browser: PlaywrightBrowser; connection?: PlaywrightConnection; profile?: string; cdpEndpoint?: string };

export type McpServerConfig = McpStdioConfig | McpSseConfig | McpHttpConfig | ControlServerConfig;
export type McpServersMap = Record<string, McpServerConfig>;

/** Live connection status for one MCP server in a running session. */
export type SessionMcpServerStatus = {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | string;
  error?: string;
  /** Server-reported identity (available when connected) */
  serverInfo?: { name: string; version: string };
  /** Configuration scope (project / user / local / app…) */
  scope?: string;
  tools?: Array<{
    name: string;
    description?: string;
    annotations?: {
      readOnly?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
    };
  }>;
};

/** Result of applying a new MCP server set to a live session. */
export type McpSetServersResultDto = {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
};

/** Validate a single server name (map key). */
export function validateMcpServerName(name: string): string | null {
  const n = name.trim();
  if (!n) return "name is required";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(n)) {
    return "name must start with a letter/digit and contain only letters, digits, . _ -";
  }
  return null;
}

/** CDP URLs are persisted in settings; credential values belong in a separate protected transport. */
export function normalizeCdpEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error("CDP 地址必须是 HTTP(S) 或 WS(S) URL");
  const endpoint = value.trim();
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("CDP 地址必须是 HTTP(S) 或 WS(S) URL"); }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash || /[\u0000-\u0020\u007f]/.test(endpoint)) {
    throw new Error("CDP 地址必须是 HTTP(S) 或 WS(S) URL，且不包含账号密码、查询参数或片段");
  }
  return endpoint;
}

/** Validate one server config; returns an error message or null. */
export function validateMcpServerConfig(
  name: string,
  cfg: McpServerConfig,
): string | null {
  const nameErr = validateMcpServerName(name);
  if (nameErr) return nameErr;
  if (cfg.type === "windows-computer") return null;
  if (cfg.type === "playwright") {
    if (cfg.browser !== "chrome" && cfg.browser !== "msedge") return `"${name}": select Chrome or Edge`;
    if (cfg.connection !== undefined && cfg.connection !== "extension" && cfg.connection !== "isolated" && cfg.connection !== "cdp") {
      return `"${name}": connection must be extension, isolated or cdp`;
    }
    if (cfg.connection === "cdp") {
      try { normalizeCdpEndpoint(cfg.cdpEndpoint); } catch (error) { return `"${name}": ${(error as Error).message}`; }
    }
    if (cfg.profile !== undefined && !isSafeBrowserProfile(cfg.profile)) {
      return `"${name}": profile must be a directory name of at most 80 characters (for example Profile 2)`;
    }
    return null;
  }
  if (cfg.type === "sse" || cfg.type === "http") {
    const url = (cfg.url ?? "").trim();
    if (!url) return `"${name}": url is required for ${cfg.type}`;
    if (!/^https?:\/\/.+/.test(url)) return `"${name}": url must start with http:// or https://`;
    return null;
  }
  // stdio (type may be omitted)
  const command = (cfg.command ?? "").trim();
  if (!command) return `"${name}": command is required for stdio`;
  return null;
}

export type BuildMcpServersResult =
  | { ok: true; mcpServers: McpServersMap }
  | { ok: false; error: string };

/**
 * Validate a whole map of servers (from settings load or a settings form).
 * Returns the first validation error, or the map unchanged when all valid.
 */
export function validateMcpServers(map: McpServersMap): BuildMcpServersResult {
  for (const [name, cfg] of Object.entries(map)) {
    const err = validateMcpServerConfig(name, cfg);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, mcpServers: map };
}

/** Type guard / sanitizer used when loading settings.json from disk. */
export function sanitizeMcpServers(raw: unknown): McpServersMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: McpServersMap = {};
  for (const [name, cfgRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (validateMcpServerName(name)) continue;
    if (!cfgRaw || typeof cfgRaw !== "object" || Array.isArray(cfgRaw)) continue;
    const c = cfgRaw as Record<string, unknown>;
    const type = c.type;
    if (type === "windows-computer") {
      out[name] = { type };
    } else if (type === "playwright") {
      const connection = c.connection;
      if (c.browser !== "chrome" && c.browser !== "msedge") continue;
      if (connection !== undefined && connection !== "extension" && connection !== "isolated" && connection !== "cdp") continue;
      let cdpEndpoint: string | undefined;
      if (connection === "cdp") {
        try { cdpEndpoint = normalizeCdpEndpoint(c.cdpEndpoint); } catch { continue; }
      }
      if (c.profile !== undefined && !isSafeBrowserProfile(c.profile)) continue;
      const cfg: Extract<McpServerConfig, { type: "playwright" }> = {
        type,
        browser: c.browser,
        ...(connection !== undefined ? { connection } : {}),
        ...(connection !== "cdp" && c.profile !== undefined ? { profile: c.profile } : {}),
        ...(cdpEndpoint !== undefined ? { cdpEndpoint } : {}),
      };
      out[name] = cfg;
    } else if (type === "sse" || type === "http") {
      const url = typeof c.url === "string" ? c.url : "";
      if (!url) continue;
      const cfg: McpServerConfig = {
        type,
        url,
        ...(isStringRecord(c.headers) ? { headers: c.headers } : {}),
        ...(typeof c.timeout === "number" ? { timeout: c.timeout } : {}),
        ...(typeof c.alwaysLoad === "boolean" ? { alwaysLoad: c.alwaysLoad } : {}),
      };
      out[name] = cfg;
    } else {
      const command = typeof c.command === "string" ? c.command : "";
      if (!command) continue;
      const cfg: McpServerConfig = {
        ...(type === "stdio" ? { type: "stdio" as const } : {}),
        command,
        ...(Array.isArray(c.args) ? { args: c.args.map(String) } : {}),
        ...(isStringRecord(c.env) ? { env: c.env } : {}),
        ...(typeof c.timeout === "number" ? { timeout: c.timeout } : {}),
        ...(typeof c.alwaysLoad === "boolean" ? { alwaysLoad: c.alwaysLoad } : {}),
      };
      out[name] = cfg;
    }
  }
  return out;
}

function isSafeBrowserProfile(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 &&
    value !== "." && value !== ".." && !/[<>:"/\\|?*\u0000-\u001f]/.test(value);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => typeof x === "string",
  );
}
