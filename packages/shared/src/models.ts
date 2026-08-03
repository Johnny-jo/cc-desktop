export type PermissionMode = "default" | "acceptEdits" | "plan";

export type CpaStatus =
  | { state: "unknown" }
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; port: number; managedByApp: boolean }
  | { state: "error"; message: string };

export type FileChangeStatus = "A" | "M";

export type FileChange = {
  path: string;
  status: FileChangeStatus;
  /** unified diff text for display */
  hunks: string;
  updatedAt: number;
  /** event-level entries newest last */
  events: Array<{
    tool: "Edit" | "Write" | "Bash";
    at: number;
    hunk: string;
  }>;
};

export type ChatRole = "user" | "assistant" | "system";

export type ToolCardState = {
  id: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
  resultPreview?: string;
  /** Elapsed seconds while running (from tool_progress heartbeats) */
  elapsedSeconds?: number;
};

export type ChatItem =
  | { kind: "text"; id: string; role: ChatRole; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; tool: ToolCardState };

/** App-local slash command (composer `/` menu) */
export type SlashCommandItem = {
  name: string;
  description: string;
  /** If true, insert as text and send; else handled by app */
  sendAsPrompt?: boolean;
};

/**
 * Blocking prompt from agent/SDK: MCP elicitation or user dialog.
 * Distinct from tool permission (PermissionRequest).
 */
export type UserPromptRequest = {
  requestId: string;
  sessionId: string;
  kind: "elicitation" | "dialog";
  title: string;
  message: string;
  /** form fields schema (elicitation form mode) */
  schema?: Record<string, unknown>;
  /** url mode */
  url?: string;
  dialogKind?: string;
  payload?: Record<string, unknown>;
};

export type UserPromptDecision =
  | { behavior: "accept"; content?: Record<string, unknown>; result?: unknown }
  | { behavior: "decline" | "cancel"; message?: string };

export type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  status: "idle" | "running" | "error";
};

export type PermissionRequest = {
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  inputPreview: unknown;
};

export type PermissionDecision =
  | { behavior: "allow"; scope: "once" | "session" }
  | { behavior: "deny"; message?: string };

export type AppSettings = {
  cpaExePath: string;
  cpaConfigPath: string;
  cpaPort: number;
  /** token never sent to renderer in getPublicSettings */
  defaultModel: string;
  models: string[];
  permissionMode: PermissionMode;
  shutdownCpaOnQuit: boolean;
  lastProjectPath?: string;
};

export type PublicSettings = Omit<AppSettings, never> & {
  hasToken: boolean;
};

export type SdkNormalizedEvent =
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "text_done"; sessionId: string; text: string }
  | { type: "tool_start"; sessionId: string; tool: ToolCardState }
  | { type: "tool_end"; sessionId: string; tool: ToolCardState }
  | {
      type: "tool_progress";
      sessionId: string;
      toolUseId: string;
      toolName: string;
      elapsedSeconds: number;
    }
  | { type: "user_message"; sessionId: string; text: string }
  | { type: "result"; sessionId: string; ok: boolean; costUsd?: number; error?: string }
  | { type: "raw"; sessionId: string; payload: unknown };
