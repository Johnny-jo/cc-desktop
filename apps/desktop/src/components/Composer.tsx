import React, { useCallback, useMemo, useRef, useState } from "react";
import type { Attachment, PermissionMode } from "@claude-desktop/shared";
import { formatFileSize, IMAGE_MIME_TYPES } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import {
  abortActiveSession,
  compressActiveSession,
  newChat,
  sendMessage,
  setModel,
  setPermissionMode,
  startCpa,
  syncCpaModels,
  useAppStore,
} from "../state/store";
import {
  APP_SLASH_COMMANDS,
  filterSlashCommands,
  mergeSlashCommands,
  parseLeadingSlash,
} from "../lib/slash-commands";

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

export function Composer({ onToggleChanges, onOpenSettings }: ComposerProps) {
  const [text, setText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [helpNote, setHelpNote] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const modelSelectRef = useRef<HTMLSelectElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const running = useAppStore((s) => s.running);
  const projectPath = useAppStore((s) => s.projectPath);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const settings = useAppStore((s) => s.settings);
  const slashBySession = useAppStore((s) => s.slashBySession);

  const canSend =
    (Boolean(text.trim()) || attachments.length > 0) &&
    Boolean(projectPath || activeSessionId);

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
        case "model":
          setText("");
          modelSelectRef.current?.focus();
          modelSelectRef.current?.click();
          return;
        case "diff":
          onToggleChanges?.();
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

      {helpNote ? (
        <pre className="slash-help-note">{helpNote}</pre>
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
          className="composer-input"
          rows={2}
          placeholder={
            projectPath
              ? activeSessionId
                ? "Reply…  (type / for commands, drop files)"
                : "Message Claude…  (type / for commands, drop files)"
              : "Open a project first, then type a message…"
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSlashIndex(0);
          }}
          onKeyDown={onKeyDown}
          disabled={!projectPath && !activeSessionId}
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
              className="btn btn-ghost btn-icon"
              title="Attach files"
              onClick={() => fileInputRef.current?.click()}
              disabled={!projectPath && !activeSessionId}
            >
              📎
            </button>
            <label className="composer-model-field" title="Model">
              <span className="composer-model-prefix">✦</span>
              <select
                ref={modelSelectRef}
                className="select select-ghost composer-model-select"
                value={settings?.defaultModel ?? ""}
                disabled={!settings || models.length === 0}
                onChange={(e) => void setModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="composer-actions">
            {running ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => abortActiveSession()}
              >
                Stop
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-send"
              disabled={!canSend && !slashOpen}
              onClick={onSend}
            >
              {running ? "Send anyway" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
