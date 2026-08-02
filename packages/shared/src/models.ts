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
    tool: "Edit" | "Write";
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
};

export type ChatItem =
  | { kind: "text"; id: string; role: ChatRole; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; tool: ToolCardState };

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
  | { type: "user_message"; sessionId: string; text: string }
  | { type: "result"; sessionId: string; ok: boolean; costUsd?: number; error?: string }
  | { type: "raw"; sessionId: string; payload: unknown };
