import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  foldGutter,
  foldKeymap,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
} from "@codemirror/language";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
} from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { tags as t } from "@lezer/highlight";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import {
  diffDecoField,
  lineMarksFromHunks,
  setDiffMarks,
} from "../lib/editor-diff-deco";
import {
  languageForPath,
  languageLabelForPath,
} from "../lib/editor-language";
import { createVscodeSearchPanel } from "../lib/editor-search-panel";
import {
  storeEditorBuffer,
  takeEditorBuffer,
} from "../lib/editor-buffer-cache";
import { effectiveTheme } from "../lib/theme";
import { useAppStore } from "../state/store";

const EMPTY_CHANGES: readonly import("@claude-desktop/shared").FileChange[] = [];

/** Encodings offered in the status bar (iconv labels). */
export const FILE_ENCODINGS = [
  { id: "utf-8", label: "UTF-8" },
  { id: "gbk", label: "GBK" },
  { id: "gb2312", label: "GB2312" },
  { id: "gb18030", label: "GB18030" },
  { id: "big5", label: "Big5" },
  { id: "utf-16le", label: "UTF-16 LE" },
  { id: "latin1", label: "Latin-1" },
] as const;

/** Light-mode highlight colors tuned for our light tokens */
const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#7c3aed" },
  { tag: t.comment, color: "#6b7280", fontStyle: "italic" },
  { tag: t.string, color: "#059669" },
  { tag: t.number, color: "#d97706" },
  { tag: t.bool, color: "#d97706" },
  { tag: t.null, color: "#d97706" },
  { tag: t.operator, color: "#374151" },
  { tag: t.punctuation, color: "#4b5563" },
  { tag: t.variableName, color: "#111827" },
  { tag: t.definition(t.variableName), color: "#1d4ed8" },
  { tag: t.function(t.variableName), color: "#2563eb" },
  { tag: t.propertyName, color: "#0e7490" },
  { tag: t.className, color: "#b45309" },
  { tag: t.typeName, color: "#b45309" },
  { tag: t.tagName, color: "#dc2626" },
  { tag: t.attributeName, color: "#d97706" },
  { tag: t.heading, color: "#1d4ed8", fontWeight: "600" },
  { tag: t.link, color: "#2563eb" },
  { tag: t.meta, color: "#6b7280" },
  { tag: t.invalid, color: "#dc2626" },
]);

function themeExtensions(isDark: boolean) {
  if (isDark) {
    return [oneDark];
  }
  return [
    syntaxHighlighting(lightHighlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.theme(
      {
        "&": {
          backgroundColor: "var(--bg-code)",
          color: "var(--code-text)",
          height: "100%",
        },
        ".cm-content": {
          caretColor: "var(--text)",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          lineHeight: "1.55",
        },
        ".cm-gutters": {
          backgroundColor: "var(--bg-code)",
          color: "var(--text-faint)",
          border: "none",
          borderRight: "1px solid var(--border-soft)",
        },
        ".cm-activeLine": {
          backgroundColor: "color-mix(in srgb, var(--bg-hover) 70%, transparent)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "color-mix(in srgb, var(--bg-hover) 70%, transparent)",
        },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor:
            "color-mix(in srgb, var(--accent) 28%, transparent) !important",
        },
        ".cm-cursor": {
          borderLeftColor: "var(--text)",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        },
      },
      { dark: false },
    ),
  ];
}

/**
 * Editable project file pane (CodeMirror 6).
 * - Syntax highlight by extension
 * - Ctrl/Cmd+S or header Save writes via IPC (with open encoding)
 * - Bottom status bar: encoding switcher (UTF-8 / GBK / …)
 * - Theme + editorFontSize from settings
 */
export function FileEditor({
  rel,
  onClose,
  hidden,
}: {
  rel: string;
  onClose: () => void;
  /** Keep the CodeMirror instance mounted but off-screen when another tab is active. */
  hidden?: boolean;
}) {
  const projectPath = useAppStore((s) => s.projectPath);
  const settings = useAppStore((s) => s.settings);
  const isDark = effectiveTheme(settings?.theme) === "dark";
  const editorFontSize = settings?.editorFontSize ?? 12.5;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedContentRef = useRef<string>("");
  const savingRef = useRef(false);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const encodingRef = useRef("utf-8");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [encoding, setEncoding] = useState("utf-8");
  const [encMenuOpen, setEncMenuOpen] = useState(false);
  const fsChangeTick = useAppStore((s) => (hidden ? 0 : s.fsChangeTick));
  const activeSessionId = useAppStore((s) =>
    hidden ? null : s.activeSessionId,
  );
  const activeChanges = useAppStore((s) =>
    !hidden && s.activeSessionId
      ? (s.changesBySession[s.activeSessionId] ?? EMPTY_CHANGES)
      : EMPTY_CHANGES,
  );

  // Session diff hunks for this file (Cursor/Trae-style inline decorations).
  const changeHunks = useMemo(() => {
    const changes = activeChanges;
    if (!changes.length) return null;
    const norm = (p: string) =>
      p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const isAbs = (p: string) => /^[a-zA-Z]:\//.test(p) || p.startsWith("/");
    const target = norm(
      projectPath && !isAbs(norm(rel))
        ? `${projectPath}/${rel}`
        : rel,
    );
    const hit = changes.find((c) => {
      const cp = norm(c.path);
      return norm(isAbs(cp) || !projectPath ? cp : `${projectPath}/${cp}`) === target;
    });
    return hit?.hunks ?? null;
  }, [activeChanges, activeSessionId, projectPath, rel]);

  const langLabel = useMemo(() => languageLabelForPath(rel), [rel]);
  const canWrite = hasDesktopApi("writeProjectFile");

  encodingRef.current = encoding;

  const save = useCallback(async () => {
    if (!projectPath || !rel || !viewRef.current || savingRef.current) return;
    if (readOnly || truncated || !canWrite) return;
    const content = viewRef.current.state.doc.toString();
    if (content === savedContentRef.current) {
      setDirty(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await getDesktop().writeProjectFile(
        projectPath,
        rel,
        content,
        encodingRef.current,
      );
      if (!res.ok) {
        setSaveMsg(res.error ?? "保存失败");
        return;
      }
      savedContentRef.current = content;
      setDirty(false);
      setSaveMsg("已保存");
      window.setTimeout(() => setSaveMsg(null), 1600);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : String(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [projectPath, rel, readOnly, truncated, canWrite]);

  saveRef.current = save;

  // Hot-update editor font size without remounting
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const host = view.dom.querySelector(".cm-content") as HTMLElement | null;
    const scroller = view.dom.querySelector(".cm-scroller") as HTMLElement | null;
    if (host) host.style.fontSize = `${editorFontSize}px`;
    if (scroller) scroller.style.fontSize = `${editorFontSize}px`;
  }, [editorFontSize]);

  // Load file + mount editor when path / encoding / theme changes
  useEffect(() => {
    if (!projectPath || !rel || !hostRef.current) return;
    let cancelled = false;
    const cached = takeEditorBuffer(projectPath, rel);
    const restored = cached?.encoding === encoding ? cached : undefined;

    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    setLoading(true);
    setError(null);
    setMissing(false);
    setTruncated(false);
    setDirty(false);
    setSaveMsg(null);
    setReadOnly(false);
    setEncMenuOpen(false);
    savedContentRef.current = "";

    void (async () => {
      try {
        // Cap at 256KB for editable buffer — larger files freeze CodeMirror.
        // (IPC hard max remains 2MB; we pass a lower soft cap for the tab.)
        const res = await getDesktop().readProjectFile(
          projectPath,
          rel,
          256 * 1024,
          encoding,
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? "读取失败");
          setLoading(false);
          return;
        }
        const diskText = res.content ?? "";
        const text = restored?.dirty ? restored.content : diskText;
        const savedText = restored?.dirty ? restored.savedContent : diskText;
        const isTrunc = Boolean(res.truncated);
        setTruncated(isTrunc);
        setReadOnly(isTrunc || !canWrite);
        if (res.encoding) {
          setEncoding(res.encoding);
          encodingRef.current = res.encoding;
        }
        savedContentRef.current = savedText;
        setDirty(text !== savedText);

        const lang = languageForPath(rel);
        const saveKey = keymap.of([
          {
            key: "Mod-s",
            run: () => {
              void saveRef.current();
              return true;
            },
            preventDefault: true,
          },
          {
            key: "Mod-f",
            run: openSearchPanel,
          },
        ]);

        const extensions = [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          foldGutter(),
          diffDecoField,
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightSelectionMatches(),
          // VS Code–style find widget at the top
          search({
            top: true,
            createPanel: createVscodeSearchPanel,
          }),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          saveKey,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const next = u.state.doc.toString();
              setDirty(next !== savedContentRef.current);
            }
          }),
          EditorView.theme(
            {
              "&": { height: "100%" },
              ".cm-scroller": {
                overflow: "auto",
                fontSize: `${editorFontSize}px`,
              },
              ".cm-content": {
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: `${editorFontSize}px`,
                lineHeight: "1.55",
                padding: "8px 0",
              },
              ".cm-gutters": {
                minWidth: "40px",
              },
            },
            { dark: isDark },
          ),
          ...themeExtensions(isDark),
          ...(lang ? [lang] : []),
          ...(isTrunc || !canWrite
            ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
            : []),
        ];

        const state = EditorState.create({
          doc: text,
          extensions,
        });
        const view = new EditorView({
          state,
          parent: hostRef.current!,
        });
        viewRef.current = view;
        if (restored) {
          const docLength = view.state.doc.length;
          const anchor = Math.min(Math.max(0, restored.anchor), docLength);
          const head = Math.min(Math.max(0, restored.head), docLength);
          view.dispatch({ selection: { anchor, head } });
          window.requestAnimationFrame(() => {
            if (cancelled || viewRef.current !== view) return;
            view.scrollDOM.scrollTop = restored.scrollTop;
            view.scrollDOM.scrollLeft = restored.scrollLeft;
          });
        }
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      const view = viewRef.current;
      if (view) {
        const selection = view.state.selection.main;
        const content = view.state.doc.toString();
        storeEditorBuffer(projectPath, rel, {
          content,
          savedContent: savedContentRef.current,
          // Capture this effect's decoder, not the mutable ref already updated
          // by a newly selected encoding before React runs cleanup.
          encoding,
          dirty: content !== savedContentRef.current,
          anchor: selection.anchor,
          head: selection.head,
          scrollTop: view.scrollDOM.scrollTop,
          scrollLeft: view.scrollDOM.scrollLeft,
        });
        view.destroy();
        viewRef.current = null;
      } else if (restored) {
        // The async disk probe may have been cancelled before CodeMirror was
        // rebuilt; put the consumed snapshot back so unsaved text survives.
        storeEditorBuffer(projectPath, rel, restored);
      }
    };
    // encoding change intentionally remounts to re-decode bytes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, rel, isDark, canWrite, encoding]);

  // Probe: file deleted/renamed on disk → swap content for a missing notice.
  // Dirty tabs keep their unsaved buffer untouched.
  useEffect(() => {
    if (hidden || !projectPath || !rel || dirty || loading || error) return;
    let cancelled = false;
    void getDesktop()
      .readProjectFile(projectPath, rel, 1, encodingRef.current)
      .then((res) => {
        if (!cancelled) setMissing(!res.ok);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fsChangeTick, hidden]);

  // Push session-change line marks into the editor; re-applied whenever the
  // diff updates (diff:updated) or the tab (re)mounts.
  useEffect(() => {
    if (hidden) return;
    const view = viewRef.current;
    if (!view || loading || error || missing) return;
    view.dispatch({
      effects: setDiffMarks.of(changeHunks ? lineMarksFromHunks(changeHunks) : null),
    });
  }, [changeHunks, hidden, loading, error, missing]);

  const changeEncoding = async (next: string) => {
    if (next === encoding) {
      setEncMenuOpen(false);
      return;
    }
    if (dirty) {
      const ok = window.confirm(
        "切换编码会重新从磁盘读取文件，未保存的修改将丢失。继续？",
      );
      if (!ok) {
        setEncMenuOpen(false);
        return;
      }
    }
    setEncMenuOpen(false);
    setEncoding(next);
  };

  const name = rel.split(/[/\\]/).pop() ?? rel;
  const encLabel =
    FILE_ENCODINGS.find((e) => e.id === encoding)?.label ?? encoding.toUpperCase();

  return (
    <div className={hidden ? "file-editor is-hidden" : "file-editor"} hidden={hidden}>
      <div className="file-editor-head">
        <span className="file-editor-name" title={rel}>
          {name}
          {dirty ? <span className="file-editor-dirty" title="未保存">●</span> : null}
        </span>
        <span className="file-editor-path" title={rel}>
          {rel}
        </span>
        <span className="file-editor-lang" title="语法高亮">
          {langLabel}
        </span>
        {saveMsg ? (
          <span
            className={
              saveMsg === "已保存"
                ? "file-editor-status ok"
                : "file-editor-status err"
            }
          >
            {saveMsg}
          </span>
        ) : null}
        {!readOnly && canWrite ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="保存 (Ctrl/Cmd+S)"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="关闭"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {error ? (
        <p className="file-editor-hint">无法打开：{error}</p>
      ) : missing ? (
        <div className="file-editor-missing">
          <p className="file-editor-hint">
            文件已被删除或移动，内容已不存在。
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            关闭标签
          </button>
        </div>
      ) : (
        <>
          {truncated ? (
            <p className="file-editor-hint">
              内容过长已截断，只读预览。请用外部编辑器打开完整文件。
            </p>
          ) : null}
          {!canWrite && !loading ? (
            <p className="file-editor-hint">
              当前预加载未暴露写入接口，请完全重启应用后再编辑。
            </p>
          ) : null}
          <div
            className="file-editor-body file-editor-cm"
            ref={hostRef}
            style={{ display: error || missing ? "none" : undefined }}
          />
          {loading ? <p className="file-editor-hint">加载中…</p> : null}
        </>
      )}

      {/* Status bar: encoding */}
      <div className="file-editor-statusbar">
        <span className="file-editor-statusbar-item muted">{langLabel}</span>
        <div className="file-editor-enc">
          <button
            type="button"
            className="file-editor-enc-btn"
            title="切换打开编码"
            onClick={() => setEncMenuOpen((v) => !v)}
          >
            {encLabel}
            <span className="file-editor-enc-caret">▾</span>
          </button>
          {encMenuOpen ? (
            <div className="file-editor-enc-menu" role="menu">
              {FILE_ENCODINGS.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="menuitem"
                  className={
                    e.id === encoding
                      ? "file-editor-enc-item active"
                      : "file-editor-enc-item"
                  }
                  onClick={() => void changeEncoding(e.id)}
                >
                  {e.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
