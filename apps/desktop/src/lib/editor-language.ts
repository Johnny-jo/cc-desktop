import type { Extension } from "@codemirror/state";

function extensionForPath(rel: string): { lower: string; ext: string } {
  const base = rel.split(/[/\\]/).pop() ?? rel;
  const lower = base.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return { lower, ext };
}

const SUPPORTED_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "vue",
  "py",
  "pyw",
  "pyi",
  "java",
  "go",
  "html",
  "htm",
  "svelte",
  "css",
  "scss",
  "less",
  "json",
  "jsonc",
  "md",
  "mdx",
  "markdown",
  "sql",
  "xml",
  "svg",
  "plist",
  "yml",
  "yaml",
]);

/** Cheap synchronous capability check; does not load a parser bundle. */
export function hasLanguageForPath(rel: string): boolean {
  const { lower, ext } = extensionForPath(rel);
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return false;
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Map a project-relative path to a CodeMirror language extension.
 * Covers the common stack the desktop editor is expected to open.
 */
export async function loadLanguageForPath(rel: string): Promise<Extension | null> {
  const { lower, ext } = extensionForPath(rel);

  // Special filenames
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) {
    // no dedicated dockerfile pack; plain text is fine
    return null;
  }

  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: true });
    }
    case "ts":
    case "mts":
    case "cts":
    case "tsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: true, jsx: ext === "tsx" });
    }
    case "vue": {
      const { vue } = await import("@codemirror/lang-vue");
      return vue();
    }
    case "py":
    case "pyw":
    case "pyi": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    case "java": {
      const { java } = await import("@codemirror/lang-java");
      return java();
    }
    case "go": {
      const { go } = await import("@codemirror/lang-go");
      return go();
    }
    case "html":
    case "htm":
    case "svelte": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "css":
    case "scss":
    case "less": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "json":
    case "jsonc": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "md":
    case "mdx":
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    case "sql": {
      const { sql } = await import("@codemirror/lang-sql");
      return sql();
    }
    case "xml":
    case "svg":
    case "plist": {
      const { xml } = await import("@codemirror/lang-xml");
      return xml();
    }
    case "yml":
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    default:
      return null;
  }
}

/** Short language label shown in the editor header. */
export function languageLabelForPath(rel: string): string {
  const { ext } = extensionForPath(rel);
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
