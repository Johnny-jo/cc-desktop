import React, { memo, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownFileLink } from "../lib/markdown-file-link";
import { resolvePath } from "../lib/project-path";
import { getDesktop } from "../lib/desktop-api";

const mdComponents = {
  a: ({
    href,
    children,
  }: {
    href?: string;
    children?: React.ReactNode;
  }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  // Avoid giant empty paragraphs from trailing newlines during stream
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="md-p">{children}</p>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  code: ({
    className,
    children,
    ...props
  }: {
    className?: string;
    children?: React.ReactNode;
  }) => {
    const isBlock = Boolean(className?.includes("language-"));
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="md-inline-code" {...props}>
        {children}
      </code>
    );
  },
};

/**
 * Render assistant (and optional system) message text as Markdown.
 * While streaming, keep a cheap plain-text node so every token does not
 * re-parse GFM. Final `text_done` flips streaming off and mounts markdown once.
 */
export const MarkdownBody = memo(function MarkdownBody({
  text,
  streaming,
  projectPath,
  onOpenFile,
}: {
  text: string;
  streaming?: boolean;
  projectPath?: string | null;
  onOpenFile?: (rel: string, line?: number) => void;
}) {
  const [openError, setOpenError] = useState("");
  const components = useMemo(() => ({
    ...mdComponents,
    a: ({ href = "", children }: { href?: string; children?: React.ReactNode }) => {
      const file = markdownFileLink(projectPath, href);
      if (file) {
        if (!onOpenFile && !/\.(md|markdown|txt|log|csv|json|ya?ml)$/i.test(file.rel)) return <span>{children}</span>;
        const open = () => {
          setOpenError("");
          if (onOpenFile) onOpenFile(file.rel, file.line);
          else {
            void getDesktop().openInEditor(resolvePath(projectPath ?? null, file.rel))
              .then(result => { if (!result.ok) setOpenError(result.error || file.rel); })
              .catch(error => setOpenError(String(error)));
          }
        };
        return <a href={href} title={file.rel} onClick={event => { event.preventDefault(); open(); }}
          onAuxClick={event => { if (event.button === 1) { event.preventDefault(); open(); } }}>{children}</a>;
      }
      if (projectPath && !/^(https?:\/\/|mailto:|#)/i.test(href)) return <span>{children}</span>;
      return mdComponents.a({ href, children });
    },
  }), [projectPath, onOpenFile]);
  return (
    <div className={`md-body${streaming ? " streaming" : ""}`}>
      {streaming ? (
        <div className="md-stream-plain">{text}</div>
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}
          urlTransform={(url, key) => key === "href" && markdownFileLink(projectPath, url) ? url : defaultUrlTransform(url)}>
          {text}
        </ReactMarkdown>
      )}
      {streaming ? <span className="cursor">▍</span> : null}
      {openError ? <span role="alert" className="file-editor-status err">{openError}</span> : null}
    </div>
  );
});
