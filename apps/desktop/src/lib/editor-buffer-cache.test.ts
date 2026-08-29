import { afterEach, describe, expect, it } from "vitest";
import {
  clearEditorBufferCache,
  getEditorBufferCacheSize,
  MAX_CACHED_EDITOR_BUFFERS,
  storeEditorBuffer,
  takeEditorBuffer,
} from "./editor-buffer-cache";

function snapshot(id: number, dirty = false) {
  return {
    content: `content-${id}`,
    savedContent: dirty ? `saved-${id}` : `content-${id}`,
    encoding: "utf-8",
    dirty,
    anchor: id,
    head: id,
    scrollTop: id,
    scrollLeft: 0,
  };
}

describe("editor-buffer-cache", () => {
  afterEach(clearEditorBufferCache);

  it("caps clean snapshots and evicts the oldest first", () => {
    for (let i = 0; i < MAX_CACHED_EDITOR_BUFFERS + 2; i += 1) {
      storeEditorBuffer("D:/p", `f${i}.ts`, snapshot(i));
    }
    expect(getEditorBufferCacheSize()).toBe(MAX_CACHED_EDITOR_BUFFERS);
    expect(takeEditorBuffer("D:/p", "f0.ts")).toBeUndefined();
    expect(takeEditorBuffer("D:/p", "f2.ts")?.content).toBe("content-2");
  });

  it("never evicts unsaved buffers and consumes a restored snapshot", () => {
    for (let i = 0; i < MAX_CACHED_EDITOR_BUFFERS + 1; i += 1) {
      storeEditorBuffer("D:/p", `dirty-${i}.ts`, snapshot(i, true));
    }
    expect(getEditorBufferCacheSize()).toBe(MAX_CACHED_EDITOR_BUFFERS + 1);
    expect(takeEditorBuffer("D:/p", "dirty-0.ts")?.dirty).toBe(true);
    expect(getEditorBufferCacheSize()).toBe(MAX_CACHED_EDITOR_BUFFERS);
  });
});
