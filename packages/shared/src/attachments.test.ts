import { describe, expect, it } from "vitest";
import {
  attachmentFromFile,
  attachmentKindFromMime,
  formatFileSize,
  guessMimeType,
} from "./attachments";

describe("attachments", () => {
  it("guesses common mime types", () => {
    expect(guessMimeType("foo.png")).toBe("image/png");
    expect(guessMimeType("bar.jpg")).toBe("image/jpeg");
    expect(guessMimeType("baz.pdf")).toBe("application/pdf");
    expect(guessMimeType("note.txt")).toBe("text/plain");
  });

  it("classifies image and text attachments", () => {
    expect(attachmentKindFromMime("image/png")).toBe("image");
    expect(attachmentKindFromMime("text/plain")).toBe("text");
    expect(attachmentKindFromMime("application/json")).toBe("text");
    expect(attachmentKindFromMime("application/pdf")).toBe("binary");
  });

  it("builds an attachment from a file descriptor", () => {
    const a = attachmentFromFile({
      name: "test.png",
      path: "/tmp/test.png",
      size: 2048,
      type: "image/png",
    });
    expect(a).toMatchObject({
      name: "test.png",
      path: "/tmp/test.png",
      size: 2048,
      mimeType: "image/png",
      kind: "image",
    });
  });

  it("formats file sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.00 MB");
  });
});
