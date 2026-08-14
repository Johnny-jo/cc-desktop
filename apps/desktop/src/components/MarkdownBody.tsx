import React, { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className={`md-body${streaming ? " streaming" : ""}`}>
      {streaming ? (
        <div className="md-stream-plain">{text}</div>
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {text}
        </ReactMarkdown>
      )}
      {streaming ? <span className="cursor">▍</span> : null}
    </div>
  );
});
