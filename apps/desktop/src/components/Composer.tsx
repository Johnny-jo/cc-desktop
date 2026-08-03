import React, { useCallback, useMemo, useRef, useState } from "react";
import type { PermissionMode } from "@claude-desktop/shared";
import {
  abortActiveSession,
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

const PERMISSION_CYCLE: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
];

export function Composer({ onToggleChanges, onOpenSettings }: ComposerProps) {
  const [text, setText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [helpNote, setHelpNote] = useState<string | null>(null);
  const modelSelectRef = useRef<HTMLSelectElement | null>(null);

  const running = useAppStore((s) => s.running);
  const projectPath = useAppStore((s) => s.projectPath);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const settings = useAppStore((s) => s.settings);
  const slashBySession = useAppStore((s) => s.slashBySession);

  const canSend =
    Boolean(text.trim()) && Boolean(projectPath || activeSessionId);

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

  const runSlash = useCallback(
    async (name: string) => {
      setHelpNote(null);
      switch (name) {
        case "new":
        case "clear":
          newChat();
          setText("");
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
          if (skill?.sendAsPrompt || !APP_SLASH_COMMANDS.some((c) => c.name === name)) {
            sendMessage(text.startsWith("/") ? text : `/${name}`);
            setText("");
            return;
          }
          sendMessage(text);
          setText("");
        }
      }
    },
    [
      allSlashCommands,
      onOpenSettings,
      onToggleChanges,
      settings?.permissionMode,
      text,
    ],
  );

  const onSend = useCallback(() => {
    if (!text.trim()) return;
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
    sendMessage(prompt);
  }, [allSlashCommands, runSlash, text]);

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

      <div className="composer">
        <textarea
          className="composer-input"
          rows={2}
          placeholder={
            projectPath
              ? activeSessionId
                ? "Reply…  (type / for commands)"
                : "Message Claude…  (type / for commands)"
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
