import fs from "node:fs";
import path from "node:path";
import { guessMimeType, MODEL_ATTACHMENT_LIMITS, modelAttachmentError } from "@claude-desktop/shared";
import type {
  Attachment,
  ReadAttachmentResult,
  UserContentBlock,
  UserPrompt,
} from "@claude-desktop/shared";

export type { Attachment, UserPrompt, UserContentBlock };

/** Maximum size for text attachments (bytes). */
export const MAX_TEXT_ATTACHMENT_SIZE = MODEL_ATTACHMENT_LIMITS.textBytes;

/** Maximum size for image attachments (bytes). */
export const MAX_IMAGE_ATTACHMENT_SIZE = MODEL_ATTACHMENT_LIMITS.imageBytes;

/** Maximum size for PDF attachments (bytes). */
export const MAX_PDF_ATTACHMENT_SIZE = MODEL_ATTACHMENT_LIMITS.pdfBytes;

function isImageMimeType(
  mime: string,
): mime is "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  return (
    mime === "image/jpeg" ||
    mime === "image/png" ||
    mime === "image/gif" ||
    mime === "image/webp"
  );
}

function readAsBase64(filePath: string): string {
  return fs.readFileSync(filePath).toString("base64");
}

function readAsText(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) throw new Error("binary");
    return text;
  } catch { throw new Error("文件不是有效的 UTF-8 文本，请另存为 UTF-8 或转换为 PDF"); }
}

function truncatedFileName(name: string): string {
  if (name.length <= 48) return name;
  return `${name.slice(0, 48)}…`;
}

export function readAttachment(attachment: Attachment): ReadAttachmentResult {
  try {
    if (!fs.existsSync(attachment.path)) return { ok: false, error: `File not found: ${attachment.path}` };
    const stats = fs.statSync(attachment.path);
    if (!stats.isFile()) return { ok: false, error: `Not a file: ${attachment.path}` };
    const inferred = guessMimeType(attachment.name);
    attachment = { ...attachment, size: stats.size,
      mimeType: inferred === "application/octet-stream" ? attachment.mimeType : inferred };
    const invalid = modelAttachmentError(attachment);
    if (invalid) return { ok: false, error: invalid };

    if (attachment.mimeType.startsWith("image/")) {
      if (attachment.size > MAX_IMAGE_ATTACHMENT_SIZE) {
        return {
          ok: false,
          error: `Image ${attachment.name} exceeds ${MAX_IMAGE_ATTACHMENT_SIZE / 1024 / 1024} MB`,
        };
      }
      if (!isImageMimeType(attachment.mimeType)) {
        return { ok: false, error: `Unsupported image type: ${attachment.mimeType}` };
      }
      const data = readAsBase64(attachment.path);
      const block: UserContentBlock = {
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data,
        },
      };
      return { ok: true, block };
    }

    if (attachment.mimeType === "application/pdf") {
      if (attachment.size > MAX_PDF_ATTACHMENT_SIZE) {
        return {
          ok: false,
          error: `PDF ${attachment.name} exceeds ${MAX_PDF_ATTACHMENT_SIZE / 1024 / 1024} MB`,
        };
      }
      const data = readAsBase64(attachment.path);
      const block: UserContentBlock = {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data },
      };
      return { ok: true, block };
    }

    // Only supported text reaches this branch. Office/unknown binary formats
    // must never be decoded as UTF-8 and sent to the model as garbage.
    if (attachment.size > MAX_TEXT_ATTACHMENT_SIZE) {
      return {
        ok: false,
        error: `Text file ${attachment.name} exceeds ${MAX_TEXT_ATTACHMENT_SIZE / 1024} KB`,
      };
    }
    const text = readAsText(attachment.path);
    const ext = path.extname(attachment.name).slice(1);
    const block: UserContentBlock = {
      type: "text",
      text: `File: ${truncatedFileName(attachment.name)}\n\`\`\`${ext || "text"}\n${text}\n\`\`\``,
    };
    return { ok: true, block };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read ${attachment.name}: ${message}` };
  }
}

export function buildUserContent(prompt: UserPrompt): {
  content: string | UserContentBlock[];
  errors: string[];
} {
  const { text, attachments } = prompt;
  if (!attachments.length) {
    return { content: text, errors: [] };
  }

  const blocks: UserContentBlock[] = [];
  if (text.trim()) {
    blocks.push({ type: "text", text });
  }
  const errors: string[] = [];
  for (const attachment of attachments) {
    const result = readAttachment(attachment);
    if (result.ok) {
      blocks.push(result.block);
    } else {
      errors.push(result.error);
    }
  }
  return { content: blocks, errors };
}
