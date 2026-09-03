import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "@claude-desktop/shared";
import type {
  AppSettings,
  Attachment,
  ChatItem,
  PermissionDecision,
  UserPrompt,
  UserPromptDecision,
} from "@claude-desktop/shared";

const desktop = {
  /** Omit path to open the native directory picker. */
  openProject: (path?: string) =>
    ipcRenderer.invoke(
      IPC.projectOpen,
      path !== undefined ? { path } : {},
    ) as Promise<{ path: string }>,

  startSession: (prompt: UserPrompt, cwd?: string) =>
    ipcRenderer.invoke(IPC.sessionStart, { prompt, cwd }) as Promise<{
      sessionId: string;
    }>,

  continueSession: (sessionId: string, prompt: UserPrompt) =>
    ipcRenderer.invoke(IPC.sessionContinue, { sessionId, prompt }) as Promise<{
      sessionId: string;
    }>,

  abortSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionAbort, { sessionId }) as Promise<{
      ok: boolean;
    }>,

  listSessions: () => ipcRenderer.invoke(IPC.sessionList),

  /** Full-text search over persisted session transcript content. */
  searchSessions: (query: string, limit?: number) =>
    ipcRenderer.invoke(IPC.sessionSearch, { query, limit }) as Promise<{
      results: import("@claude-desktop/shared").SessionSearchHit[];
    }>,

  setSessionPinned: (sessionId: string, pinned: boolean) =>
    ipcRenderer.invoke(IPC.sessionSetPinned, { sessionId, pinned }) as Promise<{
      ok: boolean;
      session?: import("@claude-desktop/shared").SessionSummary;
      error?: string;
    }>,

  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke(IPC.sessionRename, { sessionId, title }) as Promise<{
      ok: boolean;
      session?: import("@claude-desktop/shared").SessionSummary;
      error?: string;
    }>,

  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionDelete, { sessionId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  /** Browser-style drag-out: open this session in its own window. */
  openSessionWindow: (sessionId: string) =>
    ipcRenderer.invoke(IPC.windowOpenSession, { sessionId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  /** Double-click / drag-out: open this room in its own window. */
  openRoomWindow: (roomId: string) =>
    ipcRenderer.invoke(IPC.windowOpenRoom, { roomId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  selectSession: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke(IPC.sessionSelect, { sessionId, limit }) as Promise<{
      sessionId: string;
      cwd: string;
      items: ChatItem[];
      total: number;
      hasMore: boolean;
      hasNewer: boolean;
      changes: import("@claude-desktop/shared").FileChange[];
    }>,

  loadOlderMessages: (sessionId: string, beforeId: string, limit?: number) =>
    ipcRenderer.invoke(IPC.sessionLoadOlder, {
      sessionId,
      beforeId,
      limit,
    }) as Promise<{
      items: ChatItem[];
      total: number;
      hasMore: boolean;
      hasNewer: boolean;
    }>,

  loadNewerMessages: (sessionId: string, afterId: string, limit?: number) =>
    ipcRenderer.invoke(IPC.sessionLoadNewer, {
      sessionId,
      afterId,
      limit,
    }) as Promise<{
      items: ChatItem[];
      total: number;
      hasMore: boolean;
      hasNewer: boolean;
    }>,

  saveSessionTranscript: (
    sessionId: string,
    items: ChatItem[],
    replace?: boolean,
  ) =>
    ipcRenderer.invoke(IPC.sessionSaveTranscript, {
      sessionId,
      items,
      replace,
    }) as Promise<{ ok: boolean }>,

  getSessionSlashCommands: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionSlashCommands, { sessionId }) as Promise<{
      commands: import("@claude-desktop/shared").SlashCommandItem[];
    }>,

  getSessionMcpStatus: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionMcpStatus, { sessionId }) as Promise<{
      statuses: import("@claude-desktop/shared").SessionMcpServerStatus[] | null;
    }>,

  reconnectSessionMcpServer: (sessionId: string, name: string) =>
    ipcRenderer.invoke(IPC.sessionMcpReconnect, { sessionId, name }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  toggleSessionMcpServer: (sessionId: string, name: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.sessionMcpToggle, {
      sessionId,
      name,
      enabled,
    }) as Promise<{ ok: boolean; error?: string }>,

  setSessionMcpServers: (
    sessionId: string,
    servers: import("@claude-desktop/shared").McpServersMap,
  ) =>
    ipcRenderer.invoke(IPC.sessionMcpSetServers, { sessionId, servers }) as Promise<{
      ok: boolean;
      result?: import("@claude-desktop/shared").McpSetServersResultDto;
      error?: string;
    }>,

  /** Probe MCP servers without a running session (throwaway SDK query). */
  probeMcpServers: (servers?: import("@claude-desktop/shared").McpServersMap) =>
    ipcRenderer.invoke(IPC.mcpProbe, servers ? { servers } : {}) as Promise<{
      statuses: import("@claude-desktop/shared").SessionMcpServerStatus[];
    }>,

  /**
   * Restore a file to its content before one write operation (eventId) or,
   * without eventId, to its pre-session content.
   */
  restoreChange: (sessionId: string, path: string, eventId?: string) =>
    ipcRenderer.invoke(IPC.diffRestoreFile, {
      sessionId,
      path,
      ...(eventId ? { eventId } : {}),
    }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  /** Restore all changed files of a session to pre-session content. */
  restoreAllChanges: (sessionId: string) =>
    ipcRenderer.invoke(IPC.diffRestoreAll, { sessionId }) as Promise<{
      restored: string[];
      failed: string[];
    }>,

  /**
   * Rewind files + conversation to a user message (SDK checkpointing).
   * dryRun previews the file changes without touching disk.
   */
  rewindSession: (sessionId: string, userMessageId: string, dryRun?: boolean) =>
    ipcRenderer.invoke(IPC.sessionRewind, {
      sessionId,
      userMessageId,
      ...(dryRun ? { dryRun: true } : {}),
    }) as Promise<{
      ok: boolean;
      canRewind?: boolean;
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
      error?: string;
    }>,

  /** Open a file with the OS default editor. */
  openInEditor: (path: string) =>
    ipcRenderer.invoke(IPC.fileOpenInEditor, { path }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  /** Reveal a file in the OS file manager. */
  revealFile: (path: string) =>
    ipcRenderer.invoke(IPC.fileReveal, { path }) as Promise<{ ok: boolean }>,
  /** Read an image file as a data URL (chat attachment thumbnails). */
  readImageDataUrl: (path: string) =>
    ipcRenderer.invoke(IPC.fileImageData, { path }) as Promise<{
      ok: boolean;
      dataUrl?: string;
      error?: string;
    }>,

  /** Git status of a project directory (branch + changed paths). */
  gitStatus: (cwd: string) =>
    ipcRenderer.invoke(IPC.projectGitStatus, { cwd }) as Promise<{
      isRepo: boolean;
      branch?: string;
      changed?: string[];
    }>,

  compressSession: (
    sessionId: string,
    items?: ChatItem[],
    opts?: { autoContinue?: boolean },
  ) =>
    ipcRenderer.invoke(IPC.sessionCompress, {
      sessionId,
      ...(items ? { items } : {}),
      ...(opts?.autoContinue ? { autoContinue: true } : {}),
    }) as Promise<{
      ok: boolean;
      message?: string;
    }>,

  respondPermission: (requestId: string, decision: PermissionDecision) =>
    ipcRenderer.invoke(IPC.permissionRespond, {
      requestId,
      decision,
    }) as Promise<{ ok: boolean }>,

  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  readAttachment: (path: string) =>
    ipcRenderer.invoke(IPC.fileReadAttachment, { path }) as Promise<Attachment>,

  /** Persist a pasted clipboard image; returns the saved file's attachment. */
  saveClipboardImage: (dataBase64: string, mimeType: string) =>
    ipcRenderer.invoke(IPC.fileSaveClipboardImage, {
      dataBase64,
      mimeType,
    }) as Promise<Attachment>,

  selectFiles: () =>
    ipcRenderer.invoke(IPC.fileSelect) as Promise<{ paths: string[] }>,

  /** Enumerate project files for @-mention autocomplete (paths relative to cwd). */
  listProjectFiles: (cwd: string, query?: string, limit?: number) =>
    ipcRenderer.invoke(IPC.projectListFiles, { cwd, query, limit }) as Promise<{
      files: string[];
      truncated?: boolean;
    }>,

  /** List direct children of a project dir (file tree; "" = root). */
  listProjectDir: (cwd: string, rel?: string) =>
    ipcRenderer.invoke(IPC.projectListDir, { cwd, rel: rel ?? "" }) as Promise<{
      entries: Array<{ name: string; rel: string; kind: "dir" | "file" }>;
    }>,

  /** Read a project file as text (bounded). encoding: utf-8 | gbk | … */
  readProjectFile: (
    cwd: string,
    rel: string,
    maxBytes?: number,
    encoding?: string,
  ) =>
    ipcRenderer.invoke(IPC.fileReadText, {
      cwd,
      rel,
      maxBytes,
      encoding,
    }) as Promise<{
      ok: boolean;
      content?: string;
      truncated?: boolean;
      encoding?: string;
      error?: string;
    }>,

  /** Write a project file as text (full replace). encoding matches open mode. */
  writeProjectFile: (
    cwd: string,
    rel: string,
    content: string,
    encoding?: string,
  ) =>
    ipcRenderer.invoke(IPC.fileWriteText, {
      cwd,
      rel,
      content,
      encoding,
    }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  respondUserPrompt: (requestId: string, decision: UserPromptDecision) =>
    ipcRenderer.invoke(IPC.userPromptRespond, {
      requestId,
      decision,
    }) as Promise<{ ok: boolean }>,

  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),

  setSettings: (patch: Partial<AppSettings> & { token?: string }) =>
    ipcRenderer.invoke(IPC.settingsSet, patch),

  /** First-run: save gateway token + rewrite CPA config + start CPA. */
  completeOnboarding: (token: string, startCpa = true) =>
    ipcRenderer.invoke(IPC.appCompleteOnboarding, {
      token,
      startCpa,
    }) as Promise<{
      ok: boolean;
      settings: import("@claude-desktop/shared").PublicSettings;
      cpaStatus: import("@claude-desktop/shared").CpaStatus;
      error?: string;
    }>,

  startCpa: () => ipcRenderer.invoke(IPC.cpaStart),

  getCpaStatus: () => ipcRenderer.invoke(IPC.cpaStatus),

  syncCpaModels: () =>
    ipcRenderer.invoke(IPC.cpaSyncModels) as Promise<{
      models: string[];
      defaultModel: string;
    }>,

  getModelCatalog: () =>
    ipcRenderer.invoke(IPC.cpaModelCatalog) as Promise<
      import("@claude-desktop/shared").ModelInfo[]
    >,

  getModelQuota: (model: string) =>
    ipcRenderer.invoke(IPC.cpaModelQuota, { model }) as Promise<
      import("@claude-desktop/shared").ModelQuotaInfo | null
    >,

  setModel: (model: string) =>
    ipcRenderer.invoke(IPC.modelSet, { model }) as Promise<{ model: string }>,

  createTerminal: (cwd?: string) =>
    ipcRenderer.invoke(
      IPC.terminalCreate,
      cwd !== undefined ? { cwd } : {},
    ) as Promise<{ id: string; cwd: string; shell: string }>,

  attachCliSession: (sessionId?: string | null) =>
    ipcRenderer.invoke(
      IPC.sessionAttachCli,
      sessionId !== undefined ? { sessionId } : {},
    ) as Promise<{
      ok: boolean;
      id?: string;
      cwd?: string;
      shell?: string;
      sdkSessionId?: string;
      error?: string;
    }>,

  writeTerminal: (id: string, data: string) =>
    ipcRenderer.invoke(IPC.terminalWrite, { id, data }) as Promise<{
      ok: boolean;
    }>,

  killTerminal: (id: string) =>
    ipcRenderer.invoke(IPC.terminalKill, { id }) as Promise<{ ok: boolean }>,

  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.terminalResize, { id, cols, rows }) as Promise<{
      ok: boolean;
    }>,

  /** Tell the main process the effective UI theme (window chrome sync). */
  notifyTheme: (theme: "dark" | "light") =>
    ipcRenderer.invoke(IPC.appThemeChanged, { theme }) as Promise<{
      ok: boolean;
    }>,

  getMemoryDiagnostics: () =>
    ipcRenderer.invoke(IPC.appMemoryDiagnostics) as Promise<
      import("@claude-desktop/shared").AppMemoryDiagnostics
    >,

  /** Hot update: current status / check / download / quit-and-install */
  getUpdateStatus: () =>
    ipcRenderer.invoke(IPC.appUpdateGetStatus) as Promise<
      import("@claude-desktop/shared").UpdateStatusDto
    >,
  checkForUpdate: () =>
    ipcRenderer.invoke(IPC.appUpdateCheck) as Promise<
      import("@claude-desktop/shared").UpdateStatusDto
    >,
  downloadUpdate: () =>
    ipcRenderer.invoke(IPC.appUpdateDownload) as Promise<
      import("@claude-desktop/shared").UpdateStatusDto
    >,
  installUpdate: () =>
    ipcRenderer.invoke(IPC.appUpdateInstall) as Promise<{ ok: boolean }>,
  getAppVersion: () =>
    ipcRenderer.invoke(IPC.appGetVersion) as Promise<{ version: string }>,

  createRoom: (opts: {
    name: string;
    password?: string;
    port?: number;
    requireMods?: boolean;
    autoApprove?: boolean;
    encrypt?: boolean;
    /** Public wss:// endpoint (T1/T2) — goes into the invite; forces encrypt. */
    publicWss?: string;
    /** Cloudflare tunnel (T2) — forces encrypt; failure keeps the LAN room. */
    tunnel?: boolean;
    /** Self-hosted relay (ws:// or wss://) — forces encrypt; failure keeps the LAN room. */
    relay?: string;
    /** Optional auth token matching the relay's --token. */
    relayToken?: string;
  }) =>
    ipcRenderer.invoke(IPC.roomCreate, opts) as Promise<{
      ok: boolean;
      room?: import("@claude-desktop/shared").RoomSnapshot;
      error?: string;
    }>,
  joinRoom: (opts: {
    host: string;
    port: number;
    password?: string;
    name?: string;
    modChecksum?: string;
    hosts?: string[];
    wss?: string[];
    hostFingerprint?: string;
  }) =>
    ipcRenderer.invoke(IPC.roomJoin, opts) as Promise<{
      ok: boolean;
      room?: import("@claude-desktop/shared").RoomSnapshot;
      error?: string;
    }>,
  leaveRoom: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomLeave, { roomId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  endRoom: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomEnd, { roomId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  listRooms: () =>
    ipcRenderer.invoke(IPC.roomList) as Promise<{
      rooms: import("@claude-desktop/shared").RoomListItem[];
    }>,
  getRoom: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomGet, { roomId }) as Promise<{
      room: import("@claude-desktop/shared").RoomSnapshot | null;
    }>,
  addRoomSeat: (
    roomId: string,
    kind: import("@claude-desktop/shared").RoomSeatKind,
    name: string,
    agentName?: string,
    extra?: {
      agentPrompt?: string;
      skillNames?: string[];
      model?: string;
      executorUserId?: string;
      aiUserId?: string;
      workspaceUserId?: string;
    },
  ) =>
    ipcRenderer.invoke(IPC.roomAddSeat, {
      roomId,
      kind,
      name,
      agentName,
      ...extra,
    }) as Promise<{
      ok: boolean;
      room?: import("@claude-desktop/shared").RoomSnapshot;
      error?: string;
    }>,
  updateRoomSeat: (
    roomId: string,
    seatId: string,
    patch: {
      name?: string;
      agentName?: string;
      agentPrompt?: string;
      skillNames?: string[];
      model?: string;
      executorUserId?: string;
      aiUserId?: string;
      workspaceUserId?: string;
    },
  ) =>
    ipcRenderer.invoke(IPC.roomUpdateSeat, {
      roomId,
      seatId,
      ...patch,
    }) as Promise<{
      ok: boolean;
      room?: import("@claude-desktop/shared").RoomSnapshot;
      error?: string;
    }>,
  takeoverSeat: (roomId: string, seatId: string) =>
    ipcRenderer.invoke(IPC.roomTakeover, { roomId, seatId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  returnSeat: (roomId: string, seatId: string) =>
    ipcRenderer.invoke(IPC.roomReturnSeat, { roomId, seatId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  sendRoomMessage: (
    roomId: string,
    seatId: string,
    text: string,
    quote?: import("@claude-desktop/shared").RoomQuoteRef,
    attachments?: import("@claude-desktop/shared").Attachment[],
  ) =>
    ipcRenderer.invoke(IPC.roomSend, { roomId, seatId, text, quote, attachments }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  rejoinRoom: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomRejoin, { roomId }) as Promise<{
      ok: boolean;
      room?: import("@claude-desktop/shared").RoomSnapshot;
      error?: string;
    }>,
  approveRoomDevice: (roomId: string, fingerprint: string) =>
    ipcRenderer.invoke(IPC.roomApproveDevice, { roomId, fingerprint }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  denyRoomDevice: (roomId: string, fingerprint: string) =>
    ipcRenderer.invoke(IPC.roomDenyDevice, { roomId, fingerprint }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  kickRoomMember: (roomId: string, userId: string) =>
    ipcRenderer.invoke(IPC.roomKick, { roomId, userId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  setRoomMemberRole: (
    roomId: string,
    userId: string,
    role: "admin" | "member",
  ) =>
    ipcRenderer.invoke(IPC.roomSetMemberRole, { roomId, userId, role }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  setRoomFilePolicy: (
    roomId: string,
    policy: import("@claude-desktop/shared").RoomFilePolicy,
  ) =>
    ipcRenderer.invoke(IPC.roomSetFilePolicy, { roomId, policy }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  setRoomAiShare: (roomId: string, on: boolean) =>
    ipcRenderer.invoke(IPC.roomSetAiShare, { roomId, on }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  askRoomAiShare: (roomId: string, targetUserId: string, seatId?: string) =>
    ipcRenderer.invoke(IPC.roomAskAiShare, {
      roomId,
      targetUserId,
      seatId,
    }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  /** 房间远程执行的本机审批：允许 / 拒绝（对应 room:perm-ask 弹窗）。 */
  respondRoomPermAsk: (requestId: string, allow: boolean) =>
    ipcRenderer.invoke(IPC.roomPermRespond, { requestId, allow }) as Promise<{
      ok: boolean;
    }>,
  renameRoom: (roomId: string, name: string) =>
    ipcRenderer.invoke(IPC.roomRename, { roomId, name }) as Promise<{
      ok: boolean;
      room?: import("@claude-desktop/shared").RoomSnapshot;
      error?: string;
    }>,
  recallRoomMessage: (roomId: string, itemId: string) =>
    ipcRenderer.invoke(IPC.roomRecall, { roomId, itemId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  stopRoomSeat: (roomId: string, seatId: string) =>
    ipcRenderer.invoke(IPC.roomSeatStop, { roomId, seatId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  listRoomPending: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomPending, { roomId }) as Promise<{
      ok: boolean;
      pending: Array<{ fp: string; name: string }>;
    }>,
  /** Debug: current process room transport counters (read-only). */
  getRoomMetrics: () =>
    ipcRenderer.invoke(IPC.roomMetrics) as Promise<{
      ok: boolean;
      snapshot?: import("@claude-desktop/shared").RoomMetricsSnapshot;
    }>,
  roomDice: (roomId: string, seatId: string) =>
    ipcRenderer.invoke(IPC.roomDice, { roomId, seatId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  roomRps: (roomId: string, seatId: string, hand: "rock" | "scissors" | "paper") =>
    ipcRenderer.invoke(IPC.roomRps, { roomId, seatId, hand }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  getRoomInvite: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomInvite, { roomId }) as Promise<{
      ok: boolean;
      host?: string;
      hosts?: string[];
      port?: number;
      password?: string;
      modChecksum?: string;
      hostFingerprint?: string;
      listening?: boolean;
      secret?: string;
      error?: string;
    }>,
  deleteRoom: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomDelete, { roomId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  peekRoom: (opts: {
    host: string;
    port: number;
    hosts?: string[];
    wss?: string[];
  }) =>
    ipcRenderer.invoke(IPC.roomPeek, opts) as Promise<{
      ok: boolean;
      offer?: import("@claude-desktop/shared").ModOfferPayload;
      error?: string;
    }>,
  fetchRoomMod: (opts: {
    host: string;
    port: number;
    checksum: string;
    password?: string;
    hostFingerprint?: string;
    hosts?: string[];
    wss?: string[];
  }) =>
    ipcRenderer.invoke(IPC.roomFetchMod, opts) as Promise<{
      ok: boolean;
      checksum?: string;
      offer?: import("@claude-desktop/shared").ModOfferPayload;
      error?: string;
    }>,
  enableRoomMod: (roomId: string, packDir: string) =>
    ipcRenderer.invoke(IPC.roomEnableMod, { roomId, packDir }) as Promise<{
      ok: boolean;
      room?: import("@claude-desktop/shared").RoomSnapshot;
      offer?: import("@claude-desktop/shared").ModOfferPayload;
      error?: string;
    }>,
  startRoomMod: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomStartMod, { roomId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  endRoomMod: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomEndMod, { roomId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  resetRoomMod: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomResetMod, { roomId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  recoverRoomMod: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomRecoverMod, { roomId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  sendRoomModIntent: (
    roomId: string,
    seatId: string,
    name: string,
    payload?: unknown,
  ) =>
    ipcRenderer.invoke(IPC.roomModIntent, {
      roomId,
      seatId,
      name,
      payload,
    }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  listRoomMods: () =>
    ipcRenderer.invoke(IPC.roomListMods) as Promise<{
      mods: Array<{
        id: string;
        name: string;
        version: string;
        checksum: string;
        packDir: string;
        source: "bundled" | "cache";
        hostApi?: 1 | 2;
      }>;
    }>,
  modsDelete: (packDir: string) =>
    ipcRenderer.invoke(IPC.modsDelete, { packDir }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  modsOpenDir: (packDir: string) =>
    ipcRenderer.invoke(IPC.modsOpenDir, { packDir }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  modsScaffold: (input: { id: string; name: string }) =>
    ipcRenderer.invoke(IPC.modsScaffold, input) as Promise<{
      ok: boolean;
      packDir?: string;
      error?: string;
    }>,
  enableRoomKernelMod: (roomId: string, packDir: string) =>
    ipcRenderer.invoke(IPC.roomEnableKernelMod, { roomId, packDir }) as Promise<{
      ok: boolean;
      room?: import("@claude-desktop/shared").RoomSnapshot;
      error?: string;
    }>,
  disableRoomKernelMod: (roomId: string, id: string) =>
    ipcRenderer.invoke(IPC.roomDisableKernelMod, { roomId, id }) as Promise<{
      ok: boolean;
      room?: import("@claude-desktop/shared").RoomSnapshot;
      error?: string;
    }>,
  listRoomKernelMemory: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomListKernelMemory, { roomId }) as Promise<{
      ok: boolean;
      entries?: Array<{ key: string; value: string }>;
      error?: string;
    }>,
  setRoomKernelMemory: (roomId: string, key: string, value: string) =>
    ipcRenderer.invoke(IPC.roomSetKernelMemory, { roomId, key, value }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  deleteRoomKernelMemory: (roomId: string, key: string) =>
    ipcRenderer.invoke(IPC.roomDeleteKernelMemory, { roomId, key }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  setRoomKernelAutonomy: (roomId: string, level: 0 | 1 | 2) =>
    ipcRenderer.invoke(IPC.roomSetKernelAutonomy, { roomId, level }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  getRoomKernelImprove: (roomId: string) =>
    ipcRenderer.invoke(IPC.roomGetKernelImprove, { roomId }) as Promise<{
      ok: boolean;
      autonomy?: 0 | 1 | 2;
      proposals?: Array<{
        id: string;
        packId: string;
        modJs: string;
        at: number;
        note?: string;
        status: "pending" | "applied" | "rejected" | "failed";
        decision: "pending" | "apply" | "reject";
        error?: string;
      }>;
      canRollback?: string[];
      error?: string;
    }>,
  proposeRoomKernelImprove: (roomId: string, packId: string, modJs: string, note?: string) =>
    ipcRenderer.invoke(IPC.roomProposeKernelImprove, {
      roomId,
      packId,
      modJs,
      note,
    }) as Promise<{
      ok: boolean;
      decision?: string;
      status?: string;
      error?: string;
    }>,
  applyRoomKernelProposal: (roomId: string, proposalId: string) =>
    ipcRenderer.invoke(IPC.roomApplyKernelProposal, { roomId, proposalId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  rejectRoomKernelProposal: (roomId: string, proposalId: string) =>
    ipcRenderer.invoke(IPC.roomRejectKernelProposal, { roomId, proposalId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  rollbackRoomKernelImprove: (roomId: string, packId: string) =>
    ipcRenderer.invoke(IPC.roomRollbackKernelImprove, { roomId, packId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  hasRoomMod: (checksum: string) =>
    ipcRenderer.invoke(IPC.roomHasMod, { checksum }) as Promise<{
      ok: boolean;
      has: boolean;
    }>,

  /** List installed skills (user + project scope). */
  listSkills: () =>
    ipcRenderer.invoke(IPC.skillsList) as Promise<{
      userDir: string;
      projectDir: string | null;
      skills: Array<{ name: string; scope: "user" | "project"; path: string }>;
    }>,

  /** Open the skills directory (created if missing) in the file manager. */
  openSkillsDir: (scope: "user" | "project") =>
    ipcRenderer.invoke(IPC.skillsOpenDir, { scope }) as Promise<{
      ok: boolean;
      path?: string;
      error?: string;
    }>,

  deleteSkill: (name: string, scope: "user" | "project") =>
    ipcRenderer.invoke(IPC.skillsDelete, { name, scope }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  /** Reload skills in the running session after install/remove. */
  reloadSkills: (sessionId: string) =>
    ipcRenderer.invoke(IPC.skillsReload, { sessionId }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const allowed = new Set<string>(Object.values(IPC));
    if (!allowed.has(channel)) return () => {};
    const handler = (_: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);

export type DesktopApi = typeof desktop;
