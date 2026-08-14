import React, { useEffect, useRef, useState } from "react";
import { getDesktop } from "../lib/desktop-api";
import { sendMessage, useAppStore } from "../state/store";
import { IPC, type SdkNormalizedEvent } from "@claude-desktop/shared";

export function CliModePage() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const running = useAppStore((s) => s.running);
  const lastError = useAppStore((s) => s.lastError);
  const [buf, setBuf] = useState("");
  const [draft, setDraft] = useState("");
  const preRef = useRef<HTMLPreElement | null>(null);
  const session = sessions.find((s) => s.id === activeSessionId) ?? null;

  useEffect(() => {
    let desktop: ReturnType<typeof getDesktop>;
    try {
      desktop = getDesktop();
    } catch {
      return;
    }
    return desktop.on(IPC.sessionEvent, (payload) => {
      const ev = payload as SdkNormalizedEvent;
      if (!ev || ev.sessionId !== activeSessionId) return;
      if (ev.type === "text_delta") {
        setBuf((b) => b + ev.text);
      } else if (ev.type === "text_done") {
        setBuf((b) => (b.endsWith("\n") ? b : b + "\n"));
      } else if (ev.type === "tool_start") {
        setBuf((b) => `${b}\n⚙ ${ev.tool.name} ${ev.tool.summary || ""}\n`);
      } else if (ev.type === "tool_end") {
        setBuf((b) => `${b}  └ ${ev.tool.status}\n`);
      } else if (ev.type === "result") {
        setBuf((b) => `${b}\n${ev.ok ? "✔ done" : `✖ ${ev.error ?? "failed"}`}\n`);
      } else if (ev.type === "user_message") {
        setBuf((b) => `${b}\n> ${ev.text}\n`);
      }
    });
  }, [activeSessionId]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buf]);

  return (
    <div className="cli-page">
      <header className="cli-head">
        <span className="cli-title">{session?.title ?? "新会话"}</span>
        <span className={`room-dot ${running ? "on" : ""}`} />
        <span className="cli-meta">
          {running ? "运行中" : "空闲"} · Ctrl+Shift+L 返回桌面
        </span>
      </header>
      <pre ref={preRef} className="cli-stream">
        {buf || "（等待输出）"}
      </pre>
      {lastError ? <p className="cli-err">{lastError}</p> : null}
      <form
        className="cli-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft.trim();
          if (!t) return;
          setBuf((b) => `${b}\n> ${t}\n`);
          sendMessage(t);
          setDraft("");
        }}
      >
        <input
          className="cli-input"
          value={draft}
          placeholder={running ? "排队发送…" : "输入消息，Enter 发送"}
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>
    </div>
  );
}
