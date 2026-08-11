import type {
  AppSettings,
  Attachment,
  CpaStatus,
  FileChange,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PublicSettings,
  SdkNormalizedEvent,
  SessionSummary,
  SlashCommandItem,
  UserPromptDecision,
  UserPromptRequest,
  UserPrompt,
} from "./models";

export const IPC = {
  projectOpen: "project:open",
  /** Renderer → Main: read file metadata for an attachment (does not return content) */
  fileReadAttachment: "file:read-attachment",
  /** Renderer → Main: show native file picker and return selected paths */
  fileSelect: "file:select",
  /** Renderer → Main: enumerate project files for @-mention autocomplete */
  projectListFiles: "project:list-files",
  sessionStart: "session:start",
  sessionContinue: "session:continue",
  sessionAbort: "session:abort",
  sessionList: "session:list",
  sessionSelect: "session:select",
  sessionSaveTranscript: "session:save-transcript",
  sessionCompress: "session:compress",
  permissionRespond: "permission:respond",
  userPromptRespond: "user-prompt:respond",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  cpaStart: "cpa:start",
  cpaStatus: "cpa:status",
  /** Fetch model ids from CPA /v1/models and merge into settings */
  cpaSyncModels: "cpa:sync-models",
  /** Read-only cached CPA model catalog (ids + contextLimit) */
  cpaModelCatalog: "cpa:model-catalog",
  modelSet: "model:set",
  /** SDK skills / slash commands for a live session */
  sessionSlashCommands: "session:slash-commands",
  /** Live MCP server connection status for a running session */
  sessionMcpStatus: "session:mcp-status",
  /** Reconnect a failed/disconnected MCP server in a running session */
  sessionMcpReconnect: "session:mcp-reconnect",
  /** Enable or disable an MCP server in a running session */
  sessionMcpToggle: "session:mcp-toggle",
  /** Replace the session's dynamic MCP servers; also persists to settings */
  sessionMcpSetServers: "session:mcp-set-servers",
  /** Probe MCP servers without a running session (spawns a throwaway query) */
  mcpProbe: "mcp:probe",
  /** Restore one changed file to its pre-session content */
  diffRestoreFile: "diff:restore-file",
  /** Restore all changed files of a session */
  diffRestoreAll: "diff:restore-all",
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
  [IPC.fileReadAttachment]: {
    args: [{ path: string }];
    result: Attachment;
  };
  [IPC.fileSelect]: {
    args: [];
    result: { paths: string[] };
  };
  [IPC.projectListFiles]: {
    /** cwd must be the open project or an active session cwd; query filters by substring */
    args: [{ cwd: string; query?: string; limit?: number }];
    /** paths relative to cwd; truncated=true when the index hit a cap */
    result: { files: string[]; truncated?: boolean };
  };
  [IPC.sessionStart]: {
    args: [{ prompt: UserPrompt; cwd?: string }];
    result: { sessionId: string };
  };
  [IPC.sessionContinue]: {
    args: [{ sessionId: string; prompt: UserPrompt }];
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
  [IPC.sessionCompress]: {
    /**
     * Prefer passing renderer items — disk archive can lag the live transcript.
     * autoContinue: after compact, immediately resume the last task (Claude Code style).
     */
    args: [
      {
        sessionId: string;
        items?: import("./models").ChatItem[];
        autoContinue?: boolean;
      },
    ];
    result: { ok: boolean; message?: string };
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
  [IPC.cpaModelCatalog]: {
    args: [];
    result: ModelInfo[];
  };
  [IPC.modelSet]: { args: [{ model: string }]; result: { model: string } };
  [IPC.sessionSlashCommands]: {
    args: [{ sessionId: string }];
    result: { commands: SlashCommandItem[] };
  };
  [IPC.sessionMcpStatus]: {
    args: [{ sessionId: string }];
    result: {
      statuses: import("./mcp-servers").SessionMcpServerStatus[] | null;
    };
  };
  [IPC.sessionMcpReconnect]: {
    args: [{ sessionId: string; name: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.sessionMcpToggle]: {
    args: [{ sessionId: string; name: string; enabled: boolean }];
    result: { ok: boolean; error?: string };
  };
  [IPC.sessionMcpSetServers]: {
    args: [
      {
        sessionId: string;
        servers: import("./mcp-servers").McpServersMap;
      },
    ];
    result: {
      ok: boolean;
      result?: import("./mcp-servers").McpSetServersResultDto;
      error?: string;
    };
  };
  [IPC.mcpProbe]: {
    /** Servers to probe; when omitted, probes all servers in settings */
    args: [{ servers?: import("./mcp-servers").McpServersMap }?];
    result: { statuses: import("./mcp-servers").SessionMcpServerStatus[] };
  };
  [IPC.diffRestoreFile]: {
    args: [{ sessionId: string; path: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.diffRestoreAll]: {
    args: [{ sessionId: string }];
    result: { restored: string[]; failed: string[] };
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
