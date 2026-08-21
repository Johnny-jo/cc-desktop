import { useSyncExternalStore } from "react";
import {
  IPC,
  appendUserItem,
  applySdkEvent,
  bindSdkUserMsgIds as bindIds,
  createIdFactory,
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
  type TranscriptState,
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
  /** Disk still has older bubbles not yet in itemsBySession. */
  hasMoreBySession: Record<string, boolean>;
  /** Disk / live tail still has newer bubbles past the current window. */
  hasNewerBySession: Record<string, boolean>;
  /** Lightweight CLI page; drops renderer transcript cache while active. */
  cliMode: boolean;
  /** Session whose transcript is being loaded from disk (skeleton screen). */
  loadingSessionId: string | null;
  /**
   * Cross-component request: chat tool card asks the changes panel to
   * reveal one change record. nonce forces re-fire for repeated clicks.
   */
  revealChangeRequest: {
    sessionId: string;
    toolUseId?: string;
    path?: string;
    nonce: number;
  } | null;
  /** Bumped on every diff:updated — file tree / open editors refresh. */
  fsChangeTick: number;
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
  hasMoreBySession: {},
  hasNewerBySession: {},
  cliMode: false,
  loadingSessionId: null,
  revealChangeRequest: null,
  fsChangeTick: 0,
};

const listeners = new Set<Listener>();
let bootstrapped = false;
const unsubs: Array<() => void> = [];

/**
 * Renderer transcript cache: at most this many sessions keep their chat /
 * changes in memory (stack semantics — least recently viewed is evicted).
 * The active session and any running turn are always retained on top.
 */
export const SESSION_CACHE_CAP = 6;
/** Most-recently-viewed first. */
let sessionCacheLru: string[] = [];

function touchSessionCache(sessionId: string): void {
  sessionCacheLru = [sessionId, ...sessionCacheLru.filter((id) => id !== sessionId)];
}

/** Pending user prompt for startSession before sessionId is known. */
let pendingStartPrompt: { text: string; attachments: Attachment[] } | null = null;
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
const nextId = createIdFactory();

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

/**
 * Active session plus any still-running turn are always kept; the remaining
 * slots (up to SESSION_CACHE_CAP total) go to recently viewed sessions.
 * Everything else is on disk and reloads (with a skeleton) when clicked.
 */
function retainedSessionIds(activeId: string | null = state.activeSessionId): Set<string> {
  const keep = new Set<string>();
  if (activeId) keep.add(activeId);
  for (const s of state.sessions) {
    if (s.status === "running") keep.add(s.id);
  }
  for (const id of sessionCacheLru) {
    if (keep.size >= SESSION_CACHE_CAP) break;
    keep.add(id);
  }
  return keep;
}

function shouldCacheSession(sessionId: string): boolean {
  return retainedSessionIds().has(sessionId);
}

function pickRecord<T>(rec: Record<string, T>, keep: Set<string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const id of keep) {
    if (Object.prototype.hasOwnProperty.call(rec, id)) out[id] = rec[id];
  }
  return out;
}

function pruneSideMaps(keep: Set<string>): void {
  for (const id of [...optimisticUserTexts.keys()]) {
    if (!keep.has(id)) optimisticUserTexts.delete(id);
  }
  for (const id of [...sdkUserMsgIds.keys()]) {
    if (!keep.has(id)) sdkUserMsgIds.delete(id);
  }
}

function prunedSessionCaches(
  keep: Set<string>,
  overlay?: Partial<
    Pick<
      AppState,
      | "itemsBySession"
      | "changesBySession"
      | "slashBySession"
      | "hasMoreBySession"
      | "hasNewerBySession"
    >
  >,
): Pick<
  AppState,
  | "itemsBySession"
  | "changesBySession"
  | "slashBySession"
  | "hasMoreBySession"
  | "hasNewerBySession"
> {
  pruneSideMaps(keep);
  return {
    itemsBySession: pickRecord(overlay?.itemsBySession ?? state.itemsBySession, keep),
    changesBySession: pickRecord(
      overlay?.changesBySession ?? state.changesBySession,
      keep,
    ),
    slashBySession: pickRecord(overlay?.slashBySession ?? state.slashBySession, keep),
    hasMoreBySession: pickRecord(overlay?.hasMoreBySession ?? state.hasMoreBySession, keep),
    hasNewerBySession: pickRecord(
      overlay?.hasNewerBySession ?? state.hasNewerBySession,
      keep,
    ),
  };
}

/** Flush all debounced transcript writes (call on quit). */
export function flushAllTranscripts(): void {
  // Transcript persistence moved to SessionManager.
}

function setItems(sessionId: string, items: ChatItem[]): void {
  setState({
    itemsBySession: { ...state.itemsBySession, [sessionId]: items },
  });
}

/** Bind known SDK user message uuids to user ChatItems by ordinal. */
function bindSdkUserMsgIds(sessionId: string, items: ChatItem[]): ChatItem[] {
  return bindIds(items, sdkUserMsgIds.get(sessionId) ?? []);
}

function transcriptUi(sessionId: string): TranscriptState {
  return {
    items: getItems(sessionId),
    optimisticUserTexts: optimisticUserTexts.get(sessionId) ?? [],
  };
}

function writeTranscriptUi(sessionId: string, t: TranscriptState): void {
  if (t.optimisticUserTexts.length) {
    optimisticUserTexts.set(sessionId, t.optimisticUserTexts);
  } else {
    optimisticUserTexts.delete(sessionId);
  }
  let items = t.items;
  if (items.length > RENDERER_TRANSCRIPT_CAP) {
    items = items.slice(items.length - RENDERER_TRANSCRIPT_CAP);
    setState({
      itemsBySession: { ...state.itemsBySession, [sessionId]: items },
      hasMoreBySession: { ...state.hasMoreBySession, [sessionId]: true },
      hasNewerBySession: { ...state.hasNewerBySession, [sessionId]: false },
    });
    return;
  }
  setItems(sessionId, items);
}

function upsertSession(summary: SessionSummary): void {
  const sessions = [...state.sessions];
  const idx = sessions.findIndex((s) => s.id === summary.id);
  if (idx >= 0) sessions[idx] = summary;
  else sessions.unshift(summary);
  sessions.sort(
    (a, b) =>
      Number(b.pinned ?? 0) - Number(a.pinned ?? 0) || b.updatedAt - a.updatedAt,
  );

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
  opts?: { optimistic?: boolean; attachments?: Attachment[] },
): void {
  // CLI page owns its own `> text` echo; keep itemsBySession empty while frozen.
  if (state.cliMode) return;
  const next = appendUserItem(transcriptUi(sessionId), text, {
    nextId,
    optimistic: opts?.optimistic,
    attachments: opts?.attachments,
  });
  writeTranscriptUi(sessionId, next);
}

function finishSessionTurn(sessionId: string): SessionSummary[] {
  return state.sessions.map((s) =>
    s.id === sessionId && s.status === "running"
      ? { ...s, status: "idle" as const, updatedAt: Date.now() }
      : s,
  );
}

function applySessionEvent(event: SdkNormalizedEvent): void {
  const { sessionId } = event;

  // CLI mode: keep running/queue state alive, but do not accumulate chat items.
  if (state.cliMode) {
    if (event.type === "result") {
      const sessions = finishSessionTurn(sessionId);
      setState({
        sessions,
        running: sessions.some((s) => s.status === "running"),
        lastError: event.ok ? state.lastError : (event.error ?? "Turn failed"),
      });
      if (!state.running && state.queuedPrompts.length > 0) {
        const summary = state.sessions.find((s) => s.id === sessionId);
        const ratio = summary?.contextUsage?.ratio ?? 0;
        if (ratio < AUTO_COMPRESS_RATIO) setTimeout(flushQueuedPrompt, 0);
      }
    }
    return;
  }

  // Parked idle sessions live on disk; don't rebuild a renderer cache for them.
  if (!shouldCacheSession(sessionId)) {
    if (event.type === "result") {
      const sessions = finishSessionTurn(sessionId);
      setState({
        sessions,
        running: sessions.some((s) => s.status === "running"),
        lastError: event.ok ? state.lastError : (event.error ?? "Turn failed"),
      });
      if (!state.running && state.queuedPrompts.length > 0) {
        const summary = state.sessions.find((s) => s.id === sessionId);
        const ratio = summary?.contextUsage?.ratio ?? 0;
        if (ratio < AUTO_COMPRESS_RATIO) setTimeout(flushQueuedPrompt, 0);
      }
    }
    return;
  }

  const prev = transcriptUi(sessionId);
  if (event.type === "user_msg_ids") {
    sdkUserMsgIds.set(sessionId, event.uuids);
    const bound = bindIds(getItems(sessionId), event.uuids);
    if (bound !== getItems(sessionId)) setItems(sessionId, bound);
    return;
  }

  if (event.type === "items_replaced") {
    const next = applySdkEvent(prev, event, { nextId });
    writeTranscriptUi(sessionId, next);
    sdkUserMsgIds.delete(sessionId);
    setState({
      hasMoreBySession: { ...state.hasMoreBySession, [sessionId]: false },
      hasNewerBySession: { ...state.hasNewerBySession, [sessionId]: false },
    });
    return;
  }

  const applyResultFlags = (): void => {
    if (event.type !== "result") return;
    const sessions = finishSessionTurn(sessionId);
    setState({
      sessions,
      running: sessions.some((s) => s.status === "running"),
      lastError: event.ok ? state.lastError : (event.error ?? "Turn failed"),
    });
    if (!state.running && state.queuedPrompts.length > 0) {
      const summary = state.sessions.find((s) => s.id === sessionId);
      const ratio = summary?.contextUsage?.ratio ?? 0;
      if (ratio < AUTO_COMPRESS_RATIO) {
        setTimeout(flushQueuedPrompt, 0);
      }
    }
  };

  // Window is parked on older history — keep live tail on disk/main only.
  if (state.hasNewerBySession[sessionId]) {
    applyResultFlags();
    return;
  }

  const next = applySdkEvent(prev, event, { nextId });
  writeTranscriptUi(sessionId, next);
  applyResultFlags();
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
      // CLI mode: clear pending only — do not rewrite the frozen items cache.
      if (pendingStartPrompt && summary.status === "running") {
        if (state.cliMode) {
          pendingStartPrompt = null;
        } else {
          const pending = pendingStartPrompt;
          if (
            !getItems(summary.id).some(
              (i) =>
                i.kind === "text" &&
                i.role === "user" &&
                i.text === pending.text,
            )
          ) {
            pendingStartPrompt = null;
            appendUserMessage(summary.id, pending.text, {
              optimistic: true,
              attachments: pending.attachments,
            });
          }
        }
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

      if (summary.status !== "running" && summary.id !== state.activeSessionId) {
        setState(prunedSessionCaches(retainedSessionIds()));
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
        ...(shouldCacheSession(sessionId)
          ? {
              changesBySession: {
                ...state.changesBySession,
                [sessionId]: changes,
              },
            }
          : {}),
        fsChangeTick: state.fsChangeTick + 1,
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
      if (!shouldCacheSession(sessionId)) return;
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
    desktop.on(IPC.settingsUpdated, (payload) => {
      setState({ settings: payload as PublicSettings });
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
    // Detached windows open the session they were spawned for instead.
    if (list.length > 0 && !getState().activeSessionId) {
      const detachedId = detachedWindowSessionId();
      const target =
        (detachedId ? list.find((s) => s.id === detachedId) : undefined) ??
        [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (target) {
        void selectSession(target.id);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ lastError: message });
  }
}

/**
 * Session id when this window was spawned as a detached chat window
 * (`?detached=1&session=<id>`), else null for the main window.
 */
export function detachedWindowSessionId(): string | null {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get("detached") === "1" ? q.get("session") : null;
  } catch {
    return null;
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

export function enterCliMode(): void {
  setState({
    cliMode: true,
    itemsBySession: {},
    hasMoreBySession: {},
    hasNewerBySession: {},
  });
}

export function exitCliMode(): void {
  setState({ cliMode: false });
}

export function toggleCliMode(): void {
  if (state.cliMode) exitCliMode();
  else enterCliMode();
}

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

export function clearActiveSession(): void {
  setState({ activeSessionId: null });
}

export function newChat(): void {
  setState({ activeSessionId: null });
}

/** Pin / unpin a session at the top of the sidebar list (persisted in main). */
export async function toggleSessionPinned(sessionId: string): Promise<void> {
  const current = state.sessions.find((s) => s.id === sessionId);
  if (!current) return;
  try {
    const res = await getDesktop().setSessionPinned(sessionId, !current.pinned);
    if (res.ok && res.session) upsertSession(res.session);
    else if (!res.ok) setState({ lastError: res.error ?? "Pin failed" });
  } catch (err) {
    setState({ lastError: err instanceof Error ? err.message : String(err) });
  }
}

/** Rename a session title (persisted in main). Returns false when rejected. */
export async function renameSession(
  sessionId: string,
  title: string,
): Promise<boolean> {
  try {
    const res = await getDesktop().renameSession(sessionId, title);
    if (res.ok && res.session) {
      upsertSession(res.session);
      return true;
    }
    if (!res.ok) setState({ lastError: res.error ?? "Rename failed" });
  } catch (err) {
    setState({ lastError: err instanceof Error ? err.message : String(err) });
  }
  return false;
}

/** Delete a session: main aborts any live turn and removes its files. */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    const res = await getDesktop().deleteSession(sessionId);
    if (!res.ok) {
      setState({ lastError: res.error ?? "Delete failed" });
      return;
    }
  } catch (err) {
    setState({ lastError: err instanceof Error ? err.message : String(err) });
    return;
  }
  sessionCacheLru = sessionCacheLru.filter((id) => id !== sessionId);
  const sessions = state.sessions.filter((s) => s.id !== sessionId);
  const drop = <T>(rec: Record<string, T>): Record<string, T> => {
    if (!Object.prototype.hasOwnProperty.call(rec, sessionId)) return rec;
    const out = { ...rec };
    delete out[sessionId];
    return out;
  };
  pruneSideMaps(new Set(sessions.map((s) => s.id)));
  setState({
    sessions,
    running: sessions.some((s) => s.status === "running"),
    activeSessionId:
      state.activeSessionId === sessionId ? null : state.activeSessionId,
    loadingSessionId:
      state.loadingSessionId === sessionId ? null : state.loadingSessionId,
    itemsBySession: drop(state.itemsBySession),
    changesBySession: drop(state.changesBySession),
    slashBySession: drop(state.slashBySession),
    hasMoreBySession: drop(state.hasMoreBySession),
    hasNewerBySession: drop(state.hasNewerBySession),
  });
}

/** Renderer sliding window. Initial select and live cap share this length. */
export const RENDERER_TRANSCRIPT_CAP = 80;
const SELECT_PAGE = RENDERER_TRANSCRIPT_CAP;

export async function selectSession(sessionId: string): Promise<void> {
  touchSessionCache(sessionId);

  // Cache hit (LRU stack): show the in-memory window instantly, no disk read.
  const cacheHit =
    !state.cliMode &&
    Object.prototype.hasOwnProperty.call(state.itemsBySession, sessionId) &&
    !state.hasNewerBySession[sessionId];
  if (cacheHit) {
    const cwd = state.sessions.find((s) => s.id === sessionId)?.cwd;
    setState({
      activeSessionId: sessionId,
      projectPath: cwd || state.projectPath,
      loadingSessionId: null,
      ...prunedSessionCaches(retainedSessionIds(sessionId)),
      lastError: null,
    });
    return;
  }

  // Cache miss: skeleton screen while the disk page loads.
  setState({ activeSessionId: sessionId, loadingSessionId: sessionId });
  const desktop = getDesktop();
  try {
    const res = await desktop.selectSession(sessionId, SELECT_PAGE);

    if (state.cliMode) {
      const cwd = res.cwd || state.sessions.find((s) => s.id === sessionId)?.cwd;
      const keep = retainedSessionIds(sessionId);
      pruneSideMaps(keep);
      setState({
        activeSessionId: sessionId,
        projectPath: cwd || state.projectPath,
        itemsBySession: {},
        changesBySession: pickRecord(
          { ...state.changesBySession, [sessionId]: res.changes ?? [] },
          keep,
        ),
        lastError: null,
      });
      return;
    }

    // Live tail already in memory (this turn) wins over a disk page.
    const localItems = state.itemsBySession[sessionId] ?? [];
    const localHasStream = localItems.some(
      (i) => i.kind === "text" && i.streaming,
    );
    const restoredItems = localHasStream
      ? localItems
      : bindSdkUserMsgIds(sessionId, res.items ?? []);

    // Switch project path to this session's workspace folder.
    const cwd = res.cwd || state.sessions.find((s) => s.id === sessionId)?.cwd;
    const keep = retainedSessionIds(sessionId);

    setState({
      activeSessionId: sessionId,
      projectPath: cwd || state.projectPath,
      ...prunedSessionCaches(keep, {
        itemsBySession: {
          ...state.itemsBySession,
          [sessionId]: restoredItems,
        },
        changesBySession: {
          ...state.changesBySession,
          [sessionId]: res.changes ?? [],
        },
        hasMoreBySession: {
          ...state.hasMoreBySession,
          [sessionId]: localHasStream
            ? (state.hasMoreBySession[sessionId] ?? false)
            : Boolean(res.hasMore),
        },
        hasNewerBySession: {
          ...state.hasNewerBySession,
          [sessionId]: localHasStream
            ? (state.hasNewerBySession[sessionId] ?? false)
            : Boolean(res.hasNewer),
        },
      }),
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
  } finally {
    if (state.loadingSessionId === sessionId) {
      setState({ loadingSessionId: null });
    }
  }
}

/** Prepend the next older disk page and prune the newer tail. */
export async function loadOlderMessages(
  sessionId: string,
): Promise<{ ok: boolean }> {
  const items = getItems(sessionId);
  const beforeId = items[0]?.id;
  if (!beforeId || !hasDesktopApiSafe("loadOlderMessages")) {
    return { ok: false };
  }
  try {
    const page = await getDesktop().loadOlderMessages(sessionId, beforeId);
    if (!page.items.length) {
      setState({
        hasMoreBySession: { ...state.hasMoreBySession, [sessionId]: false },
      });
      return { ok: true };
    }
    const seen = new Set(items.map((i) => i.id));
    const older = page.items.filter((i) => !seen.has(i.id));
    const merged = bindSdkUserMsgIds(sessionId, [...older, ...items]);
    const pruned = merged.length > RENDERER_TRANSCRIPT_CAP;
    const next = pruned ? merged.slice(0, RENDERER_TRANSCRIPT_CAP) : merged;
    setState({
      itemsBySession: {
        ...state.itemsBySession,
        [sessionId]: next,
      },
      hasMoreBySession: {
        ...state.hasMoreBySession,
        [sessionId]: Boolean(page.hasMore),
      },
      hasNewerBySession: {
        ...state.hasNewerBySession,
        [sessionId]: pruned || Boolean(state.hasNewerBySession[sessionId]),
      },
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Append the next newer disk page and prune the older head. */
export async function loadNewerMessages(
  sessionId: string,
): Promise<{ ok: boolean }> {
  const items = getItems(sessionId);
  const afterId = items[items.length - 1]?.id;
  if (!afterId || !hasDesktopApiSafe("loadNewerMessages")) {
    return { ok: false };
  }
  try {
    const page = await getDesktop().loadNewerMessages(sessionId, afterId);
    if (!page.items.length) {
      setState({
        hasNewerBySession: { ...state.hasNewerBySession, [sessionId]: false },
      });
      return { ok: true };
    }
    const seen = new Set(items.map((i) => i.id));
    const newer = page.items.filter((i) => !seen.has(i.id));
    const merged = bindSdkUserMsgIds(sessionId, [...items, ...newer]);
    const pruned = merged.length > RENDERER_TRANSCRIPT_CAP;
    const next = pruned ? merged.slice(merged.length - RENDERER_TRANSCRIPT_CAP) : merged;
    setState({
      itemsBySession: {
        ...state.itemsBySession,
        [sessionId]: next,
      },
      hasMoreBySession: {
        ...state.hasMoreBySession,
        [sessionId]: pruned || Boolean(state.hasMoreBySession[sessionId]),
      },
      hasNewerBySession: {
        ...state.hasNewerBySession,
        [sessionId]: Boolean(page.hasNewer),
      },
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function hasDesktopApiSafe(name: string): boolean {
  try {
    const d = getDesktop() as unknown as Record<string, unknown>;
    return typeof d[name] === "function";
  } catch {
    return false;
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

  const activeSessionId = state.activeSessionId;
  // Queue only when THIS session is mid-turn. A detached window running
  // another session must not block send on the idle one.
  const activeBusy =
    Boolean(activeSessionId) &&
    state.sessions.some((s) => s.id === activeSessionId && s.status === "running");
  if (activeBusy) {
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
  setState({ running: true, lastError: null });

  if (activeSessionId) {
    if (state.hasNewerBySession[activeSessionId]) {
      setState({
        itemsBySession: { ...state.itemsBySession, [activeSessionId]: [] },
        hasNewerBySession: {
          ...state.hasNewerBySession,
          [activeSessionId]: false,
        },
        hasMoreBySession: {
          ...state.hasMoreBySession,
          [activeSessionId]: true,
        },
      });
    }
    appendUserMessage(activeSessionId, displayText, {
      optimistic: true,
      attachments,
    });
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
  pendingStartPrompt = { text: displayText, attachments };
  void desktop
    .startSession(prompt, state.projectPath ?? undefined)
    .then((res) => {
      const { sessionId } = res as { sessionId: string };
      if (!state.activeSessionId || state.activeSessionId !== sessionId) {
        setState({ activeSessionId: sessionId });
      }
      // Fallback if session:updated never carried the prompt (should be rare).
      if (pendingStartPrompt) {
        const pending = pendingStartPrompt;
        pendingStartPrompt = null;
        if (
          !getItems(sessionId).some(
            (i) =>
              i.kind === "text" &&
              i.role === "user" &&
              i.text === pending.text,
          )
        ) {
          appendUserMessage(sessionId, pending.text, {
            optimistic: true,
            attachments: pending.attachments,
          });
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
  // Optimistically clear running so the stop button flips back immediately;
  // main will also emit session:updated + result after tearing down the stream.
  const sessions = state.sessions.map((s) =>
    s.id === id && s.status === "running"
      ? { ...s, status: "idle" as const, updatedAt: Date.now() }
      : s,
  );
  setState({
    queuedPrompts: [],
    running: sessions.some((s) => s.status === "running"),
    sessions,
  });
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
 * Compress the active session. Main process holds the authoritative transcript.
 * Manual /compact does NOT auto-continue — user sends the next message.
 */
export async function compressActiveSession(): Promise<{ ok: boolean; message?: string }> {
  const id = state.activeSessionId;
  if (!id) return { ok: false, message: "No active session" };
  if (state.running) {
    return { ok: false, message: "Wait for the current turn to finish before /compact" };
  }
  const desktop = getDesktop();
  const res = await desktop.compressSession(id, undefined, { autoContinue: false });
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
      // GUI mode: local length gate (KEEP_RECENT_ITEMS = 6). CLI freezes
      // itemsBySession empty, so skip the gate and let main decide from entry.items.
      if (!state.cliMode) {
        const items = getItems(sessionId);
        if (items.length <= 6) {
          autoCompressedAt.delete(sessionId);
          return;
        }
      }
      const desktop = getDesktop();
      setState({ running: true });
      const res = await desktop.compressSession(sessionId, undefined, {
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

let revealNonce = 0;

/** Chat tool card → changes panel: reveal the matching change record. */
export function requestRevealChange(req: {
  sessionId: string;
  toolUseId?: string;
  path?: string;
}): void {
  revealNonce += 1;
  setState({ revealChangeRequest: { ...req, nonce: revealNonce } });
}

export function clearRevealChange(): void {
  if (state.revealChangeRequest) setState({ revealChangeRequest: null });
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
    hasMoreBySession: {},
    hasNewerBySession: {},
    cliMode: false,
    loadingSessionId: null,
    revealChangeRequest: null,
    fsChangeTick: 0,
  };
  pendingStartPrompt = null;
  sessionCacheLru = [];
  autoCompressedAt.clear();
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
