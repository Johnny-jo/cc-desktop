import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  McpServersMap,
  ModelInfo,
  PublicSettings,
  SessionMcpServerStatus,
  UpdateStatusDto,
} from "@claude-desktop/shared";
import {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  buildModelContextLimitsPatch,
  normalizeRuleString,
  resolveContextLimit,
  validateMcpServers,
} from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import {
  getState,
  saveSettings,
  syncCpaModels,
  useAppStore,
} from "../state/store";
import { RoomModsSettings } from "./settings/RoomModsSettings";
import { ToggleSwitch } from "./ToggleSwitch";

const MemoryDiagnostics = lazy(() =>
  import("./settings/MemoryDiagnostics").then((module) => ({
    default: module.MemoryDiagnostics,
  })),
);

export type SettingsDrawerProps = {
  open: boolean;
  onClose: () => void;
};

type SettingsPage =
  | "general"
  | "room"
  | "cpa"
  | "diagnostics"
  | "permissions"
  | "agents"
  | "skills"
  | "plugins"
  | "mcp";

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

/** Editable draft of one custom agent. */
type AgentDraft = {
  id: string;
  name: string;
  description: string;
  model: string;
  toolsCsv: string;
  prompt: string;
};

let agentDraftSeq = 0;
function newAgentDraftId(): string {
  agentDraftSeq += 1;
  return `agent-${Date.now()}-${agentDraftSeq}`;
}

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
  /** Claude Code-style rules, one per line: Edit / Edit(src/**) / Bash(npm *) */
  permissionAllowText: string;
  permissionDenyText: string;
  /** "" = model default */
  effort: string;
  agents: AgentDraft[];
  /** local plugin dirs, one per line */
  pluginPathsText: string;
  /** global UI font size px */
  uiFontSize: string;
  /** code editor font size px */
  editorFontSize: string;
  /** generic update feed URL */
  updateFeedUrl: string;
  /** UI language: zh / en / follow system */
  locale: string;
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
    permissionAllowText: (s?.permissionAllow ?? []).join("\n"),
    permissionDenyText: (s?.permissionDeny ?? []).join("\n"),
    effort: s?.effort ?? "",
    agents: (s?.agents ?? []).map((a) => ({
      id: newAgentDraftId(),
      name: a.name,
      description: a.description,
      model: a.model ?? "",
      toolsCsv: (a.tools ?? []).join(", "),
      prompt: a.prompt,
    })),
    pluginPathsText: (s?.pluginPaths ?? []).join("\n"),
    uiFontSize: String(s?.uiFontSize ?? 13),
    editorFontSize: String(s?.editorFontSize ?? 12.5),
    updateFeedUrl: s?.updateFeedUrl ?? "",
    locale: s?.locale ?? "system",
  };
}

/** Convert agent drafts to the settings shape; error on first invalid row. */
function buildAgentsPatch(
  drafts: AgentDraft[],
): { ok: true; agents: NonNullable<AppSettings["agents"]> } | { ok: false; error: string } {
  const out: NonNullable<AppSettings["agents"]> = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const name = d.name.trim();
    if (!name && !d.description.trim() && !d.prompt.trim()) continue; // blank row
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
      return { ok: false, error: `Agent name "${name}" must start with a letter/digit (letters, digits, . _ -)` };
    }
    if (seen.has(name)) {
      return { ok: false, error: `Duplicate agent name "${name}"` };
    }
    seen.add(name);
    if (!d.description.trim()) {
      return { ok: false, error: `Agent "${name}": description is required` };
    }
    if (!d.prompt.trim()) {
      return { ok: false, error: `Agent "${name}": prompt is required` };
    }
    const tools = d.toolsCsv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    out.push({
      name,
      description: d.description.trim(),
      prompt: d.prompt.trim(),
      ...(tools.length ? { tools } : {}),
      ...(d.model.trim() ? { model: d.model.trim() } : {}),
    });
  }
  return { ok: true, agents: out };
}

/** Parse a one-per-line rules textarea; returns error on first bad line. */
function parseRulesText(
  text: string,
): { ok: true; rules: string[] } | { ok: false; error: string } {
  const rules: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const n = normalizeRuleString(line);
    if (!n) {
      return {
        ok: false,
        error: `Invalid rule "${line}" — use Edit, Edit(src/**) or Bash(npm run *)`,
      };
    }
    if (!rules.includes(n)) rules.push(n);
  }
  return { ok: true, rules };
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
  /** IDEA 风格左侧导航当前页 */
  const [page, setPage] = useState<SettingsPage>("general");
  const [skillsInfo, setSkillsInfo] = useState<{
    userDir: string;
    projectDir: string | null;
    skills: Array<{ name: string; scope: "user" | "project"; path: string }>;
  } | null>(null);
  const [skillsNote, setSkillsNote] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusDto | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [savedFingerprint, setSavedFingerprint] = useState(() =>
    JSON.stringify(fromSettings(settings)),
  );
  const [closePending, setClosePending] = useState(false);
  const openedRef = useRef(false);

  async function refreshSkills() {
    try {
      const info = await getDesktop().listSkills();
      setSkillsInfo(info);
    } catch {
      setSkillsInfo(null);
    }
  }

  async function onOpenSkillsDir(scope: "user" | "project") {
    setSkillsNote(null);
    try {
      const res = await getDesktop().openSkillsDir(scope);
      if (!res.ok) setSkillsNote(res.error ?? "打开失败");
    } catch (err) {
      setSkillsNote(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDeleteSkill(name: string, scope: "user" | "project") {
    if (!window.confirm(`删除 skill「${name}」？该操作会移除整个目录。`)) return;
    setSkillsNote(null);
    try {
      const res = await getDesktop().deleteSkill(name, scope);
      if (!res.ok) {
        setSkillsNote(res.error ?? "删除失败");
        return;
      }
      await refreshSkills();
      if (activeSessionId) {
        void getDesktop().reloadSkills(activeSessionId);
      }
      setSkillsNote(`已删除「${name}」`);
    } catch (err) {
      setSkillsNote(err instanceof Error ? err.message : String(err));
    }
  }

  async function onReloadSkills() {
    if (!activeSessionId) return;
    setSkillsNote(null);
    try {
      const res = await getDesktop().reloadSkills(activeSessionId);
      setSkillsNote(res.ok ? "已重载到当前会话" : res.error ?? "重载失败");
    } catch (err) {
      setSkillsNote(err instanceof Error ? err.message : String(err));
    }
  }

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
    if (!open) {
      openedRef.current = false;
      // Restore live-preview font if user closed without saving
      if (settings) {
        document.documentElement.style.setProperty(
          "--ui-font-size",
          `${settings.uiFontSize ?? 13}px`,
        );
      }
      return;
    }
    // Saving updates the global settings store while this dialog is open.
    // Only initialise on the closed -> open transition so a successful save
    // does not immediately wipe its own confirmation state or newer edits.
    if (openedRef.current) return;
    openedRef.current = true;
    const initialForm = fromSettings(settings);
    setForm(initialForm);
    setSavedFingerprint(JSON.stringify(initialForm));
    setClosePending(false);
    setLocalError(null);
    setSavedNote(null);
    setMcpNote(null);
    setMcpLive({});
    void refreshCatalog();
    void refreshMcpLive();
    void refreshSkills();
    if (hasDesktopApi("getAppVersion")) {
      void getDesktop()
        .getAppVersion()
        .then((r) => setAppVersion(r.version))
        .catch(() => undefined);
    }
    if (hasDesktopApi("getUpdateStatus")) {
      void getDesktop()
        .getUpdateStatus()
        .then((s) => setUpdateStatus(s))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings]);

  useEffect(() => {
    if (!savedNote) return;
    const timer = window.setTimeout(() => setSavedNote(null), 2400);
    return () => window.clearTimeout(timer);
  }, [savedNote]);

  const formFingerprint = JSON.stringify(form);
  const dirty = formFingerprint !== savedFingerprint;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      if (dirty) setClosePending(true);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, onClose, open, saving]);

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

  const requestClose = () => {
    if (saving) return;
    if (dirty) {
      setClosePending(true);
      return;
    }
    onClose();
  };

  const discardAndClose = () => {
    setClosePending(false);
    onClose();
  };

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setClosePending(false);
    setSavedNote(null);
    setLocalError(null);
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
        <div className="settings-context-limits-title">按模型覆盖上下文窗口</div>
        <p className="settings-hint">
          留空 = CPA / 内置 / 默认值；下一轮生效。
        </p>
        <div className="settings-context-limits-table-wrap">
          <table className="settings-context-limits-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>生效值</th>
                <th>覆盖</th>
              </tr>
            </thead>
            <tbody>
              {ids.length === 0 ? (
                <tr>
                  <td colSpan={3} className="settings-hint">
                    暂无模型 — 请编辑模型列表或从 CPA 同步
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
                          placeholder="自动"
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
    setClosePending(false);
    setSavedNote(null);
    setLocalError(null);
    setForm((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((r) =>
        r.id === id ? { ...r, ...patch } : r,
      ),
    }));
  }

  function addMcpRow(type: McpServerDraft["type"] = "stdio") {
    setClosePending(false);
    setSavedNote(null);
    setLocalError(null);
    setForm((prev) => ({
      ...prev,
      mcpServers: [
        ...prev.mcpServers,
        {
          id: newMcpDraftId(),
          name: "",
          type,
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
    setClosePending(false);
    setSavedNote(null);
    setLocalError(null);
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
            {live.tools.length} 个工具
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
              重连
            </button>
            <ToggleSwitch
              checked={enabled}
              label={enabled ? `停用 MCP ${row.name}` : `启用 MCP ${row.name}`}
              disabled={mcpBusy === row.name}
              onCheckedChange={(next) => void onMcpToggle(row.name.trim(), next)}
            />
          </span>
        ) : null}
      </div>
    );
  }

  function renderPermissions() {
    return (
      <div className="settings-mcp">
        <div className="settings-context-limits-title">权限规则</div>
        <p className="settings-hint">
          Claude Code 风格规则，每行一条：<code>Edit</code>、{" "}
          <code>Edit(src/**)</code>、<code>Bash(npm run *)</code>。
          允许规则命中即自动放行；拒绝规则静默拦截。
          破坏性命令与 plan 模式不受允许规则影响。
        </p>
        <label className="settings-field">
          允许规则
          <textarea
            className="settings-codearea"
            rows={3}
            placeholder={"Bash(npm test)\nEdit(src/**)"}
            value={form.permissionAllowText}
            spellCheck={false}
            onChange={(e) =>
              setField("permissionAllowText", e.target.value)
            }
          />
        </label>
        <label className="settings-field">
          拒绝规则
          <textarea
            className="settings-codearea"
            rows={2}
            placeholder={"Bash(git push *)"}
            value={form.permissionDenyText}
            spellCheck={false}
            onChange={(e) => setField("permissionDenyText", e.target.value)}
          />
        </label>
      </div>
    );
  }

  function updateAgentRow(id: string, patch: Partial<AgentDraft>) {
    setClosePending(false);
    setSavedNote(null);
    setLocalError(null);
    setForm((prev) => ({
      ...prev,
      agents: prev.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  }

  function addAgentRow() {
    setClosePending(false);
    setSavedNote(null);
    setLocalError(null);
    setForm((prev) => ({
      ...prev,
      agents: [
        ...prev.agents,
        {
          id: newAgentDraftId(),
          name: "",
          description: "",
          model: "",
          toolsCsv: "",
          prompt: "",
        },
      ],
    }));
  }

  function removeAgentRow(id: string) {
    setClosePending(false);
    setSavedNote(null);
    setLocalError(null);
    setForm((prev) => ({
      ...prev,
      agents: prev.agents.filter((a) => a.id !== id),
    }));
  }

  function renderAgents() {
    return (
      <div className="settings-mcp settings-collection">
        <div className="settings-collection-head">
          <div>
            <h3>自定义 Agents</h3>
            <p>
              为重复工作预设角色、模型、工具和系统提示词；保存后在新会话中生效。
            </p>
          </div>
          <span className="settings-count-badge">{form.agents.length}</span>
        </div>
        {form.agents.length === 0 ? (
          <div className="settings-empty-state">
            <strong>还没有自定义 Agent</strong>
            <span>可以从一个名称和任务描述开始，模型与工具均可稍后补充。</span>
          </div>
        ) : (
          form.agents.map((a, index) => (
            <section key={a.id} className="settings-config-card">
              <header className="settings-config-card-head">
                <div className="settings-config-identity">
                  <span className="settings-config-index">{index + 1}</span>
                  <span>
                    <strong>{a.name.trim() || "未命名 Agent"}</strong>
                    <small>{a.model.trim() || "继承主模型"}</small>
                  </span>
                </div>
                <button
                  type="button"
                  className="settings-card-remove"
                  title="删除 Agent"
                  onClick={() => removeAgentRow(a.id)}
                >
                  删除
                </button>
              </header>
              <div className="settings-config-grid">
                <label className="settings-field">
                  <span>名称</span>
                  <input
                    placeholder="例如 reviewer"
                    value={a.name}
                    spellCheck={false}
                    onChange={(e) => updateAgentRow(a.id, { name: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>模型（可选）</span>
                  <input
                    placeholder="留空则继承主模型"
                    value={a.model}
                    spellCheck={false}
                    onChange={(e) => updateAgentRow(a.id, { model: e.target.value })}
                  />
                </label>
                <label className="settings-field settings-config-wide">
                  <span>任务描述</span>
                  <input
                    placeholder="告诉主 Agent 什么时候应该调用它"
                    value={a.description}
                    spellCheck={false}
                    onChange={(e) =>
                      updateAgentRow(a.id, { description: e.target.value })
                    }
                  />
                </label>
                <label className="settings-field settings-config-wide">
                  <span>可用工具（可选）</span>
                  <input
                    placeholder="Read, Grep, Bash；留空则继承全部"
                    value={a.toolsCsv}
                    spellCheck={false}
                    onChange={(e) =>
                      updateAgentRow(a.id, { toolsCsv: e.target.value })
                    }
                  />
                </label>
                <label className="settings-field settings-config-wide">
                  <span>系统提示词</span>
                  <textarea
                    rows={4}
                    placeholder="定义这个 Agent 的职责、边界与输出格式"
                    value={a.prompt}
                    spellCheck={false}
                    onChange={(e) => updateAgentRow(a.id, { prompt: e.target.value })}
                  />
                </label>
              </div>
            </section>
          ))
        )}
        <div className="settings-collection-actions">
          <button type="button" className="btn btn-primary" onClick={addAgentRow}>
            添加 Agent
          </button>
        </div>
      </div>
    );
  }

  function renderSkills() {
    // Preload from an older build won't have the skills API — say so instead
    // of throwing "is not a function" at click time.
    if (!hasDesktopApi("listSkills")) {
      return (
        <div className="settings-mcp">
          <div className="settings-context-limits-title">Skills</div>
          <p className="settings-hint">
            当前运行的程序版本较旧，不包含 Skills 管理。请重启应用（开发模式请重启
            pnpm dev）后重试。
          </p>
        </div>
      );
    }
    return (
      <div className="settings-mcp">
        <div className="settings-context-limits-title">Skills</div>
        <p className="settings-hint">
          把 skill 文件夹（含 SKILL.md）放入下列目录即可安装；支持 /
          命令自动出现。删除后可点「重载」让运行中的会话立即生效。
        </p>
        <div className="settings-skills-dirs">
          <div className="settings-skills-dir">
            <span className="settings-hint">用户级（所有项目可用）</span>
            <code className="settings-skills-path">{skillsInfo?.userDir ?? "…"}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void onOpenSkillsDir("user")}
            >
              打开目录
            </button>
          </div>
          <div className="settings-skills-dir">
            <span className="settings-hint">项目级（仅当前项目）</span>
            <code className="settings-skills-path">
              {skillsInfo?.projectDir ?? "（先打开项目）"}
            </code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!skillsInfo?.projectDir}
              onClick={() => void onOpenSkillsDir("project")}
            >
              打开目录
            </button>
          </div>
        </div>
        {skillsInfo && skillsInfo.skills.length > 0 ? (
          <ul className="settings-skills-list">
            {skillsInfo.skills.map((s) => (
              <li key={`${s.scope}-${s.name}`} className="settings-skills-item">
                <span className="settings-skills-name">{s.name}</span>
                <span className="settings-hint">
                  {s.scope === "user" ? "用户" : "项目"}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm settings-mcp-remove"
                  title="删除该 skill"
                  onClick={() => void onDeleteSkill(s.name, s.scope)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-hint">尚未安装任何 skill。</p>
        )}
        <div className="settings-inline-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void refreshSkills()}
          >
            刷新列表
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!activeSessionId}
            title="让运行中的会话重新扫描 skills"
            onClick={() => void onReloadSkills()}
          >
            重载到当前会话
          </button>
        </div>
        {skillsNote ? <p className="settings-hint">{skillsNote}</p> : null}
      </div>
    );
  }

  function renderPlugins() {
    return (
      <div className="settings-mcp">
        <div className="settings-context-limits-title">本地插件</div>
        <p className="settings-hint">
          本地插件目录（每行一个）。加载其中的 skills / hooks / agents / 命令；插件自带的 MCP 服务器会被忽略（以应用内 MCP 配置为准）。新会话生效。
        </p>
        <label className="settings-field">
          插件目录
          <textarea
            className="settings-codearea"
            rows={2}
            placeholder={"插件目录路径，每行一个"}
            value={form.pluginPathsText}
            spellCheck={false}
            onChange={(e) => setField("pluginPathsText", e.target.value)}
          />
        </label>
      </div>
    );
  }

  function renderMcpServers() {
    return (
      <div className="settings-mcp settings-collection">
        <div className="settings-collection-head">
          <div>
            <h3>MCP 服务器</h3>
            <p>
              本地服务使用 stdio 命令，远程服务使用 HTTP 或 SSE 地址。保存后可应用到当前会话。
            </p>
          </div>
          <span className="settings-count-badge">{form.mcpServers.length}</span>
        </div>
        {form.mcpServers.length === 0 ? (
          <div className="settings-empty-state">
            <strong>还没有 MCP 服务器</strong>
            <span>添加本地命令，或连接一个远程 HTTP/SSE 服务。</span>
          </div>
        ) : (
          form.mcpServers.map((row, index) => (
            <section key={row.id} className="settings-config-card">
              <header className="settings-config-card-head">
                <div className="settings-config-identity">
                  <span className="settings-config-index">{index + 1}</span>
                  <span>
                    <strong>{row.name.trim() || "未命名服务器"}</strong>
                    <small>{row.type === "stdio" ? "本地命令" : `远程 ${row.type.toUpperCase()}`}</small>
                  </span>
                </div>
                <button
                  type="button"
                  className="settings-card-remove"
                  title="删除服务器"
                  onClick={() => removeMcpRow(row.id)}
                >
                  删除
                </button>
              </header>
              {renderMcpStatus(row)}
              <div className="settings-config-grid">
                <label className="settings-field">
                  <span>服务器名称</span>
                  <input
                    placeholder="例如 github"
                    value={row.name}
                    spellCheck={false}
                    onChange={(e) => updateMcpRow(row.id, { name: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>连接方式</span>
                  <select
                    className="select"
                    value={row.type}
                    onChange={(e) =>
                      updateMcpRow(row.id, {
                        type: e.target.value as McpServerDraft["type"],
                      })
                    }
                  >
                    <option value="stdio">本地命令 · stdio</option>
                    <option value="http">远程服务 · HTTP</option>
                    <option value="sse">远程服务 · SSE</option>
                  </select>
                </label>
                {row.type === "stdio" ? (
                  <>
                    <label className="settings-field">
                      <span>启动命令</span>
                      <input
                        placeholder="例如 npx"
                        value={row.command}
                        spellCheck={false}
                        onChange={(e) =>
                          updateMcpRow(row.id, { command: e.target.value })
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>命令参数</span>
                      <input
                        placeholder="例如 -y @modelcontextprotocol/server-filesystem"
                        value={row.argsText}
                        spellCheck={false}
                        onChange={(e) =>
                          updateMcpRow(row.id, { argsText: e.target.value })
                        }
                      />
                    </label>
                    <label className="settings-field settings-config-wide">
                      <span>环境变量（可选）</span>
                      <textarea
                        rows={3}
                        placeholder={"每行一个 KEY=VALUE"}
                        value={row.envText}
                        spellCheck={false}
                        onChange={(e) =>
                          updateMcpRow(row.id, { envText: e.target.value })
                        }
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="settings-field settings-config-wide">
                      <span>服务地址</span>
                      <input
                        placeholder="https://example.com/mcp"
                        value={row.url}
                        spellCheck={false}
                        onChange={(e) => updateMcpRow(row.id, { url: e.target.value })}
                      />
                    </label>
                    <label className="settings-field settings-config-wide">
                      <span>请求头（可选）</span>
                      <textarea
                        rows={3}
                        placeholder={"每行一个 KEY=VALUE，例如 Authorization=Bearer …"}
                        value={row.headersText}
                        spellCheck={false}
                        onChange={(e) =>
                          updateMcpRow(row.id, { headersText: e.target.value })
                        }
                      />
                    </label>
                  </>
                )}
              </div>
            </section>
          ))
        )}
        <div className="settings-collection-actions">
          <button type="button" className="btn btn-primary" onClick={() => addMcpRow("stdio")}>
            添加本地服务器
          </button>
          <button type="button" className="btn" onClick={() => addMcpRow("http")}>
            添加远程服务器
          </button>
          <button
            type="button"
            className="btn btn-ghost settings-mcp-test"
            disabled={mcpProbing || form.mcpServers.length === 0}
            title="启动临时会话，测试表单中的所有服务器"
            onClick={() => void onMcpProbeDraft()}
          >
            {mcpProbing ? "测试中…" : "测试连接"}
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

    const allowRules = parseRulesText(form.permissionAllowText);
    if (!allowRules.ok) {
      setLocalError(`允许规则：${allowRules.error}`);
      return;
    }
    const denyRules = parseRulesText(form.permissionDenyText);
    if (!denyRules.ok) {
      setLocalError(`拒绝规则：${denyRules.error}`);
      return;
    }

    const agentsPatch = buildAgentsPatch(form.agents);
    if (!agentsPatch.ok) {
      setLocalError(agentsPatch.error);
      return;
    }
    const pluginPaths = form.pluginPathsText
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);

    const uiFontSize = Number(form.uiFontSize);
    if (!Number.isFinite(uiFontSize) || uiFontSize < 11 || uiFontSize > 20) {
      setLocalError("全局字体大小需在 11–20 之间");
      return;
    }
    const editorFontSize = Number(form.editorFontSize);
    if (
      !Number.isFinite(editorFontSize) ||
      editorFontSize < 10 ||
      editorFontSize > 24
    ) {
      setLocalError("编辑器字体大小需在 10–24 之间");
      return;
    }

    // `effort: null` clears the override (main-side SettingsStore handles it);
    // the field sits outside AppSettings' own type on purpose.
    const patch: Omit<Partial<AppSettings>, "effort"> & {
      token?: string;
      effort?: AppSettings["effort"] | null;
    } = {
      cpaExePath: form.cpaExePath.trim(),
      cpaConfigPath: form.cpaConfigPath.trim(),
      cpaPort: port,
      models,
      defaultModel,
      shutdownCpaOnQuit: form.shutdownCpaOnQuit,
      defaultContextLimit: Math.floor(defaultContextLimit),
      modelContextLimits: patchLimits.modelContextLimits,
      mcpServers: patchMcp.mcpServers,
      permissionAllow: allowRules.rules,
      permissionDeny: denyRules.rules,
      agents: agentsPatch.agents,
      pluginPaths,
      uiFontSize: Math.round(uiFontSize * 2) / 2,
      editorFontSize: Math.round(editorFontSize * 2) / 2,
      updateFeedUrl: form.updateFeedUrl.trim() || undefined,
      locale:
        form.locale === "zh" || form.locale === "en" ? form.locale : "system",
      // null clears the override back to model default
      effort:
        form.effort === "low" ||
        form.effort === "medium" ||
        form.effort === "high"
          ? form.effort
          : null,
    };
    if (form.token.trim()) {
      patch.token = form.token.trim();
    }

    const committedForm: FormState = { ...form, token: "" };
    setSaving(true);
    try {
      await saveSettings(patch);
      setForm(committedForm);
      setSavedFingerprint(JSON.stringify(committedForm));
      setClosePending(false);
      setSavedNote("设置已保存");

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

  const pages: Array<{ key: SettingsPage; label: string; sub: string }> = [
    { key: "general", label: "通用", sub: "模型 / 语言 / 字体 / 更新" },
    { key: "room", label: "群聊设置", sub: "Mod / 选集 / 制作" },
    { key: "cpa", label: "CPA 与上下文", sub: "exe / config / 端口 / 窗口" },
    { key: "diagnostics", label: "内存诊断", sub: "进程 / 缓存 / JS 堆" },
    { key: "permissions", label: "权限规则", sub: "allow / deny" },
    { key: "agents", label: "自定义 Agents", sub: "Task 子代理" },
    {
      key: "skills",
      label: "Skills",
      sub: `${skillsInfo?.skills.length ?? 0} 个`,
    },
    { key: "plugins", label: "本地插件", sub: "plugin 目录" },
    { key: "mcp", label: "MCP 服务器", sub: `${form.mcpServers.length} 个` },
  ];
  const activePage = pages.find((p) => p.key === page) ?? pages[0];

  return (
    <div className="settings-overlay" role="presentation" onClick={requestClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        <nav className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {pages.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`settings-nav-item${page === p.key ? " active" : ""}`}
              onClick={() => setPage(p.key)}
            >
              <span className="settings-nav-label">{p.label}</span>
              <span className="settings-nav-sub">{p.sub}</span>
            </button>
          ))}
        </nav>

        <div className="settings-main">
          <header className="settings-header">
            <div>
              <h2>{activePage.label}</h2>
              <p>{activePage.sub}</p>
            </div>
            <button
              type="button"
              className="settings-close-btn"
              title="关闭设置"
              aria-label="关闭设置"
              onClick={requestClose}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </header>

          <div className="settings-body">
            {page === "general" ? (
              <>
          {/* ===== 基础：日常最常改的三件事 ===== */}
          <label className="settings-field">
            默认模型
            <input
              value={form.defaultModel}
              onChange={(e) => setField("defaultModel", e.target.value)}
              spellCheck={false}
            />
          </label>

          <label className="settings-field">
            模型列表（逗号分隔）
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
              {syncing ? "同步中…" : "从 CPA 同步模型"}
            </button>
          </div>

          <label className="settings-field">
            Effort
            <select
              className="select"
              value={form.effort}
              onChange={(e) => setField("effort", e.target.value)}
            >
              <option value="">模型默认</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            <p className="settings-hint">
              high 会先做较长推理再出字，首次响应更慢；要更快出字用 medium / low
              或「模型默认」。
            </p>
          </label>

          <label className="settings-field">
            网关 Token
            <input
              type="password"
              autoComplete="off"
              placeholder={
                settings?.hasToken
                  ? "••••••••（留空保持不变）"
                  : "CPA 网关口令"
              }
              value={form.token}
              onChange={(e) => setField("token", e.target.value)}
            />
          </label>

          <label className="settings-field">
            语言 / Language
            <select
              className="select"
              value={form.locale}
              onChange={(e) => setField("locale", e.target.value)}
            >
              <option value="system">跟随系统 / Follow system</option>
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
            <p className="settings-hint">界面语言（保存后生效）</p>
          </label>
          <label className="settings-field">
            全局字体大小
            <div className="settings-font-control">
              <input
                type="range"
                min={11}
                max={20}
                step={0.5}
                value={form.uiFontSize}
                onChange={(e) => {
                  const v = e.target.value;
                  setField("uiFontSize", v);
                  // Live preview: rem root scales the whole UI immediately
                  document.documentElement.style.setProperty(
                    "--ui-font-size",
                    `${v}px`,
                  );
                }}
              />
              <span className="settings-font-value">{form.uiFontSize}px</span>
            </div>
            <p className="settings-hint">
              侧边栏、会话、设置等界面文字（拖动即时预览，点保存写入配置）
            </p>
          </label>
          <label className="settings-field">
            编辑页字体大小
            <div className="settings-font-control">
              <input
                type="range"
                min={10}
                max={24}
                step={0.5}
                value={form.editorFontSize}
                onChange={(e) => setField("editorFontSize", e.target.value)}
              />
              <span className="settings-font-value">
                {form.editorFontSize}px
              </span>
            </div>
            <p className="settings-hint">仅代码编辑器内代码字号（保存后生效）</p>
          </label>

          <div className="settings-update">
            <div className="settings-context-limits-title">检查更新</div>
            <p className="settings-hint">
              热更新只替换程序文件，不会覆盖 CPA / 设置 / 会话。
            </p>

            {/* Status card */}
            <div className="update-card">
              <div className="update-card-icon" aria-hidden>
                {updateStatus?.state === "available" ||
                updateStatus?.state === "downloaded"
                  ? "⬆"
                  : updateStatus?.state === "error"
                    ? "!"
                    : "✓"}
              </div>
              <div className="update-card-body">
                <div className="update-card-line">
                  <span className="update-card-label">当前版本</span>
                  <span className="update-card-value mono">
                    {appVersion ? `v${appVersion}` : "开发模式"}
                  </span>
                </div>
                <div className="update-card-line">
                  <span className="update-card-label">状态</span>
                  <span
                    className={`update-card-value${
                      updateStatus?.state === "available"
                        ? " accent"
                        : updateStatus?.state === "downloaded"
                          ? " ok"
                          : updateStatus?.state === "error"
                            ? " danger"
                            : ""
                    }`}
                  >
                    {updateStatus?.state === "available"
                      ? `发现新版本 v${updateStatus.version}`
                      : updateStatus?.state === "downloaded"
                        ? `v${updateStatus.version} 已就绪`
                        : updateStatus?.state === "downloading"
                          ? `下载中 ${Math.round(updateStatus.percent)}%`
                          : updateStatus?.state === "checking"
                            ? "正在检查…"
                            : updateStatus?.state === "not-available"
                              ? `已是最新（v${updateStatus.version}）`
                              : updateStatus?.state === "error"
                                ? updateStatus.message
                                : updateStatus?.state === "disabled"
                                  ? updateStatus.message
                                  : "尚未检查"}
                  </span>
                </div>
                {updateStatus?.state === "downloading" ? (
                  <div className="update-progress">
                    <div
                      className="update-progress-fill"
                      style={{ width: `${Math.round(updateStatus.percent)}%` }}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <label className="settings-field">
              更新源
              <input
                value={form.updateFeedUrl}
                onChange={(e) => setField("updateFeedUrl", e.target.value)}
                spellCheck={false}
                placeholder="https://your-feed.example.com/（留空 = 不检查更新）"
              />
            </label>
            <div className="settings-inline-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={updateBusy}
                onClick={() => {
                  void (async () => {
                    if (!hasDesktopApi("checkForUpdate")) {
                      setLocalError("请完全重启应用后再检查更新");
                      return;
                    }
                    setLocalError(null);
                    setSavedNote(null);
                    setUpdateBusy(true);
                    try {
                      const s = await getDesktop().checkForUpdate();
                      setUpdateStatus(s);
                      if (s.state === "available") {
                        setSavedNote(`发现新版本 v${s.version}，可下载`);
                      } else if (s.state === "not-available") {
                        setSavedNote(`已是最新（v${s.version}）`);
                      } else if (s.state === "downloaded") {
                        setSavedNote(`v${s.version} 已下载，可重启安装`);
                      } else if (s.state === "disabled") {
                        setSavedNote(s.message);
                      } else if (s.state === "error") {
                        setLocalError(s.message);
                      }
                    } catch (err) {
                      setLocalError(
                        err instanceof Error ? err.message : String(err),
                      );
                    } finally {
                      setUpdateBusy(false);
                    }
                  })();
                }}
              >
                {updateBusy && updateStatus?.state !== "downloading"
                  ? "检查中…"
                  : "检查更新"}
              </button>
              {updateStatus?.state === "available" ? (
                <button
                  type="button"
                  className="btn btn-sm update-btn-primary"
                  disabled={updateBusy}
                  onClick={() => {
                    void (async () => {
                      setUpdateBusy(true);
                      try {
                        const s = await getDesktop().downloadUpdate();
                        setUpdateStatus(s);
                        if (s.state === "downloaded") {
                          setSavedNote(`v${s.version} 已下载`);
                        } else if (s.state === "error") {
                          setLocalError(s.message);
                        }
                      } finally {
                        setUpdateBusy(false);
                      }
                    })();
                  }}
                >
                  下载 v{updateStatus.version}
                </button>
              ) : null}
              {updateStatus?.state === "downloaded" ? (
                <button
                  type="button"
                  className="btn btn-sm update-btn-primary"
                  disabled={updateBusy}
                  onClick={() => {
                    void getDesktop().installUpdate();
                  }}
                >
                  重启并安装
                </button>
              ) : null}
            </div>
          </div>
              </>
            ) : null}

            {page === "room" ? <RoomModsSettings /> : null}

            {page === "cpa" ? (
              <>
              <label className="settings-field">
                CPA 可执行文件
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
                CPA 端口
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.cpaPort}
                  onChange={(e) => setField("cpaPort", e.target.value)}
                />
              </label>

              <label className="settings-field">
                默认上下文窗口（tokens）
                <input
                  type="number"
                  min={1024}
                  step={1024}
                  value={form.defaultContextLimit}
                  onChange={(e) => setField("defaultContextLimit", e.target.value)}
                />
              </label>
              <p className="settings-hint">
                模型无内置窗口时使用。默认 200000。
              </p>

              {renderContextLimitsTable()}

              <div className="settings-toggle-row">
                <div>
                  <span>退出时关闭 CPA</span>
                  <small>仅关闭由本应用启动的 CPA 进程</small>
                </div>
                <ToggleSwitch
                  checked={form.shutdownCpaOnQuit}
                  label={form.shutdownCpaOnQuit ? "停用退出时关闭 CPA" : "启用退出时关闭 CPA"}
                  onCheckedChange={(on) => setField("shutdownCpaOnQuit", on)}
                />
              </div>
            </>
          ) : null}

            {page === "diagnostics" ? (
              <Suspense fallback={<p className="settings-hint">正在加载诊断工具…</p>}>
                <MemoryDiagnostics />
              </Suspense>
            ) : null}

            {page === "permissions" ? renderPermissions() : null}

            {page === "agents" ? renderAgents() : null}

            {page === "skills" ? renderSkills() : null}

            {page === "plugins" ? renderPlugins() : null}

            {page === "mcp" ? renderMcpServers() : null}

          </div>

          <footer className={`settings-footer${closePending ? " is-confirming" : ""}`}>
            <div className="settings-save-state" role="status" aria-live="polite">
              {closePending ? (
                <span className="settings-save-warning">放弃尚未保存的更改？</span>
              ) : localError ? (
                <span className="settings-error">{localError}</span>
              ) : dirty ? (
                <span>有未保存的更改</span>
              ) : savedNote ? (
                <span className="settings-ok">✓ {savedNote}</span>
              ) : (
                <span>所有更改均已保存</span>
              )}
            </div>
            <div className="settings-footer-actions">
              {closePending ? (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setClosePending(false)}
                  >
                    继续编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={discardAndClose}
                  >
                    放弃并关闭
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-ghost" onClick={requestClose}>
                    {dirty ? "取消" : "关闭"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={saving || !dirty}
                    onClick={() => void onSave()}
                  >
                    {saving ? "保存中…" : "保存更改"}
                  </button>
                </>
              )}
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
