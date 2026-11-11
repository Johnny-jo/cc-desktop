import { useEffect, useRef, useState } from "react";
import type { ChatItem } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import "./CompactionHistory.css";

type History = Awaited<ReturnType<ReturnType<typeof getDesktop>["listCompactionHistory"]>>;
type Page = { items: ChatItem[]; total: number };

export function CompactionHistory({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [records, setRecords] = useState<History | null>(null);
  const [revision, setRevision] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let live = true;
    getDesktop().listCompactionHistory(sessionId).then(history => {
      if (live) {
        setRecords(history);
        setRevision(history[0]?.revision ?? "");
      }
    }).catch(err => { if (live) setError(String(err)); });
    return () => { live = false; element?.close(); };
  }, [sessionId]);

  useEffect(() => {
    if (!revision) return;
    let live = true;
    setPage(null);
    setError("");
    getDesktop().getCompactionPage(sessionId, revision, offset).then(result => {
      if (live) setPage(result);
    }).catch(err => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [sessionId, revision, offset]);

  return <dialog ref={dialog} className="compaction-history" aria-label="压缩前的对话" onCancel={onClose}>
    <header className="room-modal-head"><h3>压缩前的对话</h3>
      <button type="button" className="btn" onClick={onClose}>关闭</button>
    </header>
    <div className="room-modal-body">
      {records && records.length > 0 && (
        <select className="select" value={revision} aria-label="压缩记录" onChange={e => {
          setRevision(e.target.value); setOffset(0);
        }}>
          {records.map(record => <option key={record.revision} value={record.revision}>
            {new Date(record.createdAt).toLocaleString()} · {record.model} · 压缩 {record.compressedCount} 项
          </option>)}
        </select>
      )}
      {error ? <p role="alert">{error}</p> : records?.length === 0 ? <p>这个会话还没有压缩记录。</p> :
        !page ? <p role="status">正在读取…</p> : page.items.map(item =>
          <details key={item.id} open={item.kind === "text"}>
            <summary>{item.kind === "text" ? ({ user: "用户", assistant: "助手", system: "系统" }[item.role])
              : item.kind === "tool" ? item.tool.name : item.kind === "usage" ? "本轮用量" : "文件变更"}</summary>
            {item.kind === "text" && item.thinkingText && <details><summary>思考记录</summary><pre>{item.thinkingText}</pre></details>}
            <pre>{item.kind === "text" ? [item.text, ...(item.attachments ?? []).map(file => file.path || file.name)].filter(Boolean).join("\n") :
              JSON.stringify(item.kind === "tool" ? item.tool : item, null, 2)}</pre>
          </details>
        )}
    </div>
    {page && page.total > 0 && <footer className="room-modal-foot">
      {records?.some(record => record.revision === revision && record.sdkMessageCount) &&
        <button type="button" className="btn" onClick={() => {
          void getDesktop().exportCompactionSdk(sessionId, revision).catch(err => setError(String(err)));
        }}>导出 SDK 消息</button>}
      <span>{offset + 1}–{offset + page.items.length} / {page.total}</span>
      <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>上一页</button>
      <button type="button" className="btn" disabled={offset + page.items.length >= page.total}
        onClick={() => setOffset(offset + page.items.length)}>下一页</button>
    </footer>}
  </dialog>;
}
