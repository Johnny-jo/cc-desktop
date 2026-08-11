import React, { useEffect, useState } from "react";
import type {
  AppSettings,
  McpServersMap,
  ModelInfo,
  PublicSettings,
  SessionMcpServerStatus,
} from "@claude-desktop/shared";
import {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  buildModelContextLimitsPatch,
  resolveContextLimit,
  validateMcpServers,
} from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import {
  getState,
  saveSettings,
  syncCpaModels,
  useAppStore,
} from "../state/store";

export type SettingsDrawerProps = {
  open: boolean;
  onClose: () => void;
};

/** Editable draft of one MCP server row (strings for free typing). */
type McpServerDraft = {
  /** stable local key for React list rendering */
  id: string;
  name: string;
  type: "stdio" | "sse" | "http";
  command: string;
  /** space-separated args (stdio) */
  argsText: string;
  url: string;
  /** one KEY=VALUE per line (stdio env) */
  envText: string;
  /** one KEY=VALUE per line (sse/http headers) */
  headersText: string;
};

type FormState = {
  cpaExePath: string;
  cpaConfigPath: string;
  cpaPort: string;
  token: string;
  modelsCsv: string;
  defaultModel: string;
  shutdownCpaOnQuit: boolean;
  defaultContextLimit: string;
  /** modelId → override 字符串；缺省或 "" = auto */
  modelContextLimitDraft: Record<string, string>;
  mcpServers: McpServerDraft[];
};

let mcpDraftSeq = 0;
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

function mcpServersToDrafts(map?: McpServersMap): McpServerDraft[] {
  return Object.entries(map ?? {}).map(([name, cfg]) => {
    if (cfg.type === "sse" || cfg.type === "http") {
      return {
        id: newMcpDraftId(),
        name,
        type: cfg.type,
        command: "",
        argsText: "",
        url: cfg.url ?? "",
        envText: "",
        headersText: kvRecordToText(cfg.headers),
      };
    }
    return {
      id: newMcpDraftId(),
      name,
      type: "stdio",
      command: cfg.command ?? "",
      argsText: (cfg.args ?? []).join(" "),
      url: "",
      envText: kvRecordToText(cfg.env),
      headersText: "",
    };
  });
}

/** Convert draft rows to a validated McpServersMap, or return an error. */
function buildMcpServersPatch(
  drafts: McpServerDraft[],
): { ok: true; mcpServers: McpServersMap } | { ok: false; error: string } {
  const map: McpServersMap = {};
  const seen = new Set<string>();
  for (const d of drafts) {
    const name = d.name.trim();
    if (!name) continue; // skip empty rows
    if (seen.has(name)) return { ok: false, error: `Duplicate MCP server name "${name}"` };
    seen.add(name);
    if (d.type === "stdio") {
      map[name] = {
        type: "stdio",
        command: d.command.trim(),
        ...(d.argsText.trim()
          ? { args: d.argsText.trim().split(/\s+/) }
          : {}),
        ...(kvTextToRecord(d.envText) ? { env: kvTextToRecord(d.envText) } : {}),
      };
    } else {
      map[name] = {
        type: d.type,
        url: d.url.trim(),
        ...(kvTextToRecord(d.headersText)
          ? { headers: kvTextToRecord(d.headersText) }
          : {}),
      };
    }
  }
  const validated = validateMcpServers(map);
  if (!validated.ok) return { ok: false, error: validated.error };
  return { ok: true, mcpServers: map };
}

function fromSettings(s: PublicSettings | null): FormState {
  const draft: Record<string, string> = {};
  for (const [k, v] of Object.entries(s?.modelContextLimits ?? {})) {
    draft[k] = String(v);
  }
  return {
    cpaExePath: s?.cpaExePath ?? "",
    cpaConfigPath: s?.cpaConfigPath ?? "",
    cpaPort: String(s?.cpaPort ?? 8317),
    token: "",
    modelsCsv: (s?.models ?? []).join(", "),
    defaultModel: s?.defaultModel ?? "",
    shutdownCpaOnQuit: s?.shutdownCpaOnQuit ?? false,
    defaultContextLimit: String(s?.defaultContextLimit ?? 200_000),
    modelContextLimitDraft: draft,
    mcpServers: mcpServersToDrafts(s?.mcpServers),
  };
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const settings = useAppStore((s) => s.settings);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessionStatus = useAppStore((s) =>
    s.activeSessionId
      ? s.sessions.find((x) => x.id === s.activeSessionId)?.status
      : undefined,
  );
  const [form, setForm] = useState<FormState>(() => fromSettings(settings));
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /** Live MCP status by server name (from running session or probe) */
  const [mcpLive, setMcpLive] = useState<Record<string, SessionMcpServerStatus>>({});
  const [mcpProbing, setMcpProbing] = useState(false);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [mcpNote, setMcpNote] = useState<string | null>(null);

  async function refreshCatalog() {
    try {
      const desktop = getDesktop();
      const list = await desktop.getModelCatalog();
      setCatalog(Array.isArray(list) ? list : []);
    } catch {
      setCatalog([]);
    }
  }

  function visibleModelIds(modelsCsv: string, cat: ModelInfo[]): string[] {
    const fromCsv = modelsCsv
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const set = new Set<string>([...fromCsv, ...cat.map((m) => m.id)]);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  useEffect(() => {
    if (!open) return;
    setForm(fromSettings(settings));
    setLocalError(null);
    setSavedNote(null);
    setMcpNote(null);
    setMcpLive({});
    void refreshCatalog();
    void refreshMcpLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings]);

  /**
   * Load live MCP status: prefer the active session's control request;
   * fall back to a throwaway probe query when no session is running.
   */
  async function refreshMcpLive() {
    try {
      const desktop = getDesktop();
      let statuses: SessionMcpServerStatus[] | null = null;
      if (activeSessionId) {
        const res = await desktop.getSessionMcpStatus(activeSessionId);
        statuses = res?.statuses ?? null;
      }
      if (statuses === null) {
        setMcpProbing(true);
        try {
          const res = await desktop.probeMcpServers();
          statuses = res.statuses;
        } finally {
          setMcpProbing(false);
        }
      }
      setMcpLive(
        Object.fromEntries((statuses ?? []).map((s) => [s.name, s])),
      );
    } catch {
      // best-effort; status badges just stay hidden
    }
  }

  async function onMcpReconnect(name: string) {
    if (!activeSessionId) return;
    setMcpBusy(name);
    setMcpNote(null);
    try {
      const res = await getDesktop().reconnectSessionMcpServer(
        activeSessionId,
        name,
      );
      if (!res.ok) setMcpNote(`Reconnect ${name}: ${res.error ?? "failed"}`);
      await refreshMcpLive();
    } catch (err) {
      setMcpNote(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpBusy(null);
    }
  }

  async function onMcpToggle(name: string, enabled: boolean) {
    if (!activeSessionId) return;
    setMcpBusy(name);
    setMcpNote(null);
    try {
      const res = await getDesktop().toggleSessionMcpServer(
        activeSessionId,
        name,
        enabled,
      );
      if (!res.ok) setMcpNote(`Toggle ${name}: ${res.error ?? "failed"}`);
      await refreshMcpLive();
    } catch (err) {
      setMcpNote(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpBusy(null);
    }
  }

  async function onMcpProbeDraft() {
    setMcpNote(null);
    const patchMcp = buildMcpServersPatch(form.mcpServers);
    if (!patchMcp.ok) {
      setLocalError(patchMcp.error);
      return;
    }
    setMcpProbing(true);
    try {
      const res = await getDesktop().probeMcpServers(patchMcp.mcpServers);
      setMcpLive(
        Object.fromEntries(res.statuses.map((s) => [s.name, s])),
      );
      const failed = res.statuses.filter((s) => s.status === "failed");
      setMcpNote(
        failed.length
          ? `Probe: ${failed.length} server(s) failed`
          : `Probe: ${res.statuses.length} server(s) connected`,
      );
    } catch (err) {
      setMcpNote(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpProbing(false);
    }
  }

  if (!open) return null;

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  function renderContextLimitsTable() {
    const ids = visibleModelIds(form.modelsCsv, catalog);
    const defaultLimit = Number(form.defaultContextLimit);
    const draftAsNumbers: Record<string, number> = {};
    for (const [k, v] of Object.entries(form.modelContextLimitDraft)) {
      const p = v.trim();
      if (!p) continue;
      const n = Number(p);
      if (Number.isFinite(n) && n >= CONTEXT_LIMIT_MIN && n <= CONTEXT_LIMIT_MAX) {
        draftAsNumbers[k] = Math.floor(n);
      }
    }
    const limitSettings = {
      defaultContextLimit:
        Number.isFinite(defaultLimit) && defaultLimit > 0
          ? Math.floor(defaultLimit)
          : 200_000,
      modelContextLimits: {
        ...(settings?.modelContextLimits ?? {}),
        ...draftAsNumbers,
      },
    };
    for (const id of ids) {
      const raw = (form.modelContextLimitDraft[id] ?? "").trim();
      if (!raw) delete limitSettings.modelContextLimits[id];
    }

    return (
      <div className="settings-context-limits">
        <div className="settings-context-limits-title">Per-model context limits</div>
        <p className="settings-hint">
          Empty override = CPA / builtin / default. Changes apply on the next turn.
        </p>
        <div className="settings-context-limits-table-wrap">
          <table className="settings-context-limits-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Effective</th>
                <th>Override</th>
              </tr>
            </thead>
            <tbody>
              {ids.length === 0 ? (
                <tr>
                  <td colSpan={3} className="settings-hint">
                    No models — edit Models list or Sync from CPA
                  </td>
                </tr>
              ) : (
                ids.map((id) => {
                  const { limitTokens, source } = resolveContextLimit(
                    id,
                    limitSettings,
                    catalog,
                  );
                  return (
                    <tr key={id}>
                      <td className="settings-context-limits-model">{id}</td>
                      <td>
                        <span className="settings-context-limits-effective">
                          {limitTokens}
                        </span>{" "}
                        <span
                          className={`settings-context-limits-source source-${source}`}
                        >
                          {source}
                        </span>
                      </td>
                      <td>
                        <input
                          type="number"
                          min={CONTEXT_LIMIT_MIN}
                          step={1024}
                          placeholder="auto"
                          value={form.modelContextLimitDraft[id] ?? ""}
                          onChange={(e) =>
                            setForm((prev) => ({
                              ...prev,
                              modelContextLimitDraft: {
                                ...prev.modelContextLimitDraft,
                                [id]: e.target.value,
                              },
                            }))
                          }
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  function updateMcpRow(id: string, patch: Partial<McpServerDraft>) {
    setForm((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((r) =>
        r.id === id ? { ...r, ...patch } : r,
      ),
    }));
  }

  function addMcpRow() {
    setForm((prev) => ({
      ...prev,
      mcpServers: [
        ...prev.mcpServers,
        {
          id: newMcpDraftId(),
          name: "",
          type: "stdio",
          command: "",
          argsText: "",
          url: "",
          envText: "",
          headersText: "",
        },
      ],
    }));
  }

  function removeMcpRow(id: string) {
    setForm((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.filter((r) => r.id !== id),
    }));
  }

  function renderMcpStatus(row: McpServerDraft) {
    const live = mcpLive[row.name.trim()];
    if (!live) return null;
    const enabled = live.status !== "disabled";
    return (
      <div className="settings-mcp-status">
        <span className={`mcp-badge mcp-badge-${live.status}`}>
          {live.status}
        </span>
        {live.serverInfo ? (
          <span className="settings-hint">
            {live.serverInfo.name}@{live.serverInfo.version}
          </span>
        ) : null}
        {live.tools ? (
          <span className="settings-hint" title={live.tools.map((t) => t.name).join(", ")}>
            {live.tools.length} tools
          </span>
        ) : null}
        {live.error ? (
          <span className="settings-mcp-error" title={live.error}>
            {live.error}
          </span>
        ) : null}
        {activeSessionId && sessionStatus !== "running" ? (
          <span className="settings-mcp-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={mcpBusy === row.name}
              onClick={() => void onMcpReconnect(row.name.trim())}
            >
              Reconnect
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={mcpBusy === row.name}
              onClick={() => void onMcpToggle(row.name.trim(), !enabled)}
            >
              {enabled ? "Disable" : "Enable"}
            </button>
          </span>
        ) : null}
      </div>
    );
  }

  function renderMcpServers() {
    return (
      <div className="settings-mcp">
        <div className="settings-context-limits-title">MCP servers</div>
        <p className="settings-hint">
          stdio runs a local command; sse/http connect to a URL. Env / headers:
          one KEY=VALUE per line. Applies to new sessions. Only these servers
          are loaded (project .mcp.json / user MCP settings are ignored).
        </p>
        {form.mcpServers.length === 0 ? (
          <p className="settings-hint">No MCP servers configured.</p>
        ) : (
          form.mcpServers.map((row) => (
            <div key={row.id} className="settings-mcp-row">
              <div className="settings-mcp-row-head">
                <input
                  className="settings-mcp-name"
                  placeholder="name"
                  value={row.name}
                  spellCheck={false}
                  onChange={(e) => updateMcpRow(row.id, { name: e.target.value })}
                />
                <select
                  className="select settings-mcp-type"
                  value={row.type}
                  onChange={(e) =>
                    updateMcpRow(row.id, {
                      type: e.target.value as McpServerDraft["type"],
                    })
                  }
                >
                  <option value="stdio">stdio</option>
                  <option value="sse">sse</option>
                  <option value="http">http</option>
                </select>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm settings-mcp-remove"
                  title="Remove server"
                  onClick={() => removeMcpRow(row.id)}
                >
                  ×
                </button>
              </div>
              {renderMcpStatus(row)}
              {row.type === "stdio" ? (
                <>
                  <input
                    placeholder="command (e.g. node)"
                    value={row.command}
                    spellCheck={false}
                    onChange={(e) =>
                      updateMcpRow(row.id, { command: e.target.value })
                    }
                  />
                  <input
                    placeholder="args (space-separated)"
                    value={row.argsText}
                    spellCheck={false}
                    onChange={(e) =>
                      updateMcpRow(row.id, { argsText: e.target.value })
                    }
                  />
                  <textarea
                    rows={2}
                    placeholder={"env (KEY=VALUE per line, optional)"}
                    value={row.envText}
                    spellCheck={false}
                    onChange={(e) =>
                      updateMcpRow(row.id, { envText: e.target.value })
                    }
                  />
                </>
              ) : (
                <>
                  <input
                    placeholder="url (https://…)"
                    value={row.url}
                    spellCheck={false}
                    onChange={(e) => updateMcpRow(row.id, { url: e.target.value })}
                  />
                  <textarea
                    rows={2}
                    placeholder={"headers (KEY=VALUE per line, optional)"}
                    value={row.headersText}
                    spellCheck={false}
                    onChange={(e) =>
                      updateMcpRow(row.id, { headersText: e.target.value })
                    }
                  />
                </>
              )}
            </div>
          ))
        )}
        <div className="settings-inline-actions">
          <button type="button" className="btn btn-sm" onClick={addMcpRow}>
            + Add MCP server
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={mcpProbing || form.mcpServers.length === 0}
            title="Spawn a throwaway session and test every server in this form"
            onClick={() => void onMcpProbeDraft()}
          >
            {mcpProbing ? "Probing…" : "Test connections"}
          </button>
        </div>
        {mcpNote ? <p className="settings-hint">{mcpNote}</p> : null}
      </div>
    );
  }

  const onSave = async () => {
    setLocalError(null);
    setSavedNote(null);
    const port = Number(form.cpaPort);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      setLocalError("Port must be a number between 1 and 65535");
      return;
    }
    const models = form.modelsCsv
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length === 0) {
      setLocalError("Models list cannot be empty");
      return;
    }
    const defaultModel = form.defaultModel.trim() || models[0];
    if (!models.includes(defaultModel)) {
      models.unshift(defaultModel);
    }
    const defaultContextLimit = Number(form.defaultContextLimit);
    if (
      !Number.isFinite(defaultContextLimit) ||
      defaultContextLimit < CONTEXT_LIMIT_MIN ||
      defaultContextLimit > CONTEXT_LIMIT_MAX
    ) {
      setLocalError(
        `Default context limit must be between ${CONTEXT_LIMIT_MIN} and ${CONTEXT_LIMIT_MAX}`,
      );
      return;
    }

    const visibleIds = visibleModelIds(form.modelsCsv, catalog);
    const patchLimits = buildModelContextLimitsPatch({
      existing: settings?.modelContextLimits ?? {},
      visibleIds,
      draft: form.modelContextLimitDraft,
    });
    if (!patchLimits.ok) {
      setLocalError(patchLimits.error);
      return;
    }

    const patchMcp = buildMcpServersPatch(form.mcpServers);
    if (!patchMcp.ok) {
      setLocalError(patchMcp.error);
      return;
    }

    const patch: Partial<AppSettings> & { token?: string } = {
      cpaExePath: form.cpaExePath.trim(),
      cpaConfigPath: form.cpaConfigPath.trim(),
      cpaPort: port,
      models,
      defaultModel,
      shutdownCpaOnQuit: form.shutdownCpaOnQuit,
      defaultContextLimit: Math.floor(defaultContextLimit),
      modelContextLimits: patchLimits.modelContextLimits,
      mcpServers: patchMcp.mcpServers,
    };
    if (form.token.trim()) {
      patch.token = form.token.trim();
    }

    setSaving(true);
    try {
      await saveSettings(patch);
      setForm((prev) => ({ ...prev, token: "" }));
      setSavedNote("Saved");

      // Push the new MCP set into the running session so it takes effect
      // immediately (also persists — setMcpServers updates settings too).
      const mcpChanged =
        JSON.stringify(settings?.mcpServers ?? {}) !==
        JSON.stringify(patchMcp.mcpServers);
      if (mcpChanged && activeSessionId && sessionStatus === "running") {
        try {
          const res = await getDesktop().setSessionMcpServers(
            activeSessionId,
            patchMcp.mcpServers,
          );
          if (!res.ok) {
            setMcpNote(`Saved; live apply failed: ${res.error ?? "unknown"}`);
          } else if (res.result && Object.keys(res.result.errors).length) {
            setMcpNote(
              `Saved; connect errors: ${Object.entries(res.result.errors)
                .map(([n, e]) => `${n}: ${e}`)
                .join("; ")}`,
            );
          } else {
            setMcpNote("Applied to running session");
          }
          await refreshMcpLive();
        } catch {
          setMcpNote("Saved; live apply failed (session query gone)");
        }
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <aside
        className="settings-drawer"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2>Settings</h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings-body">
          <label className="settings-field">
            CPA executable
            <input
              value={form.cpaExePath}
              onChange={(e) => setField("cpaExePath", e.target.value)}
              spellCheck={false}
            />
          </label>

          <label className="settings-field">
            CPA config.yaml
            <input
              value={form.cpaConfigPath}
              onChange={(e) => setField("cpaConfigPath", e.target.value)}
              spellCheck={false}
            />
          </label>

          <label className="settings-field">
            CPA port
            <input
              type="number"
              min={1}
              max={65535}
              value={form.cpaPort}
              onChange={(e) => setField("cpaPort", e.target.value)}
            />
          </label>

          <label className="settings-field">
            Auth token
            <input
              type="password"
              autoComplete="off"
              placeholder={
                settings?.hasToken
                  ? "•••••••• (leave blank to keep)"
                  : "CPA / Anthropic token"
              }
              value={form.token}
              onChange={(e) => setField("token", e.target.value)}
            />
          </label>

          <label className="settings-field">
            Models (comma-separated)
            <input
              value={form.modelsCsv}
              onChange={(e) => setField("modelsCsv", e.target.value)}
              spellCheck={false}
            />
          </label>

          <div className="settings-inline-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={syncing}
              onClick={() => {
                void (async () => {
                  setLocalError(null);
                  setSavedNote(null);
                  setSyncing(true);
                  try {
                    await syncCpaModels();
                    const latest = getState().settings;
                    setForm(fromSettings(latest));
                    setSavedNote(
                      `Synced ${latest?.models?.length ?? 0} models from CPA`,
                    );
                    void refreshCatalog();
                  } catch (err) {
                    setLocalError(
                      err instanceof Error ? err.message : String(err),
                    );
                  } finally {
                    setSyncing(false);
                  }
                })();
              }}
            >
              {syncing ? "Syncing…" : "Sync models from CPA"}
            </button>
            <span className="settings-hint">
              Pulls /v1/models (e.g. deepseek-v4-flash)
            </span>
          </div>

          <label className="settings-field">
            Default model
            <input
              value={form.defaultModel}
              onChange={(e) => setField("defaultModel", e.target.value)}
              spellCheck={false}
            />
          </label>

          <label className="settings-field">
            Default context limit (tokens)
            <input
              type="number"
              min={1024}
              step={1024}
              value={form.defaultContextLimit}
              onChange={(e) => setField("defaultContextLimit", e.target.value)}
            />
          </label>
          <p className="settings-hint">
            Used when CPA/builtin has no window for the model. Default 200000.
          </p>

          {renderContextLimitsTable()}

          {renderMcpServers()}

          <label className="settings-check">
            <input
              type="checkbox"
              checked={form.shutdownCpaOnQuit}
              onChange={(e) => setField("shutdownCpaOnQuit", e.target.checked)}
            />
            Shut down CPA on quit (only if this app spawned it)
          </label>

          {localError ? <p className="settings-error">{localError}</p> : null}
          {savedNote ? <p className="settings-ok">{savedNote}</p> : null}
        </div>

        <footer className="settings-footer">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void onSave()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
