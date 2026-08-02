import { useSyncExternalStore } from "react";
import {
  IPC,
  type ChatItem,
  type CpaStatus,
  type FileChange,
  type PermissionMode,
  type PermissionRequest,
  type PublicSettings,
  type SdkNormalizedEvent,
  type SessionSummary,
  type ToolCardState,
} from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";

export type AppState = {
  projectPath: string | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  itemsBySession: Record<string, ChatItem[]>;
  changesBySession: Record<string, FileChange[]>;
  permissionRequest: PermissionRequest | null;
  cpaStatus: CpaStatus;
  settings: PublicSettings | null;
  running: boolean;
  lastError: string | null;
};

type Listener = () => void;

let state: AppState = {
  projectPath: null,
  sessions: [],
  activeSessionId: null,
  itemsBySession: {},
  changesBySession: {},
  permissionRequest: null,
  cpaStatus: { state: "unknown" },
  settings: null,
  running: false,
  lastError: null,
};

const listeners = new Set<Listener>();
let bootstrapped = false;
const unsubs: Array<() => void> = [];

/** Pending user prompt for startSession before sessionId is known. */
let pendingStartPrompt: string | null = null;
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

function setItems(sessionId: string, items: ChatItem[]): void {
  setState({
    itemsBySession: { ...state.itemsBySession, [sessionId]: items },
  });
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

function appendUserMessage(sessionId: string, text: string): void {
  const items = getItems(sessionId);
  const last = items[items.length - 1];
  if (last?.kind === "text" && last.role === "user" && last.text === text) {
    return;
  }
  setItems(sessionId, [
    ...items,
    { kind: "text", id: nextId("user"), role: "user", text },
  ]);
}

function applySessionEvent(event: SdkNormalizedEvent): void {
  const { sessionId } = event;
  const items = [...getItems(sessionId)];

  switch (event.type) {
    case "user_message": {
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
      setItems(sessionId, items);
      setState({
        running: state.sessions.some(
          (s) => s.id !== sessionId && s.status === "running",
        ),
        lastError: event.ok ? state.lastError : (event.error ?? "Turn failed"),
      });
      return;
    }
    case "raw":
      return;
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

      if (pendingStartPrompt && summary.status === "running") {
        appendUserMessage(summary.id, pendingStartPrompt);
        pendingStartPrompt = null;
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

    setState({
      settings,
      cpaStatus,
      sessions: sessions ?? [],
      projectPath: settings.lastProjectPath ?? null,
      running: (sessions ?? []).some((s) => s.status === "running"),
    });
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

export async function openProject(path: string): Promise<void> {
  const desktop = getDesktop();
  const res = (await desktop.openProject(path)) as { path: string };
  setState({ projectPath: res.path, lastError: null });
  const settings = (await desktop.getSettings()) as PublicSettings;
  setState({ settings });
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
      items: unknown[];
      changes: FileChange[];
    };
    // items from main are always []; renderer owns transcript.
    setState({
      changesBySession: {
        ...state.changesBySession,
        [sessionId]: res.changes ?? [],
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ lastError: message });
  }
}

/**
 * Fire-and-forget send. sessionStart/continue await the full turn in main,
 * so UI must drive from session:event / session:updated.
 */
export function sendMessage(text: string): void {
  const prompt = text.trim();
  if (!prompt) return;

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
    appendUserMessage(activeSessionId, prompt);
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

  // New session: stash prompt until session:updated / invoke resolves.
  pendingStartPrompt = prompt;
  void desktop
    .startSession(prompt, state.projectPath ?? undefined)
    .then((res) => {
      const { sessionId } = res as { sessionId: string };
      if (!state.activeSessionId) {
        setState({ activeSessionId: sessionId });
      }
      if (pendingStartPrompt) {
        appendUserMessage(sessionId, pendingStartPrompt);
        pendingStartPrompt = null;
      } else {
        // session:updated may have already applied it; ensure present
        appendUserMessage(sessionId, prompt);
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
  try {
    const desktop = getDesktop();
    void desktop.abortSession(id);
  } catch {
    // ignore
  }
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

/** Test helper — reset module state. */
export function __resetStoreForTests(): void {
  state = {
    projectPath: null,
    sessions: [],
    activeSessionId: null,
    itemsBySession: {},
    changesBySession: {},
    permissionRequest: null,
    cpaStatus: { state: "unknown" },
    settings: null,
    running: false,
    lastError: null,
  };
  pendingStartPrompt = null;
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
