import type { ControlServerConfig, McpServerConfig, McpServersMap, PlaywrightBrowser, PlaywrightConnection } from "@claude-desktop/shared";
import { validateMcpServerConfig } from "@claude-desktop/shared";

/** Editable draft of one MCP server row (strings for free typing). */
export type McpServerDraft = {
  /** stable local key for React list rendering */
  id: string;
  name: string;
  type: NonNullable<McpServersMap[string]["type"]>;
  browser?: PlaywrightBrowser;
  connection?: PlaywrightConnection;
  profile?: string;
  disabled?: boolean;
  original?: McpServersMap[string];
  command: string;
  /** space-separated args (stdio) */
  argsText: string;
  url: string;
  /** one KEY=VALUE per line (stdio env) */
  envText: string;
  /** one KEY=VALUE per line (sse/http headers) */
  headersText: string;
};

let mcpDraftSeq = 0;
export function suggestMcpServerName(type: McpServerDraft["type"], rows: McpServerDraft[]): string {
  if (type !== "playwright" && type !== "windows-computer") return "";
  const base = type === "playwright" ? "browser" : "computer";
  const names = new Set(rows.map((row) => row.name.trim()));
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base}-${n}`;
  return name;
}

function newMcpDraftId(): string {
  mcpDraftSeq += 1;
  return `mcp-${Date.now()}-${mcpDraftSeq}`;
}

function kvRecordToText(rec?: Record<string, string>): string {
  if (!rec) return "";
  return Object.entries(rec)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function kvTextToRecord(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function mcpServersToDrafts(map?: McpServersMap, disabled?: Record<string, ControlServerConfig>): McpServerDraft[] {
  const inactive = Object.entries(disabled ?? {}).filter(([name]) => !Object.hasOwn(map ?? {}, name));
  return [...Object.entries(map ?? {}), ...inactive].map(([name, cfg]) => {
    const base = { id: newMcpDraftId(), name, original: cfg, disabled: !Object.hasOwn(map ?? {}, name) };
    if (cfg.type === "windows-computer") {
      return { ...base, type: cfg.type,
        command: "", argsText: "", url: "", envText: "", headersText: "" };
    }
    if (cfg.type === "playwright") {
      return { ...base, type: cfg.type, browser: cfg.browser,
        connection: cfg.connection ?? "extension", profile: cfg.profile,
        command: "", argsText: "", url: "", envText: "", headersText: "" };
    }
    if (cfg.type === "sse" || cfg.type === "http") {
      return {
        ...base,
        type: cfg.type,
        command: "",
        argsText: "",
        url: cfg.url ?? "",
        envText: "",
        headersText: kvRecordToText(cfg.headers),
      };
    }
    return {
      ...base,
      type: "stdio",
      command: cfg.command ?? "",
      argsText: (cfg.args ?? []).join(" "),
      url: "",
      envText: kvRecordToText(cfg.env),
      headersText: "",
    };
  });
}

export type ControlTarget = "windows-computer" | PlaywrightBrowser;

export function controlTarget(row: McpServerDraft): ControlTarget | undefined {
  if (row.type === "playwright") return row.browser ?? "msedge";
  if (row.type === "windows-computer") return row.type;
}

export function newMcpRow(rows: McpServerDraft[], type: McpServerDraft["type"], browser?: PlaywrightBrowser, disabled = false): McpServerDraft {
  return {
    id: newMcpDraftId(), name: suggestMcpServerName(type, rows), type,
    ...(type === "playwright" && { browser: browser ?? "msedge", connection: "extension" }),
    disabled, command: "", argsText: "", url: "", envText: "", headersText: "",
  };
}

export function setControlEnabled(rows: McpServerDraft[], target: ControlTarget, enabled: boolean): McpServerDraft[] {
  if (!rows.some(row => controlTarget(row) === target)) {
    if (!enabled) return rows;
    return [...rows, target === "windows-computer"
      ? newMcpRow(rows, target) : newMcpRow(rows, "playwright", target)];
  }
  return rows.map(row => controlTarget(row) === target ? { ...row, disabled: !enabled } : row);
}

function configFromDraft(row: McpServerDraft): McpServerConfig {
  if (row.type === "windows-computer") return { type: row.type };
  if (row.type === "playwright") return {
    type: row.type, browser: row.browser ?? "msedge", connection: row.connection ?? "extension",
    ...(row.profile?.trim() && { profile: row.profile.trim() }),
  };
  const original = row.original;
  // Preserve SDK options that have no editable field when saving control settings.
  const options = original && original.type !== "windows-computer" && original.type !== "playwright" ? {
    ...(original.timeout !== undefined && { timeout: original.timeout }),
    ...(original.alwaysLoad !== undefined && { alwaysLoad: original.alwaysLoad }),
  } : {};
  if (row.type === "stdio") {
    const old = original && (!original.type || original.type === "stdio") ? original : undefined;
    const args = old && (old.args ?? []).join(" ") === row.argsText ? old.args
      : row.argsText.trim() ? row.argsText.trim().split(/\s+/) : undefined;
    const env = old && kvRecordToText(old.env) === row.envText ? old.env : kvTextToRecord(row.envText);
    return {
      ...options, ...(!old || old.type ? { type: "stdio" as const } : {}),
      command: old?.command === row.command ? old.command : row.command.trim(),
      ...(args && { args }), ...(env && { env }),
    };
  }
  const old = original?.type === "sse" || original?.type === "http" ? original : undefined;
  const headers = old && kvRecordToText(old.headers) === row.headersText ? old.headers : kvTextToRecord(row.headersText);
  return { ...options, type: row.type, url: row.url.trim(), ...(headers && { headers }) };
}

export function buildMcpServersPatch(drafts: McpServerDraft[]):
  | { ok: true; mcpServers: McpServersMap; disabledControlServers: Record<string, ControlServerConfig> }
  | { ok: false; error: string; row: string } {
  const mcpServers: McpServersMap = {};
  const disabledControlServers: Record<string, ControlServerConfig> = {};
  const seen = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name && !controlTarget(draft)) continue;
    if (seen.has(name)) return { ok: false, error: `服务器名称 "${name}" 重复`, row: draft.id };
    seen.add(name);
    const config = configFromDraft(draft);
    const error = validateMcpServerConfig(name, config);
    if (error) return { ok: false, error, row: draft.id };
    if (draft.disabled && (config.type === "windows-computer" || config.type === "playwright")) {
      disabledControlServers[name] = config;
    } else {
      mcpServers[name] = config;
    }
  }
  return { ok: true, mcpServers, disabledControlServers };
}
