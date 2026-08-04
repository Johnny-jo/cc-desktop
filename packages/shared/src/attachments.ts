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
      return "text/plain";
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
