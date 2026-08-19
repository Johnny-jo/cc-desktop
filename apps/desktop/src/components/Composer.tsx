import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Attachment,
  PermissionMode,
  SessionMcpServerStatus,
} from "@claude-desktop/shared";
import { formatFileSize, IMAGE_MIME_TYPES } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import { ThemedSelect } from "./Select";
import {
  abortActiveSession,
  compressActiveSession,
  dequeuePrompt,
  getState,
  newChat,
  openProject,
  sendMessage,
  setModel,
  setPermissionMode,
  startCpa,
  syncCpaModels,
  useAppStore,
} from "../state/store";
import { useI18n } from "../i18n/useI18n";
import {
  APP_SLASH_COMMANDS,
  filterSlashCommands,
  mergeSlashCommands,
  parseLeadingSlash,
} from "../lib/slash-commands";
import { parseTrailingAt } from "../lib/at-mention";

/** Join a project-relative path onto the project root, tolerating either separator. */
function joinProjectPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const trimmed = root.replace(/[/\\]+$/, "");
  return `${trimmed}${sep}${rel.replace(/[/\\]+/g, sep)}`;
}

export type ComposerProps = {
  onToggleChanges?: () => void;
  onOpenSettings?: () => void;
};

const MAX_ATTACHMENTS = 5;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_TEXT_SIZE = 5 * 1024 * 1024;

const PERMISSION_CYCLE: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
];

function getDesktopOrNull() {
  try {
    return getDesktop();
  } catch {
    return null;
  }
}

function validateAttachment(a: Attachment): string | null {
  if (a.kind === "image" && a.size > MAX_IMAGE_SIZE) {
    return `${a.name} exceeds ${formatFileSize(MAX_IMAGE_SIZE)}`;
  }
  if (a.kind === "text" && a.size > MAX_TEXT_SIZE) {
    return `${a.name} exceeds ${formatFileSize(MAX_TEXT_SIZE)}`;
  }
  if (a.kind === "binary") {
    return `${a.name} is not a supported text/image file`;
  }
  return null;
}

/** Build the /mcp help note: configured servers + live status when a session is running. */
async function buildMcpNote(): Promise<string> {
  const desktop = getDesktopOrNull();
  const state = getState();
  const configured = state.settings?.mcpServers ?? {};
  const names = Object.keys(configured);
  if (names.length === 0) {
    return "No MCP servers configured.\nAdd them in Settings → MCP servers.";
  }

  const lines: string[] = [];
  let live: SessionMcpServerStatus[] | null = null;
  const sessionId = state.activeSessionId;
  if (desktop && sessionId) {
    try {
      const res = await desktop.getSessionMcpStatus(sessionId);
      live = res?.statuses ?? null;
    } catch {
      live = null;
    }
  }
  const liveByName = new Map((live ?? []).map((s) => [s.name, s]));

  for (const name of names) {
    const cfg = configured[name];
    const target =
      cfg && (cfg.type === "sse" || cfg.type === "http")
        ? cfg.url
        : (cfg as { command?: string } | undefined)?.command ?? "";
    const type = cfg?.type ?? "stdio";
    const liveInfo = liveByName.get(name);
    const statusPart = liveInfo
      ? ` — ${liveInfo.status}${liveInfo.tools ? `, ${liveInfo.tools.length} tools` : ""}${liveInfo.error ? ` (${liveInfo.error})` : ""}`
      : "";
    lines.push(`${name} [${type}] ${target}${statusPart}`);
  }
  if (live === null && sessionId) {
    lines.push("", "(live status unavailable — session may not be running)");
  } else if (!sessionId) {
    lines.push("", "(start a session to see live connection status)");
  }
  return lines.join("\n");
}

export function Composer({ onToggleChanges, onOpenSettings }: ComposerProps) {
  const [text, setText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [helpNote, setHelpNote] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atMatches, setAtMatches] = useState<string[]>([]);
  const [atTruncated, setAtTruncated] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { t } = useI18n();

  const running = useAppStore((s) => s.running);
  const projectPath = useAppStore((s) => s.projectPath);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const settings = useAppStore((s) => s.settings);
  const slashBySession = useAppStore((s) => s.slashBySession);
  const queuedPrompts = useAppStore((s) => s.queuedPrompts);

  const canSend = Boolean(text.trim()) || attachments.length > 0;

  const models = settings?.models?.length
    ? settings.models
    : settings?.defaultModel
      ? [settings.defaultModel]
      : [];

  const allSlashCommands = useMemo(() => {
    const sdk =
      (activeSessionId && slashBySession[activeSessionId]) || [];
    return mergeSlashCommands(sdk);
  }, [activeSessionId, slashBySession]);

  const slash = parseLeadingSlash(text);
  const slashOpen = Boolean(slash && text.startsWith("/"));
  const slashMatches = useMemo(
    () =>
      slashOpen
        ? filterSlashCommands(slash?.name ?? "", allSlashCommands)
        : [],
    [slashOpen, slash?.name, allSlashCommands],
  );

  // @ file-mention autocomplete. Only active when not in slash mode and a
  // project is open. The trailing `@query` is parsed from the text; matches
  // are fetched (debounced) from the main-process file index.
  const atMention = slashOpen ? null : parseTrailingAt(text);
  const atQuery = atMention?.query ?? null;
  const atOpen = atMention != null && Boolean(projectPath);

  useEffect(() => {
    if (!atOpen || !projectPath || atQuery == null) {
      setAtMatches([]);
      setAtTruncated(false);
      return;
    }
    const desktop = getDesktopOrNull();
    if (!desktop) return;
    let cancelled = false;
    const t = setTimeout(() => {
      desktop
        .listProjectFiles(projectPath, atQuery, 50)
        .then((res) => {
          if (cancelled) return;
          setAtMatches(res.files);
          setAtTruncated(Boolean(res.truncated));
        })
        .catch(() => {
          if (cancelled) return;
          setAtMatches([]);
          setAtTruncated(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [atOpen, atQuery, projectPath]);

  const validateAndSetAttachments = useCallback((next: Attachment[]) => {
    setAttachmentError(null);
    if (next.length > MAX_ATTACHMENTS) {
      setAttachmentError(`At most ${MAX_ATTACHMENTS} files allowed`);
      next = next.slice(0, MAX_ATTACHMENTS);
    }
    for (const a of next) {
      const err = validateAttachment(a);
      if (err) {
        setAttachmentError(err);
        break;
      }
    }
    setAttachments(next);
  }, []);

  const addAttachments = useCallback(
    async (files: File[]) => {
      const desktop = getDesktopOrNull();
      if (!desktop) return;
      const added: Attachment[] = [];
      for (const file of files) {
        try {
          const path = desktop.getPathForFile(file);
          const attachment = await desktop.readAttachment(path);
          added.push(attachment);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setAttachmentError(message);
        }
      }
      validateAndSetAttachments([...attachments, ...added]);
    },
    [attachments, validateAndSetAttachments],
  );

  const handleFileSelect = useCallback(async () => {
    const desktop = getDesktopOrNull();
    if (!desktop) return;
    try {
      const { paths } = await desktop.selectFiles();
      const added: Attachment[] = [];
      for (const path of paths) {
        try {
          const attachment = await desktop.readAttachment(path);
          added.push(attachment);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setAttachmentError(message);
        }
      }
      validateAndSetAttachments([...attachments, ...added]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAttachmentError(message);
    }
  }, [attachments, validateAndSetAttachments]);

  const removeAttachment = useCallback(
    (path: string) => {
      validateAndSetAttachments(attachments.filter((a) => a.path !== path));
    },
    [attachments, validateAndSetAttachments],
  );

  // Pick an @-mention candidate: attach the file's content (via the existing
  // attachment pipeline so size/type checks apply) and replace the `@query`
  // token in the text with the relative path so the reference stays visible.
  const pickAtMatch = useCallback(
    async (rel: string) => {
      const desktop = getDesktopOrNull();
      const mention = parseTrailingAt(text);
      if (!desktop || !projectPath || !mention) return;
      const abs = joinProjectPath(projectPath, rel);
      try {
        const attachment = await desktop.readAttachment(abs);
        validateAndSetAttachments([...attachments, attachment]);
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : String(err));
      }
      // Replace `@query` with `@relpath ` to close out the token.
      const next = `${text.slice(0, mention.start)}@${rel} ${text.slice(mention.end)}`;
      setText(next);
      setAtMatches([]);
      setAtIndex(0);
    },
    [attachments, projectPath, text, validateAndSetAttachments],
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) await addAttachments(files);
  };

  const runSlash = useCallback(
    async (name: string) => {
      setHelpNote(null);
      switch (name) {
        case "new":
        case "clear":
          newChat();
          setText("");
          setAttachments([]);
          return;
        case "model": {
          setText("");
          const btn = document.querySelector<HTMLButtonElement>(
            ".composer-model-select-wrap .themed-select-btn",
          );
          btn?.focus();
          btn?.click();
          return;
        }
        case "diff":
          onToggleChanges?.();
          window.dispatchEvent(new Event("cd:toggle-changes"));
          setText("");
          return;
        case "settings":
          onOpenSettings?.();
          setText("");
          return;
        case "permission": {
          const cur = settings?.permissionMode ?? "default";
          const idx = PERMISSION_CYCLE.indexOf(cur);
          const next =
            PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length] ?? "default";
          await setPermissionMode(next);
          setHelpNote(`Permission mode → ${next}`);
          setText("");
          return;
        }
        case "cpa":
          try {
            await startCpa();
            await syncCpaModels();
            setHelpNote("CPA ready; models synced");
          } catch (err) {
            setHelpNote(err instanceof Error ? err.message : String(err));
          }
          setText("");
          return;
        case "compact": {
          if (!activeSessionId) {
            setHelpNote("No active session to compress");
            setText("");
            return;
          }
          setText("");
          setHelpNote("Compressing…");
          try {
            const res = await compressActiveSession();
            setHelpNote(
              res.ok
                ? (res.message ?? "Context compressed")
                : `Compression failed: ${res.message ?? "unknown error"}`,
            );
          } catch (err) {
            setHelpNote(
              err instanceof Error ? err.message : String(err),
            );
          }
          return;
        }
        case "help":
          setHelpNote(
            allSlashCommands
              .map((c) => `/${c.name} — ${c.description}`)
              .join("\n"),
          );
          setText("");
          return;
        case "mcp": {
          setText("");
          setHelpNote("Loading MCP servers…");
          try {
            const note = await buildMcpNote();
            setHelpNote(note);
          } catch (err) {
            setHelpNote(err instanceof Error ? err.message : String(err));
          }
          return;
        }
        default: {
          // SDK skill / unknown: send as prompt (agent expands slash commands)
          const skill = allSlashCommands.find((c) => c.name === name);
          if (
            skill?.sendAsPrompt ||
            !APP_SLASH_COMMANDS.some((c) => c.name === name)
          ) {
            sendMessage(text.startsWith("/") ? text : `/${name}`, attachments);
            setText("");
            setAttachments([]);
            return;
          }
          sendMessage(text, attachments);
          setText("");
          setAttachments([]);
        }
      }
    },
    [
      allSlashCommands,
      attachments,
      onOpenSettings,
      onToggleChanges,
      settings?.permissionMode,
      text,
    ],
  );

  const onSend = useCallback(() => {
    if (!text.trim() && attachments.length === 0) return;
    const parsed = parseLeadingSlash(text.trim());
    if (parsed && parsed.name) {
      const known = allSlashCommands.some((c) => c.name === parsed.name);
      if (known) {
        void runSlash(parsed.name);
        return;
      }
    }
    const prompt = text;
    setText("");
    setHelpNote(null);
    setAttachmentError(null);
    sendMessage(prompt, attachments);
    setAttachments([]);
  }, [allSlashCommands, attachments, runSlash, text]);

  // Auto-grow the input with content (height capped by CSS max-height).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // @-mention menu takes priority over slash (they are mutually exclusive:
    // slash only triggers at line start, @ only after whitespace/mid-text).
    if (atOpen && atMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtIndex((i) => (i + 1) % atMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtIndex((i) => (i - 1 + atMatches.length) % atMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const pick = atMatches[atIndex] ?? atMatches[0];
        if (pick) void pickAtMatch(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtMatches([]);
        return;
      }
    }
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + slashMatches.length) % slashMatches.length,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const pick = slashMatches[slashIndex] ?? slashMatches[0];
        if (pick) void runSlash(pick.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="composer-shell">
      {slashOpen && slashMatches.length > 0 ? (
        <ul className="slash-menu" role="listbox">
          {slashMatches.map((cmd, i) => (
            <li key={cmd.name}>
              <button
                type="button"
                className={
                  i === slashIndex ? "slash-item active" : "slash-item"
                }
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => void runSlash(cmd.name)}
              >
                <span className="slash-name">/{cmd.name}</span>
                <span className="slash-desc">{cmd.description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {atOpen && atMatches.length > 0 ? (
        <ul className="slash-menu at-menu" role="listbox" aria-label="File mentions">
          {atMatches.map((rel, i) => (
            <li key={rel}>
              <button
                type="button"
                className={i === atIndex ? "slash-item active" : "slash-item"}
                onMouseEnter={() => setAtIndex(i)}
                onClick={() => void pickAtMatch(rel)}
              >
                <span className="slash-name at-name">@{rel.split(/[/\\]/).pop()}</span>
                <span className="slash-desc" title={rel}>
                  {rel}
                </span>
              </button>
            </li>
          ))}
          {atTruncated ? (
            <li className="at-truncated">结果已截断，继续输入以过滤…</li>
          ) : null}
        </ul>
      ) : null}

      {helpNote ? (
        <pre className="slash-help-note">{helpNote}</pre>
      ) : null}

      {queuedPrompts.length > 0 ? (
        <div className="queued-prompts">
          {queuedPrompts.map((q, i) => (
            <div key={i} className="queued-prompt">
              <span className="queued-label">Queued</span>
              <span className="queued-text" title={q.displayText}>
                {q.displayText}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm queued-remove"
                title="Remove from queue"
                onClick={() => dequeuePrompt(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {attachmentError ? (
        <div className="composer-attachment-error">{attachmentError}</div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <div key={a.path} className="composer-attachment">
              <span className="composer-attachment-name" title={a.path}>
                {a.name}
              </span>
              <span className="composer-attachment-meta">
                {formatFileSize(a.size)} · {a.kind}
              </span>
              <button
                type="button"
                className="composer-attachment-remove"
                onClick={() => removeAttachment(a.path)}
                title="Remove file"
                aria-label={`Remove ${a.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div
        className={isDragging ? "composer dragging" : "composer"}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={2}
          placeholder={
            activeSessionId
              ? t.chat.composerPlaceholder
              : t.chat.composerPlaceholderNew
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSlashIndex(0);
            setAtIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="composer-bar">
          <div className="composer-left">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={IMAGE_MIME_TYPES.join(",") + ",.txt,.md,.json,.js,.ts,.py,.pdf"}
              className="composer-file-input"
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) await addAttachments(files);
              }}
            />
            <button
              type="button"
              className="composer-plus-btn"
              title="Attach files"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path
                  d="M7 2.5v9M2.5 7h9"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="composer-project-chip"
              title={projectPath ?? t.chat.pickProject}
              onClick={() => void openProject()}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2L7.7 5H13a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7Z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
              <span>
                {projectPath
                  ? (projectPath
                      .replace(/\\/g, "/")
                      .split("/")
                      .filter(Boolean)
                      .pop() ?? projectPath)
                  : t.chat.pickProject}
              </span>
            </button>
            <label className="composer-model-field" title="Model">
              <span className="composer-model-prefix">✦</span>
              <ThemedSelect
                className="composer-model-select-wrap"
                value={settings?.defaultModel ?? ""}
                disabled={!settings || models.length === 0}
                onChange={(v) => void setModel(v)}
                options={models.map((m) => ({ value: m }))}
              />
            </label>
          </div>
          <div className="composer-actions">
            <button
              type="button"
              className={
                running ? "sendstop-btn sendstop-stop" : "sendstop-btn sendstop-send"
              }
              disabled={!running && !canSend && !slashOpen}
              onClick={running ? () => abortActiveSession() : onSend}
              title={running ? "Stop" : "Send"}
              aria-label={running ? "Stop" : "Send"}
            >
              {running ? (
                /* Stop: filled rounded square */
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <rect x="2" y="2" width="10" height="10" rx="2.5" fill="currentColor" />
                </svg>
              ) : (
                /* Send: upward arrow */
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M8 13V3.5M8 3.5L3.5 8M8 3.5L12.5 8"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
