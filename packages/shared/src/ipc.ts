import type {
  AppSettings,
  Attachment,
  CpaStatus,
  FileChange,
  ModelInfo,
  ModelQuotaInfo,
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
  sessionLoadOlder: "session:load-older",
  sessionLoadNewer: "session:load-newer",
  sessionSaveTranscript: "session:save-transcript",
  sessionCompress: "session:compress",
  /** Pin / unpin a session to the top of the sidebar list */
  sessionSetPinned: "session:set-pinned",
  /** Rename a session title */
  sessionRename: "session:rename",
  /** Delete a session and its transcript/changes files */
  sessionDelete: "session:delete",
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
  /** Read CPA's real, passively observed provider quota for one model. */
  cpaModelQuota: "cpa:model-quota",
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
  /** Rewind files + conversation to a user message (SDK checkpointing) */
  sessionRewind: "session:rewind",
  /** Open a file in the OS default editor */
  fileOpenInEditor: "file:open-in-editor",
  /** Reveal a file in the OS file manager */
  fileReveal: "file:reveal",
  /** Renderer → Main: read an image file as a data URL (for chat thumbnails) */
  fileImageData: "file:image-data",
  /** Git status for the current project (branch + changed paths) */
  projectGitStatus: "project:git-status",
  /**
   * First-run onboarding: set gateway token, rewrite CPA config api-keys,
   * optionally start CPA.
   */
  appCompleteOnboarding: "app:complete-onboarding",
  /** Renderer → Main: current UI theme changed (sync window chrome) */
  appThemeChanged: "app:theme-changed",
  /** Read-only process and bounded-cache memory diagnostics snapshot. */
  appMemoryDiagnostics: "app:memory-diagnostics",
  /** List installed skills (user dir + project dir) */
  skillsList: "skills:list",
  /** Open the user skills directory in the OS file manager */
  skillsOpenDir: "skills:open-dir",
  /** Delete an installed skill directory */
  skillsDelete: "skills:delete",
  /** Reload skills in the running session (Query.reloadSkills) */
  skillsReload: "skills:reload",
  /** List direct children of a project directory (file tree, lazy) */
  projectListDir: "project:list-dir",
  /** Read a project file as text (editor panel) */
  fileReadText: "file:read-text",
  /** Write a project file as text (editor panel save) */
  fileWriteText: "file:write-text",
  /** Bottom terminal: create shell in project cwd */
  terminalCreate: "terminal:create",
  /** CLI mode: release desktop SDK stream and spawn real `claude` TUI */
  sessionAttachCli: "session:attach-cli",
  terminalWrite: "terminal:write",
  terminalKill: "terminal:kill",
  /** Renderer → Main: resize PTY to match xterm grid */
  terminalResize: "terminal:resize",
  /** Open a session in its own detached window (browser-style drag-out) */
  windowOpenSession: "window:open-session",
  /** Open a room in its own detached window (double-click / drag-out) */
  windowOpenRoom: "window:open-room",
  // main → renderer (webContents.send)
  sessionEvent: "session:event",
  permissionRequest: "permission:request",
  userPromptRequest: "user-prompt:request",
  diffUpdated: "diff:updated",
  cpaStatusEvent: "cpa:status-event",
  settingsUpdated: "settings:updated",
  sessionUpdated: "session:updated",
  sessionSlashCommandsEvent: "session:slash-commands-event",
  appError: "app:error",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  /** Shell-reported window title (OSC 0/2) */
  terminalTitle: "terminal:title",
  /** Auto-update (electron-updater) */
  appUpdateCheck: "app:update-check",
  appUpdateDownload: "app:update-download",
  appUpdateInstall: "app:update-install",
  appUpdateGetStatus: "app:update-get-status",
  /** Current packaged app version (electron-updater compares against this) */
  appGetVersion: "app:get-version",
  /** main → renderer status push */
  appUpdateStatus: "app:update-status",
  /** LAN Room (host / guest) */
  roomCreate: "room:create",
  roomJoin: "room:join",
  roomLeave: "room:leave",
  roomEnd: "room:end",
  roomList: "room:list",
  roomGet: "room:get",
  roomAddSeat: "room:add-seat",
  roomUpdateSeat: "room:update-seat",
  roomTakeover: "room:takeover",
  roomReturnSeat: "room:return-seat",
  roomSend: "room:send",
  roomDice: "room:dice",
  roomRps: "room:rps",
  roomInvite: "room:invite",
  roomDelete: "room:delete",
  roomPeek: "room:peek",
  roomFetchMod: "room:fetch-mod",
  roomEnableMod: "room:enable-mod",
  roomStartMod: "room:start-mod",
  roomEndMod: "room:end-mod",
  roomResetMod: "room:reset-mod",
  roomRecoverMod: "room:recover-mod",
  roomModIntent: "room:mod-intent",
  roomListMods: "room:list-mods",
  roomHasMod: "room:has-mod",
  roomEnableKernelMod: "room:enable-kernel-mod",
  roomDisableKernelMod: "room:disable-kernel-mod",
  roomListKernelMemory: "room:list-kernel-memory",
  roomSetKernelMemory: "room:set-kernel-memory",
  roomDeleteKernelMemory: "room:delete-kernel-memory",
  roomSetKernelAutonomy: "room:set-kernel-autonomy",
  roomGetKernelImprove: "room:get-kernel-improve",
  roomProposeKernelImprove: "room:propose-kernel-improve",
  roomApplyKernelProposal: "room:apply-kernel-proposal",
  roomRejectKernelProposal: "room:reject-kernel-proposal",
  roomRollbackKernelImprove: "room:rollback-kernel-improve",
  roomEvent: "room:event",
  /** Rejoin a room the guest dropped from (uses stored join info) */
  roomRejoin: "room:rejoin",
  /** Host approval flow (task 8): approve / deny a pending device */
  roomApproveDevice: "room:approve-device",
  roomDenyDevice: "room:deny-device",
  /** Host kicks a member: drop connection, blacklist device fingerprint */
  roomKick: "room:kick",
  roomSetMemberRole: "room:set-member-role",
  roomSetFilePolicy: "room:set-file-policy",
  roomSetAiShare: "room:set-ai-share",
  roomAskAiShare: "room:ask-ai-share",
  /** Workspace owner's machine asks its local user to approve a room turn
   *  (filePolicy = ask); response comes back via roomPermRespond. */
  roomPermAsk: "room:perm-ask",
  roomPermRespond: "room:perm-respond",
  /** Host renames the room (name lives in the snapshot, broadcast to all) */
  roomRename: "room:rename",
  /** Recall a timeline message (own messages; host can recall any) */
  roomRecall: "room:recall",
  /** @agent /stop：停止席位正在跑的输出（本机/远程席位都走这里）。 */
  roomSeatStop: "room:seat-stop",
  /** Host: list devices waiting for approval */
  roomPending: "room:pending",
  /** Debug: current process room transport counters (task 12) */
  roomMetrics: "room:metrics",
  /** Mod pack management (outside a live room) */
  modsDelete: "mods:delete",
  modsOpenDir: "mods:open-dir",
  modsScaffold: "mods:scaffold",
} as const;

export type AppMemoryDiagnostics = {
  sampledAt: number;
  windows: number;
  main: {
    pid: number;
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  renderer: {
    pid: number;
    privateKb: number;
    residentSetKb: number;
    sharedKb: number;
  } | null;
  processes: Array<{
    pid: number;
    type: string;
    name?: string;
    serviceName?: string;
    workingSetKb: number;
    peakWorkingSetKb: number;
    privateKb?: number;
    cpuPercent: number;
  }>;
  caches: {
    sessions: {
      hydratedTranscripts: number;
      hydratedItems: number;
      hydratedChanges: number;
      trackedChangeFiles: number;
      liveQueries: number;
    };
    rooms: {
      rooms: number;
      timelineItems: number;
      members: number;
      connections: number;
      liveExecutions: number;
      pendingPersists: number;
    } | null;
    terminals: number;
    fileIndex: {
      projects: number;
      indexedFiles: number;
    };
  };
};

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
    args: [{ sessionId: string; limit?: number }];
    result: {
      sessionId: string;
      cwd: string;
      items: import("./models").ChatItem[];
      total: number;
      hasMore: boolean;
      hasNewer: boolean;
      changes: FileChange[];
    };
  };
  [IPC.sessionLoadOlder]: {
    args: [{ sessionId: string; beforeId: string; limit?: number }];
    result: {
      items: import("./models").ChatItem[];
      total: number;
      hasMore: boolean;
      hasNewer: boolean;
    };
  };
  [IPC.sessionLoadNewer]: {
    args: [{ sessionId: string; afterId: string; limit?: number }];
    result: {
      items: import("./models").ChatItem[];
      total: number;
      hasMore: boolean;
      hasNewer: boolean;
    };
  };
  /** Persist renderer transcript for a session (debounced by UI) */
  [IPC.sessionSaveTranscript]: {
    args: [
      {
        sessionId: string;
        items: import("./models").ChatItem[];
        /** true = overwrite disk (compression). default merge so a tail window cannot wipe history. */
        replace?: boolean;
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
  [IPC.sessionSetPinned]: {
    args: [{ sessionId: string; pinned: boolean }];
    result: { ok: boolean; session?: SessionSummary; error?: string };
  };
  [IPC.sessionRename]: {
    args: [{ sessionId: string; title: string }];
    result: { ok: boolean; session?: SessionSummary; error?: string };
  };
  [IPC.sessionDelete]: {
    args: [{ sessionId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.windowOpenSession]: {
    args: [{ sessionId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.windowOpenRoom]: {
    args: [{ roomId: string }];
    result: { ok: boolean; error?: string };
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
  [IPC.cpaModelQuota]: {
    args: [{ model: string }];
    result: ModelQuotaInfo | null;
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
    /**
     * eventId: roll back to just before that write operation (also undoes
     * later ops on the same file). path-only = legacy restore-all-of-file.
     */
    args: [{ sessionId: string; path: string; eventId?: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.diffRestoreAll]: {
    args: [{ sessionId: string }];
    result: { restored: string[]; failed: string[] };
  };
  [IPC.sessionRewind]: {
    /**
     * userMessageId: SDK uuid of the user message to rewind to (files return
     * to that message's checkpoint; the conversation is truncated so the next
     * turn resumes AT that message). dryRun previews file changes only.
     */
    args: [{ sessionId: string; userMessageId: string; dryRun?: boolean }];
    result: {
      ok: boolean;
      canRewind?: boolean;
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
      error?: string;
    };
  };
  [IPC.fileOpenInEditor]: {
    args: [{ path: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.fileReveal]: {
    args: [{ path: string }];
    result: { ok: boolean };
  };
  [IPC.fileImageData]: {
    args: [{ path: string }];
    result: { ok: boolean; dataUrl?: string; error?: string };
  };
  [IPC.projectGitStatus]: {
    args: [{ cwd: string }];
    result: {
      isRepo: boolean;
      branch?: string;
      /** porcelain v1 paths, relative to repo root */
      changed?: string[];
    };
  };
  [IPC.appCompleteOnboarding]: {
    args: [
      {
        /** Gateway client token (CPA api-keys + app encrypted token) */
        token: string;
        /** Start CPA after writing config (default true) */
        startCpa?: boolean;
      },
    ];
    result: {
      ok: boolean;
      settings: PublicSettings;
      cpaStatus: CpaStatus;
      error?: string;
    };
  };
  [IPC.terminalCreate]: {
    args: [{ cwd?: string }?];
    result: { id: string; cwd: string; shell: string };
  };
  [IPC.sessionAttachCli]: {
    args: [{ sessionId?: string | null }?];
    result: {
      ok: boolean;
      id?: string;
      cwd?: string;
      shell?: string;
      sdkSessionId?: string;
      error?: string;
    };
  };
  [IPC.terminalWrite]: {
    args: [{ id: string; data: string }];
    result: { ok: boolean };
  };
  [IPC.terminalKill]: {
    args: [{ id: string }];
    result: { ok: boolean };
  };
  [IPC.terminalResize]: {
    args: [{ id: string; cols: number; rows: number }];
    result: { ok: boolean };
  };
  [IPC.appThemeChanged]: {
    args: [{ theme: "dark" | "light" }];
    result: { ok: boolean };
  };
  [IPC.appMemoryDiagnostics]: {
    args: [];
    result: AppMemoryDiagnostics;
  };
  [IPC.skillsList]: {
    args: [];
    result: {
      userDir: string;
      projectDir: string | null;
      skills: Array<{ name: string; scope: "user" | "project"; path: string }>;
    };
  };
  [IPC.skillsOpenDir]: {
    args: [{ scope: "user" | "project" }];
    result: { ok: boolean; path?: string; error?: string };
  };
  [IPC.skillsDelete]: {
    args: [{ name: string; scope: "user" | "project" }];
    result: { ok: boolean; error?: string };
  };
  [IPC.skillsReload]: {
    args: [{ sessionId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.projectListDir]: {
    /** rel is a project-relative directory; "" = project root */
    args: [{ cwd: string; rel?: string }];
    result: {
      entries: Array<{ name: string; rel: string; kind: "dir" | "file" }>;
    };
  };
  [IPC.fileReadText]: {
    /**
     * rel is project-relative; must stay inside cwd.
     * encoding: iconv label — utf-8 (default), gbk, gb2312, gb18030, big5, …
     */
    args: [{ cwd: string; rel: string; maxBytes?: number; encoding?: string }];
    result: {
      ok: boolean;
      content?: string;
      truncated?: boolean;
      encoding?: string;
      error?: string;
    };
  };
  [IPC.fileWriteText]: {
    /**
     * rel is project-relative; must stay inside cwd; full replace.
     * encoding matches the open encoding so round-trips stay consistent.
     */
    args: [{ cwd: string; rel: string; content: string; encoding?: string }];
    result: {
      ok: boolean;
      error?: string;
    };
  };
  [IPC.appUpdateCheck]: {
    args: [];
    result: UpdateStatusDto;
  };
  [IPC.appUpdateDownload]: {
    args: [];
    result: UpdateStatusDto;
  };
  [IPC.appUpdateInstall]: {
    args: [];
    result: { ok: boolean };
  };
  [IPC.appUpdateGetStatus]: {
    args: [];
    result: UpdateStatusDto;
  };
  [IPC.appGetVersion]: {
    args: [];
    result: { version: string };
  };
  [IPC.roomCreate]: {
    args: [
      {
        name: string;
        password?: string;
        port?: number;
        requireMods?: boolean;
        autoApprove?: boolean;
        /** Default true; false keeps the legacy plaintext transport. */
        encrypt?: boolean;
        /**
         * Public wss:// endpoint terminated outside this process (T1/T2) —
         * written into the invite's u array; forces encryption on.
         */
        publicWss?: string;
        /**
         * Start a Cloudflare tunnel for this room (T2) — the resulting
         * wss://*.trycloudflare.com URL goes into the invite; forces
         * encryption on. Tunnel failure degrades to a LAN-only room.
         */
        tunnel?: boolean;
        /**
         * Self-hosted relay (ws:// or wss://) — the host dials out and the
         * public join URL goes into the invite; forces encryption on.
         * Relay failure degrades to a LAN-only room.
         */
        relay?: string;
        /** Optional auth token matching the relay's --token. */
        relayToken?: string;
      },
    ];
    result: { ok: boolean; room?: import("./room-protocol").RoomSnapshot; error?: string };
  };
  [IPC.roomJoin]: {
    args: [
      {
        host: string;
        port: number;
        password?: string;
        name?: string;
        modChecksum?: string;
        hosts?: string[];
        /** wss:// relay endpoints from the CDR2 invite (T1/T2). */
        wss?: string[];
        /** Expected host device fingerprint from the CDR2 invite (TOFU pin). */
        hostFingerprint?: string;
      },
    ];
    result: { ok: boolean; room?: import("./room-protocol").RoomSnapshot; error?: string };
  };
  [IPC.roomLeave]: {
    args: [{ roomId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomEnd]: {
    args: [{ roomId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomList]: {
    args: [];
    result: { rooms: import("./room-protocol").RoomListItem[] };
  };
  [IPC.roomGet]: {
    args: [{ roomId: string }];
    result: { room: import("./room-protocol").RoomSnapshot | null };
  };
  [IPC.roomAddSeat]: {
    args: [
      {
        roomId: string;
        kind: import("./room-protocol").RoomSeatKind;
        name: string;
        agentName?: string;
        agentPrompt?: string;
        skillNames?: string[];
        model?: string;
        executorUserId?: string;
        aiUserId?: string;
        workspaceUserId?: string;
      },
    ];
    result: { ok: boolean; room?: import("./room-protocol").RoomSnapshot; error?: string };
  };
  [IPC.roomUpdateSeat]: {
    args: [
      {
        roomId: string;
        seatId: string;
        name?: string;
        agentName?: string;
        agentPrompt?: string;
        skillNames?: string[];
        model?: string;
        executorUserId?: string;
        aiUserId?: string;
        workspaceUserId?: string;
      },
    ];
    result: { ok: boolean; room?: import("./room-protocol").RoomSnapshot; error?: string };
  };
  [IPC.roomTakeover]: {
    args: [{ roomId: string; seatId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomReturnSeat]: {
    args: [{ roomId: string; seatId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomSend]: {
    args: [
      {
        roomId: string;
        seatId: string;
        text: string;
        quote?: import("./room-protocol").RoomQuoteRef;
      },
    ];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomDice]: {
    args: [{ roomId: string; seatId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomRps]: {
    args: [{ roomId: string; seatId: string; hand: "rock" | "scissors" | "paper" }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomInvite]: {
    args: [{ roomId: string }];
    result: {
      ok: boolean;
      host?: string;
      hosts?: string[];
      port?: number;
      /** Room password — shown to the host only; never inside the CDR2 secret. */
      password?: string;
      modChecksum?: string;
      hostFingerprint?: string;
      listening?: boolean;
      /** Single-line secret key (CDR2.…); guest pastes this to join */
      secret?: string;
      error?: string;
    };
  };
  [IPC.roomDelete]: {
    args: [{ roomId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomPeek]: {
    args: [
      {
        host: string;
        port: number;
        hosts?: string[];
        wss?: string[];
      },
    ];
    result: {
      ok: boolean;
      offer?: import("./room-protocol").ModOfferPayload;
      error?: string;
    };
  };
  [IPC.roomFetchMod]: {
    args: [
      {
        host: string;
        port: number;
        checksum: string;
        password?: string;
        hostFingerprint?: string;
        hosts?: string[];
        wss?: string[];
      },
    ];
    result: {
      ok: boolean;
      checksum?: string;
      offer?: import("./room-protocol").ModOfferPayload;
      error?: string;
    };
  };
  [IPC.roomEnableMod]: {
    args: [{ roomId: string; packDir: string }];
    result: {
      ok: boolean;
      room?: import("./room-protocol").RoomSnapshot;
      offer?: import("./room-protocol").ModOfferPayload;
      error?: string;
    };
  };
  [IPC.roomStartMod]: {
    args: [{ roomId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomEndMod]: {
    args: [{ roomId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomResetMod]: {
    args: [{ roomId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomRecoverMod]: {
    args: [{ roomId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomModIntent]: {
    args: [{ roomId: string; seatId: string; name: string; payload?: unknown }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomListMods]: {
    args: [];
    result: {
      mods: Array<{
        id: string;
        name: string;
        version: string;
        checksum: string;
        packDir: string;
        source: "bundled" | "cache";
        hostApi?: 1 | 2;
      }>;
    };
  };
  [IPC.roomEnableKernelMod]: {
    args: [{ roomId: string; packDir: string }];
    result: { ok: boolean; room?: import("./room-protocol").RoomSnapshot; error?: string };
  };
  [IPC.roomDisableKernelMod]: {
    args: [{ roomId: string; id: string }];
    result: { ok: boolean; room?: import("./room-protocol").RoomSnapshot; error?: string };
  };
  [IPC.roomListKernelMemory]: {
    args: [{ roomId: string }];
    result: { ok: boolean; entries?: Array<{ key: string; value: string }>; error?: string };
  };
  [IPC.roomSetKernelMemory]: {
    args: [{ roomId: string; key: string; value: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomDeleteKernelMemory]: {
    args: [{ roomId: string; key: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomSetKernelAutonomy]: {
    args: [{ roomId: string; level: 0 | 1 | 2 }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomGetKernelImprove]: {
    args: [{ roomId: string }];
    result: {
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
    };
  };
  [IPC.roomProposeKernelImprove]: {
    args: [{ roomId: string; packId: string; modJs: string; note?: string }];
    result: { ok: boolean; decision?: string; status?: string; error?: string };
  };
  [IPC.roomApplyKernelProposal]: {
    args: [{ roomId: string; proposalId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomRejectKernelProposal]: {
    args: [{ roomId: string; proposalId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomRollbackKernelImprove]: {
    args: [{ roomId: string; packId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomHasMod]: {
    args: [{ checksum: string }];
    result: { ok: boolean; has: boolean };
  };
  [IPC.roomRejoin]: {
    args: [{ roomId: string }];
    result: { ok: boolean; room?: import("./room-protocol").RoomSnapshot; error?: string };
  };
  [IPC.roomApproveDevice]: {
    args: [{ roomId: string; fingerprint: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomDenyDevice]: {
    args: [{ roomId: string; fingerprint: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomKick]: {
    args: [{ roomId: string; userId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomSetMemberRole]: {
    args: [{ roomId: string; userId: string; role: "admin" | "member" }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomSetFilePolicy]: {
    args: [{ roomId: string; policy: import("./room-protocol").RoomFilePolicy }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomSetAiShare]: {
    args: [{ roomId: string; on: boolean }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomAskAiShare]: {
    args: [{ roomId: string; targetUserId: string; seatId?: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomPermRespond]: {
    args: [{ requestId: string; allow: boolean }];
    result: { ok: boolean };
  };
  [IPC.roomRename]: {
    args: [{ roomId: string; name: string }];
    result: { ok: boolean; room?: import("./room-protocol").RoomSnapshot; error?: string };
  };
  [IPC.roomRecall]: {
    args: [{ roomId: string; itemId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomSeatStop]: {
    args: [{ roomId: string; seatId: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.roomPending]: {
    args: [{ roomId: string }];
    result: { ok: boolean; pending: Array<{ fp: string; name: string }> };
  };
  [IPC.roomMetrics]: {
    args: [];
    result: { ok: boolean; snapshot?: RoomMetricsSnapshot };
  };
  [IPC.modsDelete]: {
    args: [{ packDir: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.modsOpenDir]: {
    args: [{ packDir: string }];
    result: { ok: boolean; error?: string };
  };
  [IPC.modsScaffold]: {
    args: [{ id: string; name: string }];
    result: { ok: boolean; packDir?: string; error?: string };
  };
};

/**
 * Room transport counters (task 12): per-path connect results, handshake
 * outcomes by reason, guest reconnect latency P50 (ms), host fan-out bytes.
 * Emitted by the debug `roomMetrics` channel; S1 has no metrics UI.
 */
export type RoomMetricsSnapshot = {
  connect: Record<import("./room-protocol").RoomPath, { ok: number; fail: number }>;
  handshake: Record<"ok" | import("./room-handshake").HandshakeReject, number>;
  reconnectMsP50: number;
  fanoutBytes: number;
};

/**
 * 房间远程执行的本地审批弹窗（filePolicy = ask）：工作区所在机器向本机用户
 * 询问是否允许某成员跑一次任务。`resolved` 广播用于清掉其他窗口的同名弹窗
 * （任一窗口作答后，其余窗口的弹窗随之关闭）。
 */
export type RoomPermAskPayload = {
  roomId: string;
  requestId: string;
  roomName: string;
  requesterName: string;
  seatName: string;
  projectPath: string;
  /** 任务文本预览（截断） */
  text: string;
  resolved?: boolean;
};

/** Mirrors main auto-updater status (kept in shared so renderer can type it). */
export type UpdateStatusDto =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string | null }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; transferred: number; total: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string }
  | { state: "disabled"; message: string };

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
  [IPC.terminalData]: {
    id: string;
    stream: "stdout" | "stderr" | "system";
    data: string;
  };
  [IPC.terminalExit]: { id: string; code: number | null };
  [IPC.terminalTitle]: { id: string; title: string };
  [IPC.appUpdateStatus]: UpdateStatusDto;
  [IPC.roomPermAsk]: RoomPermAskPayload;
  [IPC.roomEvent]: {
    roomId: string;
    /**
     * Guest join dialog: host is holding the handshake for approval.
     * May arrive with an empty roomId before the guest has a RoomRecord.
     */
    joining?: "pending-approval" | null;
    room?: import("./room-protocol").RoomSnapshot;
    /** High-frequency ephemeral state; never includes timeline/history. */
    livePatch?: import("./room-protocol").RoomLivePatch;
    /** host left / room deleted — guest should alert and remove */
    closed?: boolean;
    /** guest dropped after reconnect retries — room kept locally, can rejoin */
    offline?: boolean;
    /** local-initiated close (host dismissed) — no alert */
    silent?: boolean;
    /** guest reconnecting */
    reconnecting?: boolean;
    reconnectAttempt?: number;
    /** host: devices waiting for approval (changed) */
    pending?: Array<{ fp: string; name: string }>;
    /** host: a known user's device fingerprint changed — re-approval required */
    fingerprintChanged?: boolean;
    /** host rejected a guest action (send / takeover) */
    error?: boolean;
    message?: string;
    /** Play-loop views. Never includes full play state. */
    mod?: {
      offer?: import("./room-protocol").ModOfferPayload;
      publicView?: unknown;
      /** @deprecated prefer seatViews — first local occupied/taken-over seat */
      seatView?: unknown;
      /** Views for seats this client occupies or has taken over */
      seatViews?: Record<string, unknown>;
      seq?: number;
      fail?: string;
      /** getActions for the preferred local seat */
      actions?: Record<string, { params?: unknown; hint?: string }>;
    };
  };
  // also permission mode can piggyback via settings
  permissionMode?: PermissionMode;
};
