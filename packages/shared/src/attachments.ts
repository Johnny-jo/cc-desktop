import type {
  Attachment,
  AttachmentKind,
  ImageMimeType,
} from "./models";

export type { Attachment, AttachmentKind, ImageMimeType };

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "xml",
  "yaml",
  "yml",
  "toml",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "cmd",
  "bat",
  "log",
  "csv", "tsv", "jsonc", "jsonl", "ndjson", "ini", "cfg", "conf",
  "sql", "vue", "svelte", "mdx", "rst", "tex", "diff", "patch",
  "env", "gitignore", "gitattributes", "dockerignore", "npmrc", "editorconfig",
  "lock", "properties", "svg", "ipynb", "graphql", "gql", "mts", "cts",
  "cc", "cxx", "hxx", "hh", "kt", "kts", "swift", "lua", "r", "pl", "psm1", "psd1",
]);

function extname(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Guess MIME type from filename (fallback for files without type info). */
export function guessMimeType(name: string): string {
  const ext = extname(name);
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    case "js":
    case "mjs":
    case "cjs":
      return "application/javascript";
    case "ts":
      return "application/typescript";
    case "html":
    case "htm":
      return "text/html";
    case "css":
      return "text/css";
    case "xml":
      return "application/xml";
    case "yaml":
    case "yml":
      return "application/yaml";
    default:
      return TEXT_EXTENSIONS.has(ext) || /^(readme|license|dockerfile|makefile)(\.|$)/i.test(name.split(/[/\\]/).pop() ?? "")
        ? "text/plain" : "application/octet-stream";
  }
}

export function attachmentKindFromMime(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp"
  )
    return "image";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "application/typescript" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    TEXT_EXTENSIONS.has(extname(mimeType))
  ) {
    return "text";
  }
  return "binary";
}

export function attachmentFromFile(
  file: { name: string; path: string; size: number; type?: string },
): Attachment {
  const mimeType = file.type || guessMimeType(file.name);
  return {
    name: file.name,
    path: file.path,
    size: file.size,
    mimeType,
    kind: attachmentKindFromMime(mimeType),
  };
}

/** Format a byte size for UI. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const MODEL_ATTACHMENT_LIMITS = {
  count: 5,
  imageBytes: 5 * 1024 * 1024,
  textBytes: 5 * 1024 * 1024,
  pdfBytes: 10 * 1024 * 1024,
} as const;

/** Display types are user-facing, independent of the transport's binary/text enum. */
export function attachmentPresentation(name: string, mimeType = "") {
  const ext = extname(name);
  const category = ext === "pdf" || mimeType === "application/pdf" ? "pdf"
    : ["doc", "docx", "rtf", "odt"].includes(ext) ? "word"
    : ["xls", "xlsx", "csv", "tsv", "ods"].includes(ext) ? "sheet"
    : ["json", "jsonc", "jsonl", "xml", "yaml", "yml", "toml"].includes(ext) ? "code"
    : ["txt", "md", "markdown", "log"].includes(ext) ? "text"
    : mimeType.startsWith("image/") ? "image" : "file";
  const label = category === "word" ? "Word 文档" : category === "sheet" ? "电子表格"
    : category === "pdf" ? "PDF 文档" : category === "text" ? "文本文档"
    : category === "image" ? "图片" : ext ? `${ext.toUpperCase()} 文件` : "文件";
  return { category, label, extension: ext.toUpperCase().slice(0, 5) || "FILE" };
}

/** One support/size contract for both the composer and the main-process reader. */
export function modelAttachmentError(attachment: Attachment): string | null {
  const inferred = guessMimeType(attachment.name);
  const mime = inferred === "application/octet-stream" ? attachment.mimeType : inferred;
  if (!Number.isFinite(attachment.size) || attachment.size < 0) return `${attachment.name}：文件大小无效`;
  const limit = mime === "application/pdf" ? MODEL_ATTACHMENT_LIMITS.pdfBytes
    : ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime) ? MODEL_ATTACHMENT_LIMITS.imageBytes
    : attachmentKindFromMime(mime) === "text" ? MODEL_ATTACHMENT_LIMITS.textBytes : null;
  if (limit === null) return `${attachment.name}：暂不支持直接读取此格式，请先转换为 PDF 或 TXT`;
  return attachment.size > limit ? `${attachment.name}：文件超过 ${formatFileSize(limit)} 限制` : null;
}
