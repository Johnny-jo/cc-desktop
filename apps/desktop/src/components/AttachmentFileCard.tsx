import React from "react";
import { attachmentPresentation, formatFileSize } from "@claude-desktop/shared";
import type { Attachment } from "@claude-desktop/shared";
import "./AttachmentFileCard.css";

export function AttachmentFileIcon({ name, mimeType }: { name: string; mimeType?: string }) {
  const file = attachmentPresentation(name, mimeType);
  return <span className={`attachment-file-icon is-${file.category}`} aria-hidden="true">
    <svg viewBox="0 0 28 32" fill="none">
      <path d="M5 2h12l6 6v22H5z" fill="currentColor" opacity=".1" />
      <path d="M5 2h12l6 6v22H5zM17 2v7h6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
    <span>{file.extension}</span>
  </span>;
}

export function AttachmentFileCard({ attachment, onRemove, error }: {
  attachment: Attachment;
  onRemove: () => void;
  error?: string | null;
}) {
  const file = attachmentPresentation(attachment.name, attachment.mimeType);
  return <div className={`composer-attachment${error ? " has-error" : ""}`} title={error || attachment.name}>
    <AttachmentFileIcon name={attachment.name} mimeType={attachment.mimeType} />
    <div className="composer-attachment-copy">
      <span className="composer-attachment-name" title={attachment.name}>{attachment.name}</span>
      <span className="composer-attachment-meta">{file.label} · {formatFileSize(attachment.size)}</span>
    </div>
    <button type="button" className="composer-attachment-remove" onClick={onRemove}
      title="移除附件" aria-label={`移除 ${attachment.name}`}>×</button>
  </div>;
}
