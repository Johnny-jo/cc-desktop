import type {
  AppSettings,
  CpaStatus,
  FileChange,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PublicSettings,
  SdkNormalizedEvent,
  SessionSummary,
  SlashCommandItem,
  UserPromptDecision,
  UserPromptRequest,
} from "./models";

export const IPC = {
  projectOpen: "project:open",
  sessionStart: "session:start",
  sessionContinue: "session:continue",
  sessionAbort: "session:abort",
  sessionList: "session:list",
  sessionSelect: "session:select",
  sessionSaveTranscript: "session:save-transcript",
  permissionRespond: "permission:respond",
  userPromptRespond: "user-prompt:respond",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  cpaStart: "cpa:start",
  cpaStatus: "cpa:status",
  /** Fetch model ids from CPA /v1/models and merge into settings */
  cpaSyncModels: "cpa:sync-models",
  modelSet: "model:set",
  /** SDK skills / slash commands for a live session */
  sessionSlashCommands: "session:slash-commands",
  // main → renderer (webContents.send)
  sessionEvent: "session:event",
  permissionRequest: "permission:request",
  userPromptRequest: "user-prompt:request",
  diffUpdated: "diff:updated",
  cpaStatusEvent: "cpa:status-event",
  sessionUpdated: "session:updated",
  sessionSlashCommandsEvent: "session:slash-commands-event",
  appError: "app:error",
} as const;

export type IpcInvokeMap = {
  /** path optional: omit to show native openDirectory dialog */
  [IPC.projectOpen]: {
    args: [{ path?: string }?];
    result: { path: string };
  };
  [IPC.sessionStart]: {
    args: [{ prompt: string; cwd?: string }];
    result: { sessionId: string };
  };
  [IPC.sessionContinue]: {
    args: [{ sessionId: string; prompt: string }];
    result: { sessionId: string };
  };
  [IPC.sessionAbort]: { args: [{ sessionId: string }]; result: { ok: boolean } };
  [IPC.sessionList]: { args: []; result: SessionSummary[] };
  [IPC.sessionSelect]: {
    args: [{ sessionId: string }];
    result: {
      sessionId: string;
      cwd: string;
      items: import("./models").ChatItem[];
      changes: FileChange[];
    };
  };
  /** Persist renderer transcript for a session (debounced by UI) */
  sessionSaveTranscript: {
    args: [
      {
        sessionId: string;
        items: import("./models").ChatItem[];
      },
    ];
    result: { ok: boolean };
  };
  [IPC.permissionRespond]: {
    args: [{ requestId: string; decision: PermissionDecision }];
    result: { ok: boolean };
  };
  [IPC.userPromptRespond]: {
    args: [{ requestId: string; decision: UserPromptDecision }];
    result: { ok: boolean };
  };
  [IPC.settingsGet]: { args: []; result: PublicSettings };
  [IPC.settingsSet]: {
    args: [Partial<AppSettings> & { token?: string }];
    result: PublicSettings;
  };
  [IPC.cpaStart]: { args: []; result: CpaStatus };
  [IPC.cpaStatus]: { args: []; result: CpaStatus };
  [IPC.cpaSyncModels]: {
    args: [];
    result: { models: string[]; defaultModel: string };
  };
  [IPC.modelSet]: { args: [{ model: string }]; result: { model: string } };
  [IPC.sessionSlashCommands]: {
    args: [{ sessionId: string }];
    result: { commands: SlashCommandItem[] };
  };
};

export type IpcEventMap = {
  [IPC.sessionEvent]: SdkNormalizedEvent;
  [IPC.permissionRequest]: PermissionRequest;
  [IPC.userPromptRequest]: UserPromptRequest;
  [IPC.diffUpdated]: { sessionId: string; changes: FileChange[] };
  [IPC.cpaStatusEvent]: CpaStatus;
  [IPC.sessionUpdated]: SessionSummary;
  [IPC.sessionSlashCommandsEvent]: {
    sessionId: string;
    commands: SlashCommandItem[];
  };
  [IPC.appError]: { message: string; detail?: string };
  // also permission mode can piggyback via settings
  permissionMode?: PermissionMode;
};
