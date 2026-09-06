import React, { useLayoutEffect, useRef, useState } from "react";
import type { RoomAttachmentRef } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import "./RoomAttachments.css";

const PREVIEW_BYTES = 5 * 1024 * 1024;
const PREVIEW_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
type Action = "preview" | "save";
type CardState = { status: "pending"; action: Action }
  | { status: "error"; action: Action; error: string }
  | { status: "saved" };
type Preview = { attachment: RoomAttachmentRef; dataUrl: string; trigger?: HTMLButtonElement };
type View = { scope: string; cards: Record<string, CardState | undefined>; preview?: Preview };

function canPreview(attachment: RoomAttachmentRef): boolean {
  return attachment.kind === "image" && PREVIEW_MIME_TYPES.has(attachment.mimeType)
    && Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size <= PREVIEW_BYTES;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 * 1024 ? 1024 : 1024 * 1024;
  return `${(bytes / unit).toFixed(1).replace(/\.0$/, "")} ${unit === 1024 ? "KiB" : "MiB"}（${bytes} B）`;
}

/** The renderer accepts only bounded raster data URLs, never paths/remote URLs/SVG. */
function safePreviewUrl(attachment: RoomAttachmentRef, dataUrl?: string): string | null {
  if (!canPreview(attachment) || typeof dataUrl !== "string") return null;
  const prefix = `data:${attachment.mimeType};base64,`;
  if (!dataUrl.startsWith(prefix) || dataUrl.length > prefix.length + Math.ceil(PREVIEW_BYTES / 3) * 4) return null;
  const payload = dataUrl.slice(prefix.length);
  if (!payload.length || payload.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  const bytes = payload.length / 4 * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  return bytes > 0 && bytes <= PREVIEW_BYTES && bytes === attachment.size ? dataUrl : null;
}

export function RoomAttachments({ roomId, itemId, attachments }: {
  roomId: string;
  itemId: string;
  attachments: RoomAttachmentRef[];
}) {
  // Include metadata as well as IDs: replacement/recalled references must not
  // inherit an earlier preview. Keep the scope off the DOM (it includes hashes).
  const scope = JSON.stringify([roomId, itemId, attachments.map(a => [a.id, a.name, a.size, a.mimeType, a.kind, a.sha256])]);
  const [view, setView] = useState<View>(() => ({ scope, cards: {} }));
  const requestScope = useRef<{ key: string; pending: Set<string> } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const current = { key: scope, pending: new Set<string>() };
    requestScope.current = current;
    setView({ scope, cards: {} });
    // Layout cleanup invalidates requests at unmount/recall, before passive effects.
    return () => { requestScope.current = null; };
  }, [scope]);

  // Hide old content during the very render that changes room/item, before cleanup.
  const currentView = view.scope === scope ? view : undefined;
  const preview = currentView?.preview;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!preview || !dialog) return;
    dialog.showModal(); // Native modal supplies focus containment and inert background.
    return () => {
      if (dialog.open) dialog.close();
      if (preview.trigger?.isConnected) preview.trigger.focus();
    };
  }, [preview]);

  const closePreview = () => setView(previous => previous.preview === preview
    ? { ...previous, preview: undefined } : previous);
  const previewError = () => setView(previous => previous.preview === preview && preview
    ? { ...previous, preview: undefined, cards: { ...previous.cards,
      [preview.attachment.id]: { status: "error", action: "preview", error: "图片无法显示，请重试或保存附件" },
    } } : previous);

  async function run(attachment: RoomAttachmentRef, action: Action, trigger?: HTMLButtonElement) {
    const current = requestScope.current;
    if (!roomId || !itemId || !current || current.key !== scope || current.pending.has(attachment.id)) return;
    if (action === "preview" && !canPreview(attachment)) return;
    const update = (card?: CardState, image?: Preview) => {
      if (requestScope.current !== current) return;
      setView(previous => previous.scope === scope ? {
        ...previous, cards: { ...previous.cards, [attachment.id]: card },
        ...(image ? { preview: image } : {}),
      } : previous);
    };
    current.pending.add(attachment.id);
    update({ status: "pending", action });
    try {
      const desktop = getDesktop();
      if (typeof desktop.roomAttachment !== "function") throw new Error("请重启应用后预览或保存附件");
      const result = await desktop.roomAttachment(roomId, itemId, attachment.id, action);
      if (requestScope.current !== current) return;
      if (result.cancelled) { update(); return; }
      if (!result.ok) throw new Error(result.error || "附件下载或校验失败");
      if (action === "save") {
        if (result.saved !== true) throw new Error("附件尚未保存，请重试");
        update({ status: "saved" });
      } else {
        const dataUrl = safePreviewUrl(attachment, result.dataUrl);
        if (!dataUrl) throw new Error("附件预览无效或超过 5 MiB，请重试或保存附件");
        update(undefined, { attachment, dataUrl, trigger });
      }
    } catch (error) {
      update({ status: "error", action, error: error instanceof Error ? error.message : "附件操作失败，请重试" });
    } finally {
      current.pending.delete(attachment.id);
    }
  }

  if (!attachments.length) return null;
  return (
    <div className="room-attachments" aria-label="消息附件">
      {attachments.map(attachment => {
        const state = currentView?.cards[attachment.id];
        const pending = state?.status === "pending";
        return (
          <div className="room-attachment-card" key={attachment.id} aria-busy={pending}>
            <span className="room-attachment-icon" aria-hidden>
              <svg width="17" height="19" viewBox="0 0 16 18" fill="none">
                <path d="M3 1.5h6l4 4v11H3zM9 1.5v4h4M5.5 9h5M5.5 12h5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="room-attachment-copy">
              <span className="room-attachment-name" title={attachment.name}>{attachment.name}</span>
              <span className="room-attachment-meta">{formatSize(attachment.size)} · {attachment.mimeType}</span>
            </div>
            <div className="room-attachment-actions">
              {canPreview(attachment) ? <button className="room-attachment-button" type="button" disabled={pending || !roomId || !itemId}
                aria-label={`预览 ${attachment.name}`} onClick={event => run(attachment, "preview", event.currentTarget)}>预览</button> : null}
              <button className="room-attachment-button" type="button" disabled={pending || !roomId || !itemId}
                aria-label={`保存 ${attachment.name}`} onClick={() => run(attachment, "save")}>保存</button>
            </div>
            {pending ? <div className="room-attachment-status" role="status">
              <span className="room-attachment-spinner" aria-hidden />正在下载并校验
            </div> : state?.status === "saved" ? <div className="room-attachment-status" role="status">已保存</div>
              : state?.status === "error" ? <div className="room-attachment-status is-error" role="alert">
                <span>{state.error}</span>
                <button className="room-attachment-button" type="button" disabled={!roomId || !itemId}
                  aria-label={`重试${state.action === "preview" ? "预览" : "保存"} ${attachment.name}`}
                  onClick={event => run(attachment, state.action, event.currentTarget)}>重试</button>
              </div> : null}
          </div>
        );
      })}
      {preview ? (
        <dialog ref={dialogRef} className="room-attachment-preview" aria-modal="true" aria-label={`预览 ${preview.attachment.name}`}
          onClose={closePreview}
          onCancel={event => { event.preventDefault(); closePreview(); }}
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePreview(); }
          }}
          onContextMenu={event => event.stopPropagation()}
        >
          <div className="room-attachment-preview-header">
            <span>{preview.attachment.name}</span>
            <button className="room-attachment-button" type="button" aria-label="关闭预览" autoFocus onClick={closePreview}>关闭</button>
          </div>
          <img src={preview.dataUrl} alt={preview.attachment.name} decoding="async" onError={previewError} />
        </dialog>
      ) : null}
    </div>
  );
}
