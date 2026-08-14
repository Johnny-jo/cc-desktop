export const en = {
  common: {
    ok: "OK",
    cancel: "Cancel",
    save: "Save",
    close: "Close",
    delete: "Delete",
    confirm: "Confirm",
    loading: "Loading…",
    error: "Error",
    copy: "Copy",
    copied: "Copied",
  },
  settings: {
    title: "Settings",
    language: "Language",
    languageSystem: "Follow system",
    theme: "Theme",
    themeDark: "Dark",
    themeLight: "Light",
    themeSystem: "Follow system",
    save: "Save",
    saving: "Saving…",
    saved: "Saved",
    basic: "Basic",
    advanced: "Advanced",
  },
  sidebar: {
    newChat: "New chat",
    recent: "Recent",
    noSessions: "No sessions yet",
    openFolder: "Open folder",
    files: "Files",
    showMore: "Show more",
  },
  chat: {
    composerPlaceholder: "Message…  (type / for commands, drop files)",
    composerPlaceholderNew: "Start a new session…  (type / for commands, drop files)",
    composerNoProject: "Open a project first, then type a message…",
    stop: "Stop",
    send: "Send",
    queue: "Queue",
    empty: "Select a session or start a new one",
    loadOlder: "Load older messages",
  },
  changes: {
    title: "Changes",
    empty: "No file changes yet",
    restoreAll: "Restore all",
    showMore: "Show more",
  },
  cli: {
    backToDesktop: "Back to desktop",
    resumed: "Claude Code · session attached",
    newSession: "Claude Code",
    startError: "Failed to start Claude Code TUI",
  },
  room: {
    title: "Rooms",
    create: "Create room",
    join: "Join room",
    leave: "Leave",
    invite: "Invite",
  },
  onboarding: {
    title: "Welcome",
    welcomeLead:
      "This app is an unofficial desktop shell that drives Claude Code via the public SDK, with a local CPA gateway.",
  },
};

type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};

export type Messages = DeepStringify<typeof en>;
