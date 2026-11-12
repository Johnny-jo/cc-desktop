import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  McpServersMap,
  PlaywrightConnection,
  ModelInfo,
  PublicSettings,
  SessionMcpServerStatus,
  UpdateStatusDto,
  BrowserExtensionSetupStatus,
  BrowserAuthorizationStatus,
} from "@claude-desktop/shared";
import {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  buildModelContextLimitsPatch,
  normalizeRuleString,
  resolveContextLimit,
} from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import { useI18n } from "../i18n/useI18n";
import {
  getState,
  saveSettings,
  syncCpaModels,
  useAppStore,
} from "../state/store";
import { RoomModsSettings } from "./settings/RoomModsSettings";
import { ThemedSelect } from "./Select";
import { ToggleSwitch } from "./ToggleSwitch";
import { buildMcpServersPatch, controlTarget, mcpServersToDrafts, newMcpRow, setControlEnabled, type ControlTarget, type McpServerDraft } from "./settings/mcp-form";
import { ControlSettings } from "./settings/ControlSettings";
import { ProviderSettings } from "./ProviderSettings";
import { ProviderDashboard } from "./ProviderDashboard";
import { useModelDisplay } from "../hooks/useModelDisplay";
import { mergeModelSettingsDraft, subscribeProviderModelUpdates, type ModelSettingsDraft } from "../lib/model-catalog-updates";
export { buildMcpServersPatch, mcpServersToDrafts, setControlEnabled, suggestMcpServerName } from "./settings/mcp-form";

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
  | "context"
  | "diagnostics"
  | "permissions"
  | "agents"
  | "skills"
  | "plugins"
  | "control"
  | "mcp"
  | "providers";

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
  modelsCsv: string;
  defaultModel: string;
  defaultContextLimit: string;
  outputMode: "standard" | "balanced";
  summaryModel: string;
  compactPercent: string;
  /** modelId → override 字符串；缺省或 "" = auto */
  modelContextLimitDraft: Record<string, string>;
  mcpServers: McpServerDraft[];
  /** Claude Code-style rules, one per line: Edit / Edit(src/**) / Bash(npm *) */
  permissionAllowText: string;
  permissionDenyText: string;
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

const mcpServerLabels: Record<McpServerDraft["type"], string> = {
  "windows-computer": "Windows 桌面控制",
  playwright: "浏览器配置",
  stdio: "本地命令",
  http: "远程 HTTP",
  sse: "远程 SSE",
};

function parseModelIds(modelsCsv: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of modelsCsv.split(",")) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function fromSettings(s: PublicSettings | null): FormState {
  const draft: Record<string, string> = {};
  for (const [k, v] of Object.entries(s?.modelContextLimits ?? {})) {
    draft[k] = String(v);
  }
  return {
    modelsCsv: (s?.models ?? []).join(", "),
    defaultModel: s?.defaultModel ?? "",
    defaultContextLimit: String(s?.defaultContextLimit ?? 200_000),
    outputMode: s?.tokenSavings?.mode ?? "balanced",
    summaryModel: s?.tokenSavings?.summaryModel ?? "",
    compactPercent: String(Math.round((s?.tokenSavings?.autoCompactRatio ?? 0.75) * 100)),
    modelContextLimitDraft: draft,
    mcpServers: mcpServersToDrafts(s?.mcpServers, s?.disabledControlServers),
    permissionAllowText: (s?.permissionAllow ?? []).join("\n"),
    permissionDenyText: (s?.permissionDeny ?? []).join("\n"),
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

type BrowserAuthorizationDraft = {
  busy?: boolean; status?: BrowserAuthorizationStatus; token?: string; error?: string;
};
type ServerPage = "control" | "mcp";
type ServerNotes = Partial<Record<ServerPage, string>>;

export function mergeBrowserAuthorizationStatus(current: BrowserAuthorizationDraft | undefined, status: BrowserAuthorizationStatus): BrowserAuthorizationDraft {
  const sameProfile = current?.status?.browser === status.browser &&
    current.status.profileName.toLowerCase() === status.profileName.toLowerCase();
  return { ...current, status, token: sameProfile ? current.token : "", error: undefined };
}

function browserErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const { t } = useI18n();
  const settings = useAppStore((s) => s.settings);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessionStatus = useAppStore((s) =>
    s.activeSessionId
      ? s.sessions.find((x) => x.id === s.activeSessionId)?.status
      : undefined,
  );
  const [form, setForm] = useState<FormState>(() => fromSettings(settings));
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const modelLabel = useModelDisplay();
  const [modelDraft, setModelDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingGalaxyEffects, setSavingGalaxyEffects] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /** Live MCP status by server name (from running session or probe) */
  const [mcpLive, setMcpLive] = useState<Record<string, SessionMcpServerStatus & { probe?: boolean }>>({});
  const [probingTarget, setProbingTarget] = useState<ControlTarget | "mcp" | null>(null);
  const probeInFlight = useRef(false);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [mcpNotes, setMcpNotes] = useState<ServerNotes>({});
  const [expandedControl, setExpandedControl] = useState<ControlTarget | null>(null);
  const statusEpoch = useRef(0);
  const [browserSetup, setBrowserSetup] = useState<Record<string, { busy: boolean; status?: BrowserExtensionSetupStatus; error?: string }>>({});
  const [browserAuthorization, setBrowserAuthorization] = useState<Record<string, BrowserAuthorizationDraft>>({});
  /** IDEA 风格左侧导航当前页 */
  const [page, setPage] = useState<SettingsPage>("general");
  useEffect(() => {
    if (!open || page !== "control" || !hasDesktopApi("getBrowserExtensionStatus")) return;
    const pending = form.mcpServers.filter(row => row.type === "playwright" &&
      controlTarget(row) === expandedControl && (row.connection ?? "extension") === "extension" &&
      browserSetup[browserSetupKey(row)]?.status?.state !== "ready" &&
      browserSetup[browserSetupKey(row)]?.status && !browserSetup[browserSetupKey(row)]?.busy &&
      !browserSetup[browserSetupKey(row)]?.error);
    if (!pending.length) return;
    let stopped = false;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void Promise.all(pending.map(async row => {
        const key = browserSetupKey(row);
        try {
          const status = await getDesktop().getBrowserExtensionStatus({ browser: row.browser ?? "msedge", profile: row.profile?.trim() || undefined });
          if (!stopped) setBrowserSetup(current => JSON.stringify(current[key]?.status) === JSON.stringify(status)
            ? current : { ...current, [key]: { busy: false, status } });
        } catch (error) {
          if (!stopped) setBrowserSetup(current => ({ ...current, [key]: { busy: false, error: browserErrorText(error) } }));
        }
      })).finally(() => { checking = false; });
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [open, page, expandedControl, form.mcpServers, browserSetup]);
  useEffect(() => {
    if (!open || page !== "control" || !hasDesktopApi("getBrowserAuthorizationStatus")) return;
    let stopped = false;
    for (const row of form.mcpServers) {
      if (controlTarget(row) !== expandedControl || row.type !== "playwright" || (row.connection ?? "extension") !== "extension") continue;
      const key = browserSetupKey(row);
      void getDesktop().getBrowserAuthorizationStatus({ browser: row.browser ?? "msedge", profile: row.profile?.trim() || undefined })
        .then(status => {
          if (!stopped) setBrowserAuthorization(current => ({ ...current, [key]: mergeBrowserAuthorizationStatus(current[key], status) }));
        }).catch(error => {
          if (!stopped) setBrowserAuthorization(current => ({ ...current, [key]: { ...current[key], error: browserErrorText(error) } }));
        });
    }
    return () => { stopped = true; };
  }, [open, page, expandedControl, form.mcpServers]);
  useEffect(() => {
    if (!open) setBrowserAuthorization(current => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, { ...value, token: "" }])));
  }, [open]);
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
  const syncedModelsRef = useRef<ModelSettingsDraft | null>(null);
  const catalogEpoch = useRef(0);

  const [savingPhotoFlow, setSavingPhotoFlow] = useState(false);
  async function onPhotoFlowChange(enabled: boolean) {
    setLocalError(null);
    setSavedNote(null);
    setSavingPhotoFlow(true);
    try {
      await saveSettings({ photoFlowEnabled: enabled });
      setSavedNote(t.settings.saved);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally { setSavingPhotoFlow(false); }
  }

  async function onGalaxyEffectsChange(enabled: boolean) {
    setLocalError(null);
    setSavedNote(null);
    setSavingGalaxyEffects(true);
    try {
      // Keep this immediate preference separate from the unsaved settings draft.
      await saveSettings({ galaxyEffectsEnabled: enabled });
      setSavedNote(t.settings.saved);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingGalaxyEffects(false);
    }
  }

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
    const epoch = ++catalogEpoch.current;
    try {
      const desktop = getDesktop();
      const list = await desktop.getModelCatalog();
      if (epoch === catalogEpoch.current) setCatalog(Array.isArray(list) ? list : []);
    } catch {
      if (epoch === catalogEpoch.current) setCatalog([]);
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
      statusEpoch.current++;
      openedRef.current = false;
      syncedModelsRef.current = null;
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
    syncedModelsRef.current = { modelsCsv: initialForm.modelsCsv, defaultModel: initialForm.defaultModel };
    setModelDraft("");
    setSavedFingerprint(JSON.stringify(initialForm));
    setClosePending(false);
    setLocalError(null);
    setSavedNote(null);
    setMcpNotes({});
    setExpandedControl(null);
    setBrowserSetup({});
    setBrowserAuthorization({});
    setMcpLive({});
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
    if (!open || !settings) return;
    const next = { modelsCsv: settings.models.join(", "), defaultModel: settings.defaultModel };
    const previous = syncedModelsRef.current;
    syncedModelsRef.current = next;
    if (!previous || (previous.modelsCsv === next.modelsCsv && previous.defaultModel === next.defaultModel)) return;
    setForm(current => mergeModelSettingsDraft(current, previous, next));
    // Rebase only the synced fields. Other unsaved preferences remain dirty.
    setSavedFingerprint(current => JSON.stringify({ ...JSON.parse(current), ...next }));
  }, [open, settings?.models, settings?.defaultModel]);

  useEffect(() => {
    if (!open) return;
    void refreshCatalog();
    const unsubscribe = subscribeProviderModelUpdates(getDesktop(), refreshCatalog);
    return () => { catalogEpoch.current++; unsubscribe?.(); };
  }, [open]);

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

  function setServerNote(page: ServerPage, message?: string) {
    setMcpNotes(current => ({ ...current, [page]: message }));
  }

  async function refreshMcpLive() {
    if (!activeSessionId) return;
    const epoch = statusEpoch.current;
    try {
      const res = await getDesktop().getSessionMcpStatus(activeSessionId);
      if (epoch === statusEpoch.current) {
        setMcpLive(Object.fromEntries((res?.statuses ?? []).map(status => [status.name, status])));
      }
    } catch {
      // A previous session may already have released its SDK query.
    }
  }

  async function changeSessionServer(row: McpServerDraft, enabled?: boolean) {
    if (!activeSessionId) return;
    const page = controlTarget(row) ? "control" : "mcp";
    const name = row.name.trim();
    setMcpBusy(name);
    setServerNote(page);
    try {
      const api = getDesktop();
      const result = enabled === undefined
        ? await api.reconnectSessionMcpServer(activeSessionId, name)
        : await api.toggleSessionMcpServer(activeSessionId, name, enabled);
      if (!result.ok) setServerNote(page, `${name}：${result.error ?? "操作失败"}`);
      await refreshMcpLive();
    } catch (error) {
      setServerNote(page, browserErrorText(error));
    } finally {
      setMcpBusy(null);
    }
  }

  function showMcpError(result: { error: string; row: string }) {
    const row = form.mcpServers.find(draft => draft.id === result.row);
    const target = row && controlTarget(row);
    setPage(target ? "control" : "mcp");
    if (target) setExpandedControl(target);
    setLocalError(result.error);
  }

  async function onMcpProbeDraft(rows: McpServerDraft[], page: ServerPage) {
    if (probeInFlight.current) return;
    setServerNote(page);
    setLocalError(null);
    const patch = buildMcpServersPatch(rows);
    if (!patch.ok) return showMcpError(patch);
    const names = Object.keys(patch.mcpServers);
    if (!names.length) {
      setServerNote(page, "请先填写要测试的配置。");
      return;
    }
    const epoch = ++statusEpoch.current;
    probeInFlight.current = true;
    setProbingTarget(controlTarget(rows[0]) ?? "mcp");
    try {
      const res = await getDesktop().probeMcpServers(patch.mcpServers);
      if (epoch !== statusEpoch.current) return;
      const requested = new Set(names);
      const statuses = res.statuses.filter(status => requested.has(status.name));
      setMcpLive(current => {
        const next = { ...current };
        for (const name of names) delete next[name];
        for (const status of statuses) next[status.name] = { ...status, probe: true };
        return next;
      });
      const passed = statuses.filter(status => status.status === "connected").length;
      setServerNote(page, `测试通过 ${passed} / ${names.length} · ${names.join("、")}`);
    } catch (error) {
      if (epoch === statusEpoch.current) setServerNote(page, browserErrorText(error));
    } finally {
      probeInFlight.current = false;
      setProbingTarget(null);
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

  const configuredModelIds = parseModelIds(form.modelsCsv);
  const customServers = form.mcpServers.filter(row => !controlTarget(row));
  const defaultModelOptions = [
    {
      value: "",
      label: configuredModelIds.length ? "选择默认模型…" : "请先添加模型",
    },
    ...configuredModelIds.map((id) => ({ value: id, label: modelLabel(id), title: id })),
  ];
  const modelSuggestions = catalog.filter(
    (model) => !configuredModelIds.includes(model.id),
  );

  function updateModelList(nextIds: string[]) {
    const ids = parseModelIds(nextIds.join(","));
    setClosePending(false);
    setSavedNote(null);
    setLocalError(null);
    setForm((prev) => {
      const currentDefault = prev.defaultModel.trim();
      const defaultModel = ids.includes(currentDefault)
        ? currentDefault
        : ids[0] ?? "";
      return {
        ...prev,
        modelsCsv: ids.join(", "),
        defaultModel,
      };
    });
  }

  function addModel() {
    const id = modelDraft.trim();
    if (!id || configuredModelIds.includes(id)) return;
    updateModelList([...configuredModelIds, id]);
    setModelDraft("");
  }

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
          留空使用 Provider 同步值、内置窗口或默认值；下一轮生效。
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
                    暂无模型，请添加模型服务账号后同步模型。
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
                      <td className="settings-context-limits-model" title={id}>{modelLabel(id)}</td>
                      <td>
                        <span className="settings-context-limits-effective">
                          {limitTokens}
                        </span>{" "}
                        <span
                          className={`settings-context-limits-source source-${source}`}
                        >
                          {source === "cpa" ? "Provider" : source}
                        </span>
                      </td>
                      <td>
                        <input
                          type="number"
                          min={CONTEXT_LIMIT_MIN}
                          step={1}
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

  function editServerRows(
    change: (rows: McpServerDraft[]) => McpServerDraft[],
    page: ServerPage,
    affected: McpServerDraft[] = [],
  ) {
    statusEpoch.current++;
    setServerNote(page);
    setMcpLive(current => {
      const next = { ...current };
      for (const row of affected) delete next[row.name.trim()];
      return next;
    });
    setClosePending(false);
    setSavedNote(null);
    setLocalError(null);
    setForm(prev => ({ ...prev, mcpServers: change(prev.mcpServers) }));
  }

  function updateMcpRow(row: McpServerDraft, patch: Partial<McpServerDraft>) {
    editServerRows(rows => rows.map(r => r.id === row.id ? { ...r, ...patch } : r),
      controlTarget(row) ? "control" : "mcp", [row]);
  }

  function browserSetupKey(row: McpServerDraft): string {
    return `${row.id}:${row.browser ?? "msedge"}:${row.profile?.trim() ?? ""}`;
  }

  async function checkBrowserSetup(row: McpServerDraft, install: boolean) {
    const key = browserSetupKey(row);
    setBrowserSetup(current => ({ ...current, [key]: { ...current[key], busy: true, error: undefined } }));
    try {
      const request = { browser: row.browser ?? "msedge", profile: row.profile?.trim() || undefined };
      const api = getDesktop();
      if (!hasDesktopApi(install ? "setupBrowserExtension" : "getBrowserExtensionStatus")) {
        throw new Error("请重启应用以使用浏览器自动安装功能。");
      }
      const status = await (install ? api.setupBrowserExtension(request) : api.getBrowserExtensionStatus(request));
      setBrowserSetup(current => ({ ...current, [key]: { busy: false, status } }));
      if (hasDesktopApi("getBrowserAuthorizationStatus")) {
        const authorization = await api.getBrowserAuthorizationStatus({ browser: request.browser, profile: status.profileName });
        setBrowserAuthorization(current => ({ ...current, [key]: mergeBrowserAuthorizationStatus(current[key], authorization) }));
      }
    } catch (error) {
      setBrowserSetup(current => ({ ...current, [key]: { busy: false, error: browserErrorText(error) } }));
    }
  }

  async function updateBrowserAuthorization(row: McpServerDraft, clear = false) {
    const key = browserSetupKey(row);
    const token = browserAuthorization[key]?.token ?? "";
    setBrowserAuthorization(current => ({ ...current, [key]: { ...current[key], busy: true, error: undefined } }));
    try {
      const api = getDesktop();
      if (!hasDesktopApi(clear ? "clearBrowserAuthorization" : "saveBrowserAuthorization")) {
        throw new Error("请重启应用以使用连接授权配置功能。");
      }
      const selected = browserAuthorization[key]?.status;
      if (!selected) throw new Error("请先刷新状态，确认要配置的浏览器目录。");
      const request = { browser: selected.browser, profile: selected.profileName };
      const status = await (clear ? api.clearBrowserAuthorization(request) : api.saveBrowserAuthorization({ ...request, token }));
      setBrowserAuthorization(current => ({ ...current, [key]: { busy: false, status, token: "" } }));
    } catch (error) {
      setBrowserAuthorization(current => ({ ...current, [key]: { ...current[key], busy: false, error: browserErrorText(error) } }));
    }
  }

  function addMcpRow(type: "stdio" | "http") {
    editServerRows(rows => [...rows, newMcpRow(rows, type)], "mcp");
  }

  function removeMcpRow(row: McpServerDraft) {
    editServerRows(rows => rows.filter(r => r.id !== row.id), controlTarget(row) ? "control" : "mcp", [row]);
  }

  function renderMcpStatus(row: McpServerDraft) {
    const live = mcpLive[row.name.trim()];
    if (!live) return null;
    const setupError = row.type === "playwright" && (row.connection ?? "extension") === "extension"
      ? browserSetup[browserSetupKey(row)]?.error ?? browserAuthorization[browserSetupKey(row)]?.error : undefined;
    const error = /connection closed/i.test(live.error ?? "") ? setupError ?? live.error : live.error;
    const enabled = live.status !== "disabled";
    return (
      <div className="settings-mcp-status">
        <span className={`mcp-badge mcp-badge-${live.status}`}>
          {live.probe && live.status === "connected" ? "测试通过" : live.status}
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
        {error ? (
          <span className="settings-mcp-error" title={error}>
            {error}
          </span>
        ) : null}
        {activeSessionId && !live.probe && sessionStatus !== "running" ? (
          <span className="settings-mcp-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={mcpBusy === row.name}
              onClick={() => void changeSessionServer(row)}
            >
              重连
            </button>
            <ToggleSwitch
              checked={enabled}
              label={enabled ? `停用 MCP ${row.name}` : `启用 MCP ${row.name}`}
              disabled={mcpBusy === row.name}
              onCheckedChange={(next) => void changeSessionServer(row, next)}
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

  function renderMcpRow(row: McpServerDraft, index: number) {
    const target = controlTarget(row);
    return (
      <section key={row.id} className="settings-config-card">
        <header className="settings-config-card-head">
          <div className="settings-config-identity">
            {!target && <span className="settings-config-index">{index + 1}</span>}
            <span>
              <strong>{row.name.trim() || "未命名服务器"}</strong>
              <small>{mcpServerLabels[row.type]}</small>
            </span>
          </div>
          <button
            type="button"
            className="settings-card-remove"
            title={target ? "删除配置" : "删除服务器"}
            onClick={() => removeMcpRow(row)}
          >
            删除
          </button>
        </header>
        {!row.disabled && renderMcpStatus(row)}
        <div className="settings-config-grid">
          <label className="settings-field">
            <span>{target ? "配置名称" : "服务器名称"}</span>
            <input
              placeholder={target ? "例如 work" : "例如 github"}
              value={row.name}
              spellCheck={false}
              onChange={(e) => updateMcpRow(row, { name: e.target.value })}
            />
          </label>
          {!target && (
            <label className="settings-field">
              <span>连接方式</span>
              <ThemedSelect variant="settings" ariaLabel="连接方式" value={row.type}
                onChange={value => updateMcpRow(row, { type: value as McpServerDraft["type"] })}
                options={[
                  { value: "stdio", label: "本地命令 · stdio" },
                  { value: "http", label: "远程服务 · HTTP" },
                  { value: "sse", label: "远程服务 · SSE" },
                ]} />
            </label>
          )}
          {row.type === "playwright" ? (
            <>
              <label className="settings-field">
                <span>浏览器模式</span>
                <ThemedSelect variant="settings" ariaLabel="浏览器模式" value={row.connection ?? "extension"}
                  onChange={value => updateMcpRow(row, { connection: value as PlaywrightConnection })}
                  options={[
                    { value: "extension", label: "日常浏览器（复用登录状态）" },
                    { value: "isolated", label: "独立窗口" },
                    { value: "cdp", label: "连接已有浏览器（CDP）" },
                  ]} />
                <small>{(row.connection ?? "extension") === "extension"
                  ? "连接你日常使用的浏览器，复用登录状态。首次连接时，扩展会请你选择共享的标签页，这是正常步骤。"
                  : row.connection === "cdp" ? "连接已开启远程调试的浏览器，使用其中已有的页面与登录状态。断开控制会保留浏览器。"
                    : "每个会话打开独立窗口，使用独立的登录状态。"}</small>
              </label>
              {row.connection === "cdp" ? <label className="settings-field settings-config-wide">
                <span>CDP 连接地址</span>
                <input aria-label="CDP 连接地址" placeholder="http://127.0.0.1:9222"
                  value={row.cdpEndpoint ?? ""} maxLength={2048} spellCheck={false}
                  onChange={e => updateMcpRow(row, { cdpEndpoint: e.target.value })} />
                <small>支持 HTTP(S) 调试地址或 WS(S) 浏览器连接地址。</small>
              </label> : <label className="settings-field settings-config-wide">
                <span>日常浏览器配置目录（可选）</span>
                <input placeholder="例如 Profile 2（留空使用最近使用的配置）"
                  value={row.profile ?? ""} maxLength={80} spellCheck={false}
                  onChange={(e) => updateMcpRow(row, { profile: e.target.value })} />
                <small>填写配置目录名称，无需完整路径。历史和书签查询只读此配置；日常模式也连接此配置中的浏览器。</small>
              </label>}
              {(row.connection ?? "extension") === "extension" ? (
                <div className="settings-config-wide">
                  <p className="settings-hint">首次连接会自动准备浏览器扩展。浏览器要求确认启用时，在提示中确认即可。</p>
                  <div className="settings-collection-actions">
                    <button type="button" className="btn btn-ghost btn-sm"
                      disabled={browserSetup[browserSetupKey(row)]?.busy}
                      onClick={() => void checkBrowserSetup(row, true)}>
                      {browserSetup[browserSetupKey(row)]?.busy ? "正在检测…" : "自动安装并检测"}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm"
                      disabled={browserSetup[browserSetupKey(row)]?.busy}
                      onClick={() => void checkBrowserSetup(row, false)}>刷新状态</button>
                  </div>
                  <p className="settings-hint" role="status">
                    {browserSetup[browserSetupKey(row)]?.error ?? browserSetup[browserSetupKey(row)]?.status?.message}
                  </p>
                  <label>
                    <span>连接授权</span>
                    <input type="password" autoComplete="off" spellCheck={false}
                      placeholder="粘贴扩展授权页的连接令牌"
                      value={browserAuthorization[browserSetupKey(row)]?.token ?? ""}
                      disabled={browserAuthorization[browserSetupKey(row)]?.busy}
                      onChange={event => {
                        const key = browserSetupKey(row);
                        const token = event.target.value;
                        setBrowserAuthorization(current => ({ ...current, [key]: { ...current[key], token, error: undefined } }));
                      }} />
                  </label>
                  <div className="settings-collection-actions">
                    <button type="button" className="btn btn-ghost btn-sm"
                      disabled={browserAuthorization[browserSetupKey(row)]?.busy || !browserAuthorization[browserSetupKey(row)]?.status || !browserAuthorization[browserSetupKey(row)]?.token?.trim()}
                      onClick={() => void updateBrowserAuthorization(row)}>保存连接授权</button>
                    <button type="button" className="btn btn-ghost btn-sm"
                      disabled={browserAuthorization[browserSetupKey(row)]?.busy || !browserAuthorization[browserSetupKey(row)]?.status?.configured}
                      onClick={() => void updateBrowserAuthorization(row, true)}>清除授权</button>
                  </div>
                  <p className="settings-hint" role="status">
                    {browserAuthorization[browserSetupKey(row)]?.error ?? (browserAuthorization[browserSetupKey(row)]?.status?.configured
                      ? `已为 ${browserAuthorization[browserSetupKey(row)]?.status?.profileName} 加密保存授权，下次连接自动使用。`
                      : browserAuthorization[browserSetupKey(row)]?.status
                        ? `当前配置：${browserAuthorization[browserSetupKey(row)]?.status?.profileName}。保存一次后即可自动连接，重置令牌后请重新保存。`
                        : "正在检测授权配置，请稍候；检测失败时可刷新状态。")}
                  </p>
                </div>
              ) : null}
            </>
          ) : row.type === "windows-computer" ? null : row.type === "stdio" ? (
            <>
              <label className="settings-field">
                <span>启动命令</span>
                <input
                  placeholder="例如 npx"
                  value={row.command}
                  spellCheck={false}
                  onChange={(e) =>
                    updateMcpRow(row, { command: e.target.value })
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
                    updateMcpRow(row, { argsText: e.target.value })
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
                    updateMcpRow(row, { envText: e.target.value })
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
                  onChange={(e) => updateMcpRow(row, { url: e.target.value })}
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
                    updateMcpRow(row, { headersText: e.target.value })
                  }
                />
              </label>
            </>
          )}
        </div>
      </section>
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
          <span className="settings-count-badge">{customServers.length}</span>
        </div>
        {customServers.length === 0 ? (
          <div className="settings-empty-state">
            <strong>还没有 MCP 服务器</strong>
            <span>添加本地命令，或连接一个远程 HTTP/SSE 服务。</span>
          </div>
        ) : (
          customServers.map(renderMcpRow)
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
            disabled={probingTarget !== null || customServers.length === 0}
            title="测试此页的自定义服务器"
            onClick={() => void onMcpProbeDraft(customServers, "mcp")}
          >
            {probingTarget === "mcp" ? "测试中…" : "测试连接"}
          </button>
        </div>
        {mcpNotes.mcp && <p className="settings-hint" role="status">{mcpNotes.mcp}</p>}
      </div>
    );
  }

  const onSave = async () => {
    setLocalError(null);
    setSavedNote(null);
    const models = form.modelsCsv
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const defaultModel = form.defaultModel.trim() || models[0] || "";
    if (defaultModel && !models.includes(defaultModel)) {
      models.unshift(defaultModel);
    }
    const defaultContextLimit = Number(form.defaultContextLimit);
    if (
      !Number.isInteger(defaultContextLimit) ||
      defaultContextLimit < CONTEXT_LIMIT_MIN ||
      defaultContextLimit > CONTEXT_LIMIT_MAX
    ) {
      setLocalError(
        `默认上下文窗口必须是 ${CONTEXT_LIMIT_MIN} 到 ${CONTEXT_LIMIT_MAX} 之间的整数`,
      );
      return;
    }

    const visibleIds = visibleModelIds(form.modelsCsv, catalog);
    const compactPercent = Number(form.compactPercent);
    if (!Number.isInteger(compactPercent) || compactPercent < 50 || compactPercent > 95) {
      setLocalError("自动压缩阈值需为 50 到 95 之间的整数");
      return;
    }
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
      showMcpError(patchMcp);
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
      effort?: AppSettings["effort"] | null;
    } = {
      models,
      defaultModel,
      defaultContextLimit,
      modelContextLimits: patchLimits.modelContextLimits,
      tokenSavings: {
        mode: form.outputMode,
        ...(form.summaryModel ? { summaryModel: form.summaryModel } : {}),
        ...(compactPercent === 75 ? {} : { autoCompactRatio: compactPercent / 100 }),
      },
      mcpServers: patchMcp.mcpServers,
      disabledControlServers: patchMcp.disabledControlServers,
      permissionAllow: allowRules.rules,
      permissionDeny: denyRules.rules,
      agents: agentsPatch.agents,
      pluginPaths,
      uiFontSize: Math.round(uiFontSize * 2) / 2,
      editorFontSize: Math.round(editorFontSize * 2) / 2,
      updateFeedUrl: form.updateFeedUrl.trim() || undefined,
      locale:
        form.locale === "zh" || form.locale === "en" ? form.locale : "system",
      // Effort is no longer configurable here; clear any legacy override.
      effort: null,
    };
    const committedForm: FormState = { ...form };
    setSaving(true);
    try {
      await saveSettings(patch);
      setForm(current => current === form ? committedForm : current);
      setSavedFingerprint(JSON.stringify(committedForm));
      setClosePending(false);
      setSavedNote("设置已保存");

      const previous = buildMcpServersPatch(mcpServersToDrafts(settings?.mcpServers));
      const before = previous.ok ? previous.mcpServers : settings?.mcpServers ?? {};
      const after = patchMcp.mcpServers;
      const scope = (config?: McpServersMap[string]): ServerPage =>
        config?.type === "playwright" || config?.type === "windows-computer" ? "control" : "mcp";
      const changedPages = new Set<ServerPage>();
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[name]) === JSON.stringify(after[name])) continue;
        if (before[name]) changedPages.add(scope(before[name]));
        if (after[name]) changedPages.add(scope(after[name]));
      }
      if (changedPages.size && activeSessionId) {
        try {
          const res = await getDesktop().setSessionMcpServers(activeSessionId, after);
          const errors = Object.entries(res.result?.errors ?? {});
          for (const page of new Set([...changedPages, ...errors.map(([name]) => scope(after[name] ?? before[name]))])) {
            const details = errors.filter(([name]) => scope(after[name] ?? before[name]) === page)
              .map(([name, reason]) => `${name}：${reason}`).join(" · ");
            const failed = !res.ok && res.error !== "No live session query";
            if (failed) setServerNote(page, `设置已保存，当前会话应用失败：${res.error ?? "未知错误"}`);
            else if (details) setServerNote(page, `设置已保存，连接失败：${details}`);
            else setServerNote(page, res.ok ? "已应用到当前会话" : "下次启动会话时生效");
          }
          await refreshMcpLive();
        } catch (error) {
          for (const page of changedPages) setServerNote(page, `设置已保存，当前会话应用失败：${browserErrorText(error)}`);
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
    { key: "context", label: "模型与上下文", sub: "默认窗口 / 按模型覆盖" },
    { key: "providers", label: "Provider 管理", sub: "账号 / API Key / OAuth" },
    { key: "diagnostics", label: "内存诊断", sub: "进程 / 缓存 / JS 堆" },
    { key: "permissions", label: "权限规则", sub: "allow / deny" },
    { key: "agents", label: "自定义 Agents", sub: "Task 子代理" },
    {
      key: "skills",
      label: "Skills",
      sub: `${skillsInfo?.skills.length ?? 0} 个`,
    },
    { key: "plugins", label: "本地插件", sub: "plugin 目录" },
    { key: "control", label: "操控", sub: "桌面应用与浏览器" },
    { key: "mcp", label: "MCP 服务器", sub: `${customServers.length} 个` },
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
            <ThemedSelect
              variant="settings"
              ariaLabel="默认模型"
              value={form.defaultModel}
              title={form.defaultModel}
              options={defaultModelOptions}
              disabled={configuredModelIds.length === 0}
              onChange={(value) => setField("defaultModel", value)}
              menuMaxHeight={260}
            />
          </label>

          <div className="settings-field">
            <span>模型列表</span>
            <details className="settings-model-list-dropdown">
              <summary className="settings-model-list-trigger">
                <span>
                  {configuredModelIds.length
                    ? `已配置 ${configuredModelIds.length} 个模型`
                    : "还没有配置模型"}
                </span>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <div className="settings-model-list-panel">
                <div className="settings-model-list-rows">
                  {configuredModelIds.length === 0 ? (
                    <div className="settings-model-empty">暂无模型，请在下方添加。</div>
                  ) : (
                    configuredModelIds.map((id) => (
                      <div className="settings-model-list-row" key={id}>
                        <span title={id}>{modelLabel(id)}</span>
                        <button
                          type="button"
                          className="settings-model-delete"
                          aria-label={`删除模型 ${modelLabel(id)}`}
                          title={`删除 ${modelLabel(id)}`}
                          onClick={() =>
                            updateModelList(configuredModelIds.filter((model) => model !== id))
                          }
                        >
                          删除
                        </button>
                      </div>
                    ))
                  )}
                </div>
                {modelSuggestions.length > 0 && (
                  <label className="settings-field">
                    模型目录
                    <ThemedSelect
                      variant="settings"
                      ariaLabel="模型目录"
                      value={modelSuggestions.some(model => model.id === modelDraft) ? modelDraft : ""}
                      onChange={setModelDraft}
                      options={[
                        { value: "", label: "从目录选择模型…" },
                        ...modelSuggestions.map(model => ({ value: model.id, label: modelLabel(model.id), title: model.id })),
                      ]}
                    />
                  </label>
                )}
                <div className="settings-model-add-row">
                  <input
                    type="text"
                    aria-label="模型 ID"
                    value={modelDraft}
                    placeholder="输入模型 ID"
                    spellCheck={false}
                    onChange={(event) => setModelDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addModel();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={
                      !modelDraft.trim() || configuredModelIds.includes(modelDraft.trim())
                    }
                    onClick={addModel}
                  >
                    添加
                  </button>
                </div>
              </div>
            </details>
          </div>

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
                    setSavedNote(
                      `已同步 ${latest?.models?.length ?? 0} 个 Provider 模型`,
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
              {syncing ? "同步中…" : "同步 Provider 模型"}
            </button>
          </div>

          <label className="settings-field">
            语言 / Language
            <ThemedSelect
              variant="settings"
              ariaLabel="语言 / Language"
              value={form.locale}
              onChange={value => setField("locale", value)}
              options={[
                { value: "system", label: "跟随系统 / Follow system" },
                { value: "zh", label: "中文" },
                { value: "en", label: "English" },
              ]}
            />
            <p className="settings-hint">界面语言（保存后生效）</p>
          </label>
          <div className="settings-toggle-row">
            <div>
              <span>{t.settings.photoFlow}</span>
              <small>{t.settings.photoFlowHint}</small>
            </div>
            <ToggleSwitch
              checked={settings?.photoFlowEnabled !== false}
              label={t.settings.photoFlow}
              disabled={saving || savingPhotoFlow}
              onCheckedChange={(enabled) => { void onPhotoFlowChange(enabled); }}
            />
          </div>
          <div className="settings-toggle-row">
            <div>
              <span>{t.settings.galaxyEffects}</span>
              <small>{t.settings.galaxyEffectsHint}</small>
            </div>
            <ToggleSwitch
              checked={settings?.galaxyEffectsEnabled !== false}
              label={t.settings.galaxyEffects}
              disabled={saving || savingGalaxyEffects}
              onCheckedChange={(enabled) => { void onGalaxyEffectsChange(enabled); }}
            />
          </div>
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
              热更新只替换程序文件，不会覆盖账号凭证、设置和会话。
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

            {page === "context" ? (
              <>
              <label className="settings-field">
                默认上下文窗口（tokens）
                <input
                  type="number"
                  min={1024}
                  step={1}
                  value={form.defaultContextLimit}
                  onChange={(e) => setField("defaultContextLimit", e.target.value)}
                />
              </label>
              <p className="settings-hint">
                模型无内置窗口时使用。默认 200000。
              </p>

              {renderContextLimitsTable()}

              <label className="settings-field">
                工具输出预算
                <ThemedSelect variant="settings" ariaLabel="工具输出预算" value={form.outputMode}
                  onChange={value => setField("outputMode", value === "standard" ? "standard" : "balanced")}
                  options={[
                    { value: "balanced", label: "均衡 · 缩短长输出，可按需读取全文" },
                    { value: "standard", label: "标准 · 使用 SDK 默认预算" },
                  ]} />
              </label>
              <label className="settings-field">
                自动压缩阈值（上下文占用 %）
                <input type="number" min={50} max={95} step={1} value={form.compactPercent}
                  onChange={e => setField("compactPercent", e.target.value)} />
              </label>
              <label className="settings-field">
                摘要模型
                <ThemedSelect variant="settings" ariaLabel="摘要模型" value={form.summaryModel}
                  onChange={value => setField("summaryModel", value)}
                  options={[
                    { value: "", label: "跟随当前会话" },
                    ...(form.summaryModel && !catalog.some(model => model.id === form.summaryModel)
                      ? [{ value: form.summaryModel, label: `${form.summaryModel}（目录中暂不可用）` }] : []),
                    ...catalog.map(model => ({ value: model.id, label: model.id, title: model.id })),
                  ]} />
              </label>
              <p className="settings-hint">单聊的旧对话会发给所选模型生成摘要。群聊跟随席位模型。</p>

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

            {page === "control" && (
              <ControlSettings rows={form.mcpServers} live={mcpLive} isWindows={navigator.platform.startsWith("Win")}
                expanded={expandedControl} onExpand={setExpandedControl} renderProfile={renderMcpRow}
                onToggle={(target, enabled) => editServerRows(rows => setControlEnabled(rows, target, enabled),
                  "control", form.mcpServers.filter(row => controlTarget(row) === target))}
                onAdd={target => editServerRows(rows => [...rows, newMcpRow(rows, "playwright", target,
                  !rows.some(row => controlTarget(row) === target && !row.disabled))], "control")}
                probingTarget={probingTarget} onProbe={rows => void onMcpProbeDraft(rows, "control")}
                note={mcpNotes.control} />
            )}

            {page === "mcp" ? renderMcpServers() : null}

            {/* 两个区块自带标题与间距，这里不再外包一层 padding / h3。 */}
            {page === "providers" && (
              <div className="settings-provider-page">
                <ProviderDashboard />
                <ProviderSettings />
              </div>
            )}

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
