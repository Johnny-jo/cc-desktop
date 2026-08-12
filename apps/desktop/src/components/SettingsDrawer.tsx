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
  normalizeRuleString,
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
  /** Advanced sections start collapsed for a cleaner first look */
  const [showAdvanced, setShowAdvanced] = useState<Record<string, boolean>>({});
  const [skillsInfo, setSkillsInfo] = useState<{
    userDir: string;
    projectDir: string | null;
    skills: Array<{ name: string; scope: "user" | "project"; path: string }>;
  } | null>(null);
  const [skillsNote, setSkillsNote] = useState<string | null>(null);

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

  function toggleAdvanced(key: string) {
    setShowAdvanced((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function sectionHeader(key: string, title: string, sub: string) {
    const openNow = Boolean(showAdvanced[key]);
    return (
      <button
        type="button"
        className="settings-section"
        onClick={() => toggleAdvanced(key)}
        aria-expanded={openNow}
      >
        <span className="settings-chevron">{openNow ? "▾" : "▸"}</span>
        <span>{title}</span>
        <span className="settings-section-sub" style={{ marginLeft: "auto" }}>
          {sub}
        </span>
      </button>
    );
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
    if (!open) return;
    setForm(fromSettings(settings));
    setLocalError(null);
    setSavedNote(null);
    setMcpNote(null);
    setMcpLive({});
    void refreshCatalog();
    void refreshMcpLive();
    void refreshSkills();
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
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={mcpBusy === row.name}
              onClick={() => void onMcpToggle(row.name.trim(), !enabled)}
            >
              {enabled ? "停用" : "启用"}
            </button>
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
    setForm((prev) => ({
      ...prev,
      agents: prev.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  }

  function addAgentRow() {
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
    setForm((prev) => ({
      ...prev,
      agents: prev.agents.filter((a) => a.id !== id),
    }));
  }

  function renderAgents() {
    return (
      <div className="settings-mcp">
        <div className="settings-context-limits-title">自定义 Agents</div>
        <p className="settings-hint">
          Task/Agent 工具可按名称调用的子代理。工具留空 = 继承全部；模型留空 = 主模型。新会话生效。
        </p>
        {form.agents.length === 0 ? (
          <p className="settings-hint">暂无自定义 Agent。</p>
        ) : (
          form.agents.map((a) => (
            <div key={a.id} className="settings-mcp-row">
              <div className="settings-mcp-row-head">
                <input
                  className="settings-mcp-name"
                  placeholder="名称"
                  value={a.name}
                  spellCheck={false}
                  onChange={(e) => updateAgentRow(a.id, { name: e.target.value })}
                />
                <input
                  placeholder="模型（可选）"
                  value={a.model}
                  spellCheck={false}
                  onChange={(e) => updateAgentRow(a.id, { model: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm settings-mcp-remove"
                  title="删除 agent"
                  onClick={() => removeAgentRow(a.id)}
                >
                  ×
                </button>
              </div>
              <input
                placeholder="描述（何时使用此 agent）"
                value={a.description}
                spellCheck={false}
                onChange={(e) =>
                  updateAgentRow(a.id, { description: e.target.value })
                }
              />
              <input
                placeholder="工具（逗号分隔，可选）"
                value={a.toolsCsv}
                spellCheck={false}
                onChange={(e) =>
                  updateAgentRow(a.id, { toolsCsv: e.target.value })
                }
              />
              <textarea
                rows={3}
                placeholder="系统提示词"
                value={a.prompt}
                spellCheck={false}
                onChange={(e) => updateAgentRow(a.id, { prompt: e.target.value })}
              />
            </div>
          ))
        )}
        <div className="settings-inline-actions">
          <button type="button" className="btn btn-sm" onClick={addAgentRow}>
            + 添加 Agent
          </button>
        </div>
      </div>
    );
  }

  function renderSkills() {
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
      <div className="settings-mcp">
        <div className="settings-context-limits-title">MCP 服务器</div>
        <p className="settings-hint">
          stdio 运行本地命令；sse/http 连接 URL。env / headers：每行一个 KEY=VALUE。新会话生效；仅加载此处配置（项目的 .mcp.json 与用户级 MCP 设置会被忽略）。
        </p>
        {form.mcpServers.length === 0 ? (
          <p className="settings-hint">尚未配置 MCP 服务器。</p>
        ) : (
          form.mcpServers.map((row) => (
            <div key={row.id} className="settings-mcp-row">
              <div className="settings-mcp-row-head">
                <input
                  className="settings-mcp-name"
                  placeholder="名称"
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
                  title="删除服务器"
                  onClick={() => removeMcpRow(row.id)}
                >
                  ×
                </button>
              </div>
              {renderMcpStatus(row)}
              {row.type === "stdio" ? (
                <>
                  <input
                    placeholder="命令（如 node）"
                    value={row.command}
                    spellCheck={false}
                    onChange={(e) =>
                      updateMcpRow(row.id, { command: e.target.value })
                    }
                  />
                  <input
                    placeholder="参数（空格分隔）"
                    value={row.argsText}
                    spellCheck={false}
                    onChange={(e) =>
                      updateMcpRow(row.id, { argsText: e.target.value })
                    }
                  />
                  <textarea
                    rows={2}
                    placeholder={"env（每行 KEY=VALUE，可选）"}
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
                    placeholder={"headers（每行 KEY=VALUE，可选）"}
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
            + 添加 MCP 服务器
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
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
          <h2>设置</h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings-body">
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

          {/* ===== 高级：CPA 路径与上下文 ===== */}
          {sectionHeader("advanced-cpa", "高级 · CPA 与上下文", "exe / config / 端口 / 窗口")}
          {showAdvanced["advanced-cpa"] ? (
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

              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={form.shutdownCpaOnQuit}
                  onChange={(e) => setField("shutdownCpaOnQuit", e.target.checked)}
                />
                退出时关闭 CPA（仅限本应用启动的）
              </label>
            </>
          ) : null}

          {/* ===== 权限 ===== */}
          {sectionHeader("permissions", "权限规则", "allow / deny")}
          {showAdvanced["permissions"] ? renderPermissions() : null}

          {/* ===== Agents ===== */}
          {sectionHeader("agents", "自定义 Agents", "Task 子代理")}
          {showAdvanced["agents"] ? renderAgents() : null}

          {/* ===== Skills ===== */}
          {sectionHeader(
            "skills",
            "Skills",
            `${skillsInfo?.skills.length ?? 0} 个`,
          )}
          {showAdvanced["skills"] ? renderSkills() : null}

          {/* ===== 插件 ===== */}
          {sectionHeader("plugins", "本地插件", "plugin 目录")}
          {showAdvanced["plugins"] ? renderPlugins() : null}

          {/* ===== MCP ===== */}
          {sectionHeader("mcp", "MCP 服务器", `${form.mcpServers.length} 个`)}
          {showAdvanced["mcp"] ? renderMcpServers() : null}

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
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
