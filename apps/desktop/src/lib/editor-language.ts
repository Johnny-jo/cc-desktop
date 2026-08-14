import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { vue } from "@codemirror/lang-vue";

/**
 * Map a project-relative path to a CodeMirror language extension.
 * Covers the common stack the desktop editor is expected to open.
 */
export function languageForPath(rel: string): Extension | null {
  const base = rel.split(/[/\\]/).pop() ?? rel;
  const lower = base.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";

  // Special filenames
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) {
    // no dedicated dockerfile pack; plain text is fine
    return null;
  }

  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" });
    case "vue":
      return vue();
    case "py":
    case "pyw":
    case "pyi":
      return python();
    case "java":
      return java();
    case "go":
      return go();
    case "html":
    case "htm":
    case "svelte":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "sql":
      return sql();
    case "xml":
    case "svg":
    case "plist":
      return xml();
    case "yml":
    case "yaml":
      return yaml();
    default:
      return null;
  }
}

/** Short language label shown in the editor header. */
export function languageLabelForPath(rel: string): string {
  const base = rel.split(/[/\\]/).pop() ?? rel;
  const lower = base.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const map: Record<string, string> = {
    js: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    jsx: "JSX",
    ts: "TypeScript",
    mts: "TypeScript",
    cts: "TypeScript",
    tsx: "TSX",
    vue: "Vue",
    py: "Python",
    pyw: "Python",
    pyi: "Python",
    java: "Java",
    go: "Go",
    html: "HTML",
    htm: "HTML",
    css: "CSS",
    scss: "SCSS",
    less: "Less",
    json: "JSON",
    jsonc: "JSON",
    md: "Markdown",
    mdx: "MDX",
    markdown: "Markdown",
    sql: "SQL",
    xml: "XML",
    svg: "SVG",
    yml: "YAML",
    yaml: "YAML",
    svelte: "Svelte",
  };
  return map[ext] ?? (ext ? ext.toUpperCase() : "Text");
}
