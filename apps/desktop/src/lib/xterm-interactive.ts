import type { Terminal } from "@xterm/xterm";

export type PasteChord = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** Ctrl/Cmd+V or Shift+Insert — clipboard paste, not a TUI control char. */
export function isPasteChord(e: PasteChord): boolean {
  if (e.altKey) return false;
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === "Insert") return true;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return true;
  return false;
}

export function quoteDroppedPath(p: string): string {
  const path = p.trim();
  if (!path) return "";
  return /[\s"'()]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

export function droppedPathsPayload(paths: string[]): string {
  return paths.map(quoteDroppedPath).filter(Boolean).join(" ");
}

function filePath(f: File): string {
  const withPath = f as File & { path?: string };
  return (typeof withPath.path === "string" && withPath.path) || f.name;
}

/**
 * Make an xterm session behave like a real terminal for Claude Code TUI:
 * clipboard paste, keep Tab/Shift+Tab in the PTY, drop file paths in.
 */
export function bindXtermInteractive(
  term: Terminal,
  el: HTMLElement,
  opts: { paste: (text: string) => void },
): () => void {
  const onKey = term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    if (isPasteChord(ev)) {
      ev.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) opts.paste(text);
        })
        .catch(() => {
          // clipboard permission / empty
        });
      return false;
    }
    return true;
  });

  const stealTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    if (!el.contains(document.activeElement) && document.activeElement !== el) {
      return;
    }
    e.preventDefault();
  };
  el.addEventListener("keydown", stealTab, true);

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    e.preventDefault();
    const payload = droppedPathsPayload(Array.from(files, filePath));
    if (payload) opts.paste(payload);
  };
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text");
    if (!text) return;
    e.preventDefault();
    opts.paste(text);
  };
  el.addEventListener("dragover", onDragOver);
  el.addEventListener("drop", onDrop);
  el.addEventListener("paste", onPaste);

  const onMouseDown = () => {
    term.focus();
  };
  el.addEventListener("mousedown", onMouseDown);

  return () => {
    el.removeEventListener("keydown", stealTab, true);
    el.removeEventListener("dragover", onDragOver);
    el.removeEventListener("drop", onDrop);
    el.removeEventListener("paste", onPaste);
    el.removeEventListener("mousedown", onMouseDown);
    void onKey;
  };
}
