import { describe, expect, it } from "vitest";
import {
  hasLanguageForPath,
  languageLabelForPath,
  loadLanguageForPath,
} from "./editor-language";

describe("editor-language", () => {
  it("detects supported files without loading a language parser", () => {
    expect(hasLanguageForPath("src/App.tsx")).toBe(true);
    expect(hasLanguageForPath("README.md")).toBe(true);
    expect(hasLanguageForPath("assets/logo.png")).toBe(false);
    expect(hasLanguageForPath("Dockerfile")).toBe(false);
  });

  it("loads only the parser requested by the file extension", async () => {
    await expect(loadLanguageForPath("src/App.tsx")).resolves.not.toBeNull();
    await expect(loadLanguageForPath("notes.unknown")).resolves.toBeNull();
    expect(languageLabelForPath("src/App.tsx")).toBe("TSX");
  });
});
