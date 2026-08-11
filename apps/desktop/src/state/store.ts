import { useSyncExternalStore } from "react";
import {
  IPC,
  type Attachment,
  type ChatItem,
  type CpaStatus,
  type FileChange,
  type PermissionMode,
  type PermissionRequest,
  type PublicSettings,
  type SdkNormalizedEvent,
  type SessionSummary,
  type SlashCommandItem,
  type ToolCardState,
  type UserPrompt,
  type UserPromptRequest,
} from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";

export type AppState = {
  projectPath: string | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  itemsBySession: Record<string, ChatItem[]>;
  changesBySession: Record<string, FileChange[]>;
  /** SDK skills / slash commands keyed by session */
  slashBySession: Record<string, SlashCommandItem[]>;
  permissionRequest: PermissionRequest | null;
  userPromptRequest: UserPromptRequest | null;
  cpaStatus: CpaStatus;
  settings: PublicSettings | null;
  running: boolean;
  /** Messages queued while a turn is running (sent when it finishes) */
  queuedPrompts: Array<{ text: string; displayText: string; attachments: Attachment[] }>;
  lastError: string | null;
};

type Listener = () => void;

let state: AppState = {
  projectPath: null,
  sessions: [],
  activeSessionId: null,
  itemsBySession: {},
  changesBySession: {},
  slashBySession: {},
  permissionRequest: null,
  userPromptRequest: null,
  cpaStatus: { state: "unknown" },
  settings: null,
  running: false,
  queuedPrompts: [],
  lastError: null,
};

const listeners = new Set<Listener>();
let bootstrapped = false;
const unsubs: Array<() => void> = [];

/** Pending user prompt for startSession before sessionId is known. */
let pendingStartPrompt: string | null = null;
/**
 * Queue of optimistically-appended user texts per session.
 * SDK often re-emits the same user turn after the agent finishes; we drop that echo.
 */
const optimisticUserTexts = new Map<string, string[]>();
/**
 * SDK-persisted user message uuids per session, in turn order (from the
 * main process via `user_msg_ids` events). Bound to user ChatItems by
 * ordinal for message-level rewind.
 */
const sdkUserMsgIds = new Map<string, string[]>();
let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

function emit(): void {
  for (const l of listeners) l();
}

function setState(partial: Partial<AppState> | ((prev: AppState) => AppState)): void {
  const next = typeof partial === "function" ? partial(state) : { ...state, ...partial };
  state = next;
  emit();
}

function getItems(sessionId: string): ChatItem[] {
  return state.itemsBySession[sessionId] ?? [];
}

const transcriptSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function saveTranscriptNow(sessionId: string, items?: ChatItem[]): void {
  try {
    const desktop = getDesktop();
    const payload = items ?? state.itemsBySession[sessionId] ?? [];
    void desktop.saveSessionTranscript?.(sessionId, payload);
  } catch {
    // not in electron / API missing
  }
}

function scheduleSaveTranscript(sessionId: string, items: ChatItem[]): void {
  const prev = transcriptSaveTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    transcriptSaveTimers.delete(sessionId);
    saveTranscriptNow(sessionId, items);
  }, 200);
  transcriptSaveTimers.set(sessionId, t);
}

/** Flush all debounced transcript writes (call on quit). */
export function flushAllTranscripts(): void {
  for (const [sessionId, timer] of transcriptSaveTimers) {
    clearTimeout(timer);
    transcriptSaveTimers.delete(sessionId);
    saveTranscriptNow(sessionId);
  }
  // Also persist every known session once more
  for (const sessionId of Object.keys(state.itemsBySession)) {
    saveTranscriptNow(sessionId);
  }
}

function setItems(sessionId: string, items: ChatItem[]): void {
  setState({
    itemsBySession: { ...state.itemsBySession, [sessionId]: items },
  });
  scheduleSaveTranscript(sessionId, items);
}

/** Bind known SDK user message uuids to user ChatItems by ordinal. */
function bindSdkUserMsgIds(sessionId: string, items: ChatItem[]): ChatItem[] {
  const uuids = sdkUserMsgIds.get(sessionId) ?? [];
  if (!uuids.length) return items;
  let i = 0;
  let changed = false;
  const next = items.map((item) => {
    if (item.kind === "text" && item.role === "user") {
      const uuid = uuids[i++];
      if (uuid && item.sdkMsgId !== uuid) {
        changed = true;
        return { ...item, sdkMsgId: uuid };
      }
    }
    return item;
  });
  return changed ? next : items;
}

function pushOptimisticUser(sessionId: string, text: string): void {
  const q = optimisticUserTexts.get(sessionId) ?? [];
  q.push(text);
  optimisticUserTexts.set(sessionId, q);
}

function consumeOptimisticUser(sessionId: string, text: string): boolean {
  const q = optimisticUserTexts.get(sessionId);
  if (!q?.length) return false;
  const idx = q.indexOf(text);
  if (idx < 0) return false;
  q.splice(idx, 1);
  if (!q.length) optimisticUserTexts.delete(sessionId);
  else optimisticUserTexts.set(sessionId, q);
  return true;
}

function upsertSession(summary: SessionSummary): void {
  const sessions = [...state.sessions];
  const idx = sessions.findIndex((s) => s.id === summary.id);
  if (idx >= 0) sessions[idx] = summary;
  else sessions.unshift(summary);
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  const running =
    summary.status === "running" ||
    sessions.some((s) => s.status === "running");

  let activeSessionId = state.activeSessionId;
  // Auto-activate newly created session when none selected (start flow).
  if (!activeSessionId && summary.status === "running") {
    activeSessionId = summary.id;
  }

  setState({ sessions, running, activeSessionId });
}

function appendUserMessage(
  sessionId: string,
  text: string,
  opts?: { optimistic?: boolean },
): void {
  const items = getItems(sessionId);
  const last = items[items.length - 1];
  if (last?.kind === "text" && last.role === "user" && last.text === text) {
    if (opts?.optimistic) pushOptimisticUser(sessionId, text);
    return;
  }
  setItems(sessionId, [
    ...items,
    { kind: "text", id: nextId("user"), role: "user", text },
  ]);
  if (opts?.optimistic) pushOptimisticUser(sessionId, text);
}

function applySessionEvent(event: SdkNormalizedEvent): void {
  const { sessionId } = event;
  const items = [...getItems(sessionId)];

  switch (event.type) {
    case "user_message": {
      // Drop SDK echo of a message we already showed optimistically.
      if (consumeOptimisticUser(sessionId, event.text)) {
        return;
      }
      // Internal post-compact resume prompt — already represented by the system
      // "Context compacted — continuing…" note; don't dump the full summary again.
      if (
        event.text.startsWith(
          "This session is being continued from a previous conversation",
        ) ||
        event.text.startsWith("Earlier conversation summary:")
      ) {
        return;
      }
      // SDK often re-emits the user prompt after the agent finishes (appears
      // as a duplicate bubble under the assistant reply). If we already have
      // this exact user text in the transcript, ignore the echo.
      if (
        items.some(
          (i) =>
            i.kind === "text" && i.role === "user" && i.text === event.text,
        )
      ) {
        return;
      }
      appendUserMessage(sessionId, event.text);
      return;
    }
    case "text_delta": {
      const last = items[items.length - 1];
      if (last?.kind === "text" && last.role === "assistant" && last.streaming) {
        items[items.length - 1] = {
          ...last,
          text: last.text + event.text,
        };
      } else {
        items.push({
          kind: "text",
          id: nextId("asst"),
          role: "assistant",
          text: event.text,
          streaming: true,
        });
      }
      setItems(sessionId, items);
      return;
    }
    case "text_done": {
      const last = items[items.length - 1];
      if (last?.kind === "text" && last.role === "assistant" && last.streaming) {
        // Prefer streamed text if longer; otherwise use done payload.
        const text =
          last.text.length >= event.text.length ? last.text : event.text;
        items[items.length - 1] = {
          ...last,
          text,
          streaming: false,
        };
      } else if (
        last?.kind === "text" &&
        last.role === "assistant" &&
        !last.streaming &&
        last.text === event.text
      ) {
        // duplicate full message — ignore
      } else {
        items.push({
          kind: "text",
          id: nextId("asst"),
          role: "assistant",
          text: event.text,
          streaming: false,
        });
      }
      setItems(sessionId, items);
      return;
    }
    case "tool_start": {
      const tool = event.tool;
      const existing = items.findIndex(
        (i) => i.kind === "tool" && i.tool.id === tool.id,
      );
      if (existing >= 0) {
        const cur = items[existing];
        if (cur.kind === "tool") {
          items[existing] = { kind: "tool", id: cur.id, tool: { ...tool } };
        }
      } else {
        items.push({ kind: "tool", id: tool.id || nextId("tool"), tool: { ...tool } });
      }
      setItems(sessionId, items);
      return;
    }
    case "tool_end": {
      const tool = event.tool;
      const existing = items.findIndex(
        (i) => i.kind === "tool" && i.tool.id === tool.id,
      );
      if (existing >= 0) {
        const cur = items[existing];
        if (cur.kind === "tool") {
          const merged: ToolCardState = {
            ...cur.tool,
            ...tool,
            // keep original name/summary if end event omits them
            name: tool.name && tool.name !== "tool" ? tool.name : cur.tool.name,
            summary: tool.summary || cur.tool.summary,
            // tool_end usually omits todos/isSubagent — preserve from tool_start
            todos: tool.todos ?? cur.tool.todos,
            isSubagent: tool.isSubagent ?? cur.tool.isSubagent,
          };
          items[existing] = { kind: "tool", id: cur.id, tool: merged };
        }
      } else {
        items.push({
          kind: "tool",
          id: tool.id || nextId("tool"),
          tool: { ...tool },
        });
      }
      setItems(sessionId, items);
      return;
    }
    case "tool_progress": {
      const existing = items.findIndex(
        (i) => i.kind === "tool" && i.tool.id === event.toolUseId,
      );
      if (existing >= 0) {
        const cur = items[existing];
        if (cur.kind === "tool") {
          items[existing] = {
            kind: "tool",
            id: cur.id,
            tool: {
              ...cur.tool,
              status: "running",
              elapsedSeconds: event.elapsedSeconds,
              name:
                event.toolName && event.toolName !== "tool"
                  ? event.toolName
                  : cur.tool.name,
            },
          };
          setItems(sessionId, items);
        }
      }
      return;
    }
    case "result": {
      // Finalize any streaming assistant bubble.
      const last = items[items.length - 1];
      if (last?.kind === "text" && last.role === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, streaming: false };
      }
      if (!event.ok && event.error) {
        items.push({
          kind: "text",
          id: nextId("sys"),
          role: "system",
          text: event.error,
        });
      }
      // Per-turn usage footer (tokens / duration / cost)
      if (event.usage) {
        items.push({
          kind: "usage",
          id: nextId("usage"),
          usage: event.usage,
        });
      }
      setItems(sessionId, items);
      // Turn finished — flush transcript immediately so quit cannot lose it.
      saveTranscriptNow(sessionId, items);
      setState({
        running: state.sessions.some(
          (s) => s.id !== sessionId && s.status === "running",
        ),
        lastError: event.ok ? state.lastError : (event.error ?? "Turn failed"),
      });
      // Auto-compress is scheduled from session:updated (has fresh contextUsage).
      // Send the next queued message (Claude Code-style type-ahead) once the
      // turn is fully done — but not when auto-compress is about to run, since
      // compression replaces the transcript first.
      if (!state.running && state.queuedPrompts.length > 0) {
        const summary = state.sessions.find((s) => s.id === sessionId);
        const ratio = summary?.contextUsage?.ratio ?? 0;
        if (ratio < AUTO_COMPRESS_RATIO) {
          setTimeout(flushQueuedPrompt, 0);
        }
      }
      return;
    }
    case "items_replaced": {
      // Main finished compression — replace UI transcript with summary + recent.
      // A fresh SDK session starts afterwards, so rewind uuid bindings reset.
      sdkUserMsgIds.delete(sessionId);
      setItems(sessionId, event.items);
      saveTranscriptNow(sessionId, event.items);
      return;
    }
    case "user_msg_ids": {
      sdkUserMsgIds.set(sessionId, event.uuids);
      const bound = bindSdkUserMsgIds(sessionId, getItems(sessionId));
      if (bound !== getItems(sessionId)) setItems(sessionId, bound);
      return;
    }

    default:
      return;
  }
}

function subscribeDesktopEvents(): void {
  let desktop;
  try {
    desktop = getDesktop();
  } catch {
    // Not in Electron preload context (e.g. unit tests / plain browser).
    return;
  }

  unsubs.push(
    desktop.on(IPC.sessionEvent, (payload) => {
      applySessionEvent(payload as SdkNormalizedEvent);
    }),
  );

  unsubs.push(
    desktop.on(IPC.sessionUpdated, (payload) => {
      const summary = payload as SessionSummary;
      upsertSession(summary);

      // First turn: append the user bubble as soon as the session becomes
      // running (early), not when startSession() resolves after the full turn
      // (that put the question under the assistant reply).
      if (
        pendingStartPrompt &&
        summary.status === "running" &&
        !getItems(summary.id).some(
          (i) =>
            i.kind === "text" &&
            i.role === "user" &&
            i.text === pendingStartPrompt,
        )
      ) {
        const text = pendingStartPrompt;
        pendingStartPrompt = null;
        appendUserMessage(summary.id, text, { optimistic: true });
      }

      // After a turn finishes, main attaches fresh contextUsage here.
      // Trigger auto-compress only then — and only with live renderer items.
      if (
        (summary.status === "idle" || summary.status === "error") &&
        summary.contextUsage &&
        summary.contextUsage.ratio >= AUTO_COMPRESS_RATIO
      ) {
        maybeAutoCompressAfterResult(summary.id);
      }
    }),
  );

  unsubs.push(
    desktop.on(IPC.diffUpdated, (payload) => {
      const { sessionId, changes } = payload as {
        sessionId: string;
        changes: FileChange[];
      };
      setState({
        changesBySession: {
          ...state.changesBySession,
          [sessionId]: changes,
        },
      });
    }),
  );

  unsubs.push(
    desktop.on(IPC.permissionRequest, (payload) => {
      setState({ permissionRequest: payload as PermissionRequest });
    }),
  );

  unsubs.push(
    desktop.on(IPC.userPromptRequest, (payload) => {
      setState({ userPromptRequest: payload as UserPromptRequest });
    }),
  );

  unsubs.push(
    desktop.on(IPC.sessionSlashCommandsEvent, (payload) => {
      const { sessionId, commands } = payload as {
        sessionId: string;
        commands: SlashCommandItem[];
      };
      setState({
        slashBySession: {
          ...state.slashBySession,
          [sessionId]: commands,
        },
      });
    }),
  );

  unsubs.push(
    desktop.on(IPC.cpaStatusEvent, (payload) => {
      setState({ cpaStatus: payload as CpaStatus });
    }),
  );

  unsubs.push(
    desktop.on(IPC.appError, (payload) => {
      const { message } = payload as { message: string; detail?: string };
      setState({ lastError: message, running: false });
    }),
  );
}

export async function bootstrapStore(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  subscribeDesktopEvents();

  let desktop;
  try {
    desktop = getDesktop();
  } catch {
    return;
  }

  try {
    const [settings, cpaStatus, sessions] = await Promise.all([
      desktop.getSettings() as Promise<PublicSettings>,
      desktop.getCpaStatus() as Promise<CpaStatus>,
      desktop.listSessions() as Promise<SessionSummary[]>,
    ]);

    // Do not clobber projectPath if openProject (or user) already set it while
    // these awaits were in flight — live e2e hit a race where stale
    // lastProjectPath overwrote a freshly opened directory.
    const list = sessions ?? [];
    setState((prev) => ({
      ...prev,
      settings,
      cpaStatus,
      sessions: list,
      projectPath: prev.projectPath ?? settings.lastProjectPath ?? null,
      running: list.some((s) => s.status === "running"),
    }));

    // After restart, auto-open the most recent session (restores chat + cwd).
    if (list.length > 0 && !getState().activeSessionId) {
      const latest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) {
        void selectSession(latest.id);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ lastError: message });
  }
}

export function getState(): AppState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

// --- actions ---

/** Open project by path, or show native folder dialog when path omitted. */
export async function openProject(path?: string): Promise<void> {
  const desktop = getDesktop();
  try {
    const res = (await desktop.openProject(path)) as { path: string };
    setState({ projectPath: res.path, lastError: null });
    const settings = (await desktop.getSettings()) as PublicSettings;
    setState({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "canceled" || /cancel/i.test(message)) {
      // User dismissed the dialog — not an app error.
      return;
    }
    setState({ lastError: message });
    throw err;
  }
}

export async function saveSettings(
  patch: Omit<Partial<PublicSettings>, "effort"> & {
    token?: string;
    /** null clears the effort override (main handles the deletion) */
    effort?: PublicSettings["effort"] | null;
  },
): Promise<void> {
  const desktop = getDesktop();
  try {
    const { token, hasToken: _hasToken, ...rest } = patch as Omit<
      Partial<PublicSettings>,
      "effort"
    > & {
      token?: string;
      hasToken?: boolean;
      effort?: PublicSettings["effort"] | null;
    };
    const body = { ...rest } as Record<string, unknown> & { token?: string };
    if (token !== undefined) body.token = token;
    const settings = (await desktop.setSettings(
      body as Parameters<typeof desktop.setSettings>[0],
    )) as PublicSettings;
    setState({ settings, lastError: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ lastError: message });
    throw err;
  }
}

/** First-run: persist gateway token + CPA config + optionally start CPA. */
export async function completeOnboarding(
  token: string,
  startCpa = true,
): Promise<{
  ok: boolean;
  error?: string;
  cpaStatus: CpaStatus;
}> {
  const desktop = getDesktop();
  const res = await desktop.completeOnboarding(token, startCpa);
  setState({
    settings: res.settings,
    cpaStatus: res.cpaStatus,
    lastError: res.ok ? null : (res.error ?? "Onboarding failed"),
  });
  return {
    ok: res.ok,
    error: res.error,
    cpaStatus: res.cpaStatus,
  };
}

export function clearLastError(): void {
  setState({ lastError: null });
}

export function newChat(): void {
  setState({ activeSessionId: null });
}

export async function selectSession(sessionId: string): Promise<void> {
  setState({ activeSessionId: sessionId });
  const desktop = getDesktop();
  try {
    const res = (await desktop.selectSession(sessionId)) as {
      sessionId: string;
      cwd?: string;
      items?: ChatItem[];
      changes: FileChange[];
    };

    // Prefer disk transcript if local memory is empty (app restart / other window).
    const localItems = state.itemsBySession[sessionId] ?? [];
    const restoredItems =
      localItems.length > 0 ? localItems : (res.items ?? []);

    // Switch project path to this session's workspace folder.
    const cwd = res.cwd || state.sessions.find((s) => s.id === sessionId)?.cwd;

    setState({
      activeSessionId: sessionId,
      projectPath: cwd || state.projectPath,
      itemsBySession: {
        ...state.itemsBySession,
        [sessionId]: bindSdkUserMsgIds(sessionId, restoredItems),
      },
      changesBySession: {
        ...state.changesBySession,
        [sessionId]: res.changes ?? [],
      },
      lastError: null,
    });

    // Keep settings.lastProjectPath in sync (main already updates; refresh public settings).
    try {
      const settings = (await desktop.getSettings()) as PublicSettings;
      setState({ settings });
    } catch {
      // ignore
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ lastError: message });
  }
}

/**
 * Fire-and-forget send. sessionStart/continue await the full turn in main,
 * so UI must drive from session:event / session:updated.
 */
export function sendMessage(text: string, attachments: Attachment[] = []): void {
  const promptText = text.trim();
  const displayText =
    attachments.length > 0
      ? `${promptText}\n\n[Attached: ${attachments.map((a) => a.name).join(", ")}]`
      : promptText;

  const prompt: UserPrompt = { text: promptText, attachments };
  if (!promptText && attachments.length === 0) return;

  // While a turn is running, queue instead of racing the live stream —
  // Claude Code style: typed messages send automatically when the turn ends.
  if (state.running && state.activeSessionId) {
    setState({
      queuedPrompts: [
        ...state.queuedPrompts,
        { text: promptText, displayText, attachments },
      ],
    });
    return;
  }

  let desktop;
  try {
    desktop = getDesktop();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ lastError: message });
    return;
  }

  const activeSessionId = state.activeSessionId;
  setState({ running: true, lastError: null });

  if (activeSessionId) {
    appendUserMessage(activeSessionId, displayText, { optimistic: true });
    // Optimistic running status for the active session.
    const sessions = state.sessions.map((s) =>
      s.id === activeSessionId
        ? { ...s, status: "running" as const, updatedAt: Date.now() }
        : s,
    );
    setState({ sessions });

    void desktop.continueSession(activeSessionId, prompt).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setState({ lastError: message, running: false });
    });
    return;
  }

  // New session: show the user bubble on first session:updated (running).
  // startSession awaits the full turn, so appending only in .then() puts the
  // question after the assistant reply.
  pendingStartPrompt = displayText;
  void desktop
    .startSession(prompt, state.projectPath ?? undefined)
    .then((res) => {
      const { sessionId } = res as { sessionId: string };
      if (!state.activeSessionId || state.activeSessionId !== sessionId) {
        setState({ activeSessionId: sessionId });
      }
      // Fallback if session:updated never carried the prompt (should be rare).
      if (pendingStartPrompt) {
        const textToAdd = pendingStartPrompt;
        pendingStartPrompt = null;
        if (
          !getItems(sessionId).some(
            (i) =>
              i.kind === "text" && i.role === "user" && i.text === textToAdd,
          )
        ) {
          appendUserMessage(sessionId, textToAdd, { optimistic: true });
        }
      }
    })
    .catch((err: unknown) => {
      pendingStartPrompt = null;
      const message = err instanceof Error ? err.message : String(err);
      setState({ lastError: message, running: false });
    });
}

export function abortActiveSession(): void {
  const id = state.activeSessionId;
  if (!id) return;
  // Stop means stop: drop queued messages too (Claude Code Esc semantics).
  setState({ queuedPrompts: [] });
  try {
    const desktop = getDesktop();
    void desktop.abortSession(id);
  } catch {
    // ignore
  }
}

/** Remove one queued (not yet sent) message by index. */
export function dequeuePrompt(index: number): void {
  setState({
    queuedPrompts: state.queuedPrompts.filter((_, i) => i !== index),
  });
}

/** Send the next queued message after a turn finished. */
function flushQueuedPrompt(): void {
  const [next, ...rest] = state.queuedPrompts;
  if (!next) return;
  setState({ queuedPrompts: rest });
  sendMessage(next.text, next.attachments);
}

/**
 * Message-level rewind (Claude Code "Esc Esc"): files return to the
 * checkpoint taken at that user message, and the conversation is truncated
 * so the next turn resumes from that point.
 */
export async function rewindToMessage(
  sessionId: string,
  sdkMsgId: string,
): Promise<{ ok: boolean; error?: string; filesChanged?: string[] }> {
  const desktop = getDesktop();
  const res = await desktop.rewindSession(sessionId, sdkMsgId);
  if (!res.ok) {
    return { ok: false, error: res.error ?? "Rewind failed" };
  }
  // Truncate transcript AFTER the anchor user message (the anchor stays as
  // the new tip, matching SDK resumeSessionAt semantics).
  const items = getItems(sessionId);
  const idx = items.findIndex(
    (i) => i.kind === "text" && i.role === "user" && i.sdkMsgId === sdkMsgId,
  );
  if (idx >= 0) {
    const truncated = items.slice(0, idx + 1);
    setItems(sessionId, truncated);
    saveTranscriptNow(sessionId, truncated);
  }
  const uuids = sdkUserMsgIds.get(sessionId);
  if (uuids) {
    const uidx = uuids.indexOf(sdkMsgId);
    sdkUserMsgIds.set(sessionId, uidx >= 0 ? uuids.slice(0, uidx + 1) : uuids);
  }
  // Refresh the change list (main re-emits diff:updated on restore, but the
  // rewind path bypasses DiffTracker — files may no longer match records).
  return { ok: true, filesChanged: res.filesChanged ?? [] };
}

/** Ratio at which renderer auto-compresses after a turn finishes. */
const AUTO_COMPRESS_RATIO = 0.75;
/** Cooldown so we don't thrash compress while usage stays high. */
const autoCompressedAt = new Map<string, number>();
const AUTO_COMPRESS_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Compress the active session using the live renderer transcript (not disk).
 * Disk archive can lag; main must receive current items to avoid wiping history.
 * Manual /compact does NOT auto-continue — user sends the next message.
 */
export async function compressActiveSession(): Promise<{ ok: boolean; message?: string }> {
  const id = state.activeSessionId;
  if (!id) return { ok: false, message: "No active session" };
  if (state.running) {
    return { ok: false, message: "Wait for the current turn to finish before /compact" };
  }
  const desktop = getDesktop();
  // Flush any pending debounced save first, then pass live items.
  const prev = transcriptSaveTimers.get(id);
  if (prev) {
    clearTimeout(prev);
    transcriptSaveTimers.delete(id);
  }
  const items = getItems(id);
  saveTranscriptNow(id, items);
  const res = await desktop.compressSession(id, items, { autoContinue: false });
  if (res.ok) autoCompressedAt.set(id, Date.now());
  return res;
}

/**
 * Auto-compact after a finished turn when context is high.
 * Uses Claude Code semantics: compact, then immediately continue the last task
 * so work is not abandoned mid-session.
 */
function maybeAutoCompressAfterResult(sessionId: string): void {
  const summary = state.sessions.find((s) => s.id === sessionId);
  const ratio = summary?.contextUsage?.ratio;
  if (ratio == null || ratio < AUTO_COMPRESS_RATIO) return;
  // Only auto-compact when the session is idle (turn already finished).
  if (summary?.status === "running") return;
  const last = autoCompressedAt.get(sessionId);
  if (last != null && Date.now() - last < AUTO_COMPRESS_COOLDOWN_MS) return;
  // Reserve cooldown immediately so concurrent session:updated won't double-fire.
  autoCompressedAt.set(sessionId, Date.now());

  // Fire-and-forget; items_replaced will update UI when main finishes.
  // Delay one macrotask so any in-flight session:event (result/usage footer)
  // is applied before we snapshot the transcript.
  void (async () => {
    await new Promise((r) => setTimeout(r, 0));
    try {
      // Re-check idle after the tick — a new user send may have started.
      const latest = state.sessions.find((s) => s.id === sessionId);
      if (latest?.status === "running" || state.running) {
        autoCompressedAt.delete(sessionId);
        return;
      }
      // Drop any pending debounced save so a stale full transcript cannot
      // overwrite the compressed snapshot after main finishes.
      const pending = transcriptSaveTimers.get(sessionId);
      if (pending) {
        clearTimeout(pending);
        transcriptSaveTimers.delete(sessionId);
      }
      const items = getItems(sessionId);
      // Need more than KEEP_RECENT_ITEMS (6) bubbles or compression is a no-op.
      if (items.length <= 6) {
        autoCompressedAt.delete(sessionId);
        return;
      }
      const desktop = getDesktop();
      // Ensure disk has the same snapshot we're about to compress.
      saveTranscriptNow(sessionId, items);
      setState({ running: true });
      const res = await desktop.compressSession(sessionId, items, {
        autoContinue: true,
      });
      if (!res.ok) {
        // Allow retry if compress declined (cooldown / not enough history).
        autoCompressedAt.delete(sessionId);
        setState({
          running: state.sessions.some((s) => s.status === "running"),
        });
        if (
          res.message &&
          !/cooldown|Not enough|Nothing to compress|still running/i.test(
            res.message,
          )
        ) {
          setState({ lastError: res.message });
        }
      }
      // On success, main already set status=running and started the continue turn.
    } catch (err) {
      autoCompressedAt.delete(sessionId);
      const message = err instanceof Error ? err.message : String(err);
      setState({
        lastError: `Context compression failed: ${message}`,
        running: state.sessions.some((s) => s.status === "running"),
      });
    }
  })();
}

export async function setModel(model: string): Promise<void> {
  const desktop = getDesktop();
  await desktop.setModel(model);
  const settings = (await desktop.getSettings()) as PublicSettings;
  setState({ settings });
}

export async function setPermissionMode(mode: PermissionMode): Promise<void> {
  const desktop = getDesktop();
  const settings = (await desktop.setSettings({
    permissionMode: mode,
  })) as PublicSettings;
  setState({ settings });
}

/** Persist theme choice; renderer applies via data-theme on <html>. */
export async function setTheme(
  theme: NonNullable<PublicSettings["theme"]>,
): Promise<void> {
  const desktop = getDesktop();
  const settings = (await desktop.setSettings({ theme })) as PublicSettings;
  setState({ settings });
}

export async function startCpa(): Promise<void> {
  const desktop = getDesktop();
  try {
    const status = (await desktop.startCpa()) as CpaStatus;
    setState({ cpaStatus: status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({
      cpaStatus: { state: "error", message },
      lastError: message,
    });
  }
}

/** Pull model list from CPA /v1/models into settings (includes deepseek proxies). */
export async function syncCpaModels(): Promise<void> {
  const desktop = getDesktop();
  try {
    await desktop.syncCpaModels();
    const settings = (await desktop.getSettings()) as PublicSettings;
    setState({ settings, lastError: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ lastError: message });
    throw err;
  }
}

export function clearPermissionRequest(): void {
  setState({ permissionRequest: null });
}

export function clearUserPromptRequest(): void {
  setState({ userPromptRequest: null });
}

/** Test helper — reset module state. */
export function __resetStoreForTests(): void {
  state = {
    projectPath: null,
    sessions: [],
    activeSessionId: null,
    itemsBySession: {},
    changesBySession: {},
    slashBySession: {},
    permissionRequest: null,
    userPromptRequest: null,
    cpaStatus: { state: "unknown" },
    settings: null,
    running: false,
    queuedPrompts: [],
    lastError: null,
  };
  pendingStartPrompt = null;
  autoCompressedAt.clear();
  for (const timer of transcriptSaveTimers.values()) clearTimeout(timer);
  transcriptSaveTimers.clear();
  bootstrapped = false;
  for (const u of unsubs) u();
  unsubs.length = 0;
  listeners.clear();
  emit();
}

/** Test helper — inject a session event. */
export function __applySessionEventForTests(event: SdkNormalizedEvent): void {
  applySessionEvent(event);
}

export function __upsertSessionForTests(summary: SessionSummary): void {
  upsertSession(summary);
}
