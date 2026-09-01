import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import { hasLanguageForPath } from "../lib/editor-language";
import { createLru } from "../lib/lru";
import { useAppStore } from "../state/store";

/** data URLs are large; cap so old previews can GC. */
const imageCache = createLru<string, string | null>(12);

export function useImageDataUrl(path: string): string | null {
  const [url, setUrl] = useState<string | null>(imageCache.get(path) ?? null);
  useEffect(() => {
    const cached = imageCache.get(path);
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }
    if (!hasDesktopApi("readImageDataUrl")) return;
    let cancelled = false;
    void getDesktop()
      .readImageDataUrl(path)
      .then((res) => {
        const dataUrl = res.ok ? (res.dataUrl ?? null) : null;
        imageCache.set(path, dataUrl);
        if (!cancelled) setUrl(dataUrl);
      })
      .catch(() => {
        imageCache.set(path, null);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return url;
}

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toUpperCase().slice(0, 5) : "FILE";
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 1.5h5L12.5 5v9.5h-8.5v-13Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9 1.5V5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** Fullscreen image preview (click / Esc to close). */
export function Lightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="attach-lightbox" role="dialog" aria-label={name} onClick={onClose}>
      <img src={url} alt={name} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}

export function AttachmentChips({
  attachments,
  onOpenFile,
}: {
  attachments: Attachment[];
  /** Open a project-relative file in the in-app editor column. */
  onOpenFile?: (rel: string) => void;
}) {
  const projectPath = useAppStore((s) => s.projectPath);
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null);

  const openFile = (a: Attachment) => {
    const norm = (s: string) => s.replace(/\\/g, "/");
    const p = norm(a.path);
    if (projectPath && onOpenFile) {
      const root = norm(projectPath).replace(/\/+$/, "");
      if (p.toLowerCase().startsWith(root.toLowerCase() + "/")) {
        const rel = p.slice(root.length + 1);
        if (hasLanguageForPath(rel)) {
          onOpenFile(rel);
          return;
        }
      }
    }
    // 编辑器不支持或不在项目内：本机默认方式打开
    if (hasDesktopApi("openInEditor")) {
      void getDesktop().openInEditor(a.path);
    }
  };

  return (
    <div className="attach-chips">
      {attachments.map((a) =>
        a.kind === "image" ? (
          <ImageChip key={a.path} att={a} onPreview={(url) => setLightbox({ url, name: a.name })} />
        ) : (
          <button
            key={a.path}
            type="button"
            className="attach-chip"
            title={a.path}
            onClick={() => openFile(a)}
          >
            <span className="attach-chip-icon" aria-hidden>
              <FileIcon />
            </span>
            <span className="attach-chip-name">{a.name}</span>
            <span className="attach-chip-ext">{fileExt(a.name)}</span>
          </button>
        ),
      )}
      {lightbox ? (
        <Lightbox url={lightbox.url} name={lightbox.name} onClose={() => setLightbox(null)} />
      ) : null}
    </div>
  );
}

function ImageChip({
  att,
  onPreview,
}: {
  att: Attachment;
  onPreview: (url: string) => void;
}) {
  const url = useImageDataUrl(att.path);
  if (!url) {
    // 读不到内容时退化为文件 chip，本机默认方式打开
    return (
      <button
        type="button"
        className="attach-chip"
        title={att.path}
        onClick={() => {
          if (hasDesktopApi("openInEditor")) {
            void getDesktop().openInEditor(att.path);
          }
        }}
      >
        <span className="attach-chip-icon" aria-hidden>
          <FileIcon />
        </span>
        <span className="attach-chip-name">{att.name}</span>
        <span className="attach-chip-ext">{fileExt(att.name)}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="attach-thumb"
      title={`${att.name}（点击放大）`}
      onClick={() => onPreview(url)}
    >
      <img src={url} alt={att.name} loading="lazy" />
    </button>
  );
}
