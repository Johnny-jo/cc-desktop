/**
 * Serializable MCP server configuration stored in app settings.
 *
 * Mirrors the SDK's McpServerConfig but restricted to plain JSON-safe shapes
 * (no in-process `sdk` server instances, which cannot cross IPC or persist).
 * Field names match the SDK so the stored config can be passed to
 * `query({ options: { mcpServers } })` with no transformation.
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

export type McpServerConfig = McpStdioConfig | McpSseConfig | McpHttpConfig;

export type McpServersMap = Record<string, McpServerConfig>;

/** Validate a single server name (map key). */
export function validateMcpServerName(name: string): string | null {
  const n = name.trim();
  if (!n) return "name is required";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(n)) {
    return "name must start with a letter/digit and contain only letters, digits, . _ -";
  }
  return null;
}

/** Validate one server config; returns an error message or null. */
export function validateMcpServerConfig(
  name: string,
  cfg: McpServerConfig,
): string | null {
  const nameErr = validateMcpServerName(name);
  if (nameErr) return nameErr;
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
    if (type === "sse" || type === "http") {
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

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => typeof x === "string",
  );
}
