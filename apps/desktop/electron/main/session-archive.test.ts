import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionArchive } from "./session-archive";
import type { ChatItem, FileChange } from "@claude-desktop/shared";

describe("SessionArchive", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    dirs.length = 0;
  });

  function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sess-arch-"));
    dirs.push(d);
    return d;
  }

  it("persists and reloads session index with cwd", () => {
    const arch = new SessionArchive(tmpDir());
    arch.upsertSummary({
      id: "s1",
      title: "hello world",
      cwd: "D:/gitrep/foo",
      updatedAt: 100,
      status: "idle",
      sdkSessionId: "sdk-1",
    });
    arch.upsertSummary({
      id: "s2",
      title: "other",
      cwd: "D:/citrep/bar",
      updatedAt: 200,
      status: "idle",
    });

    const list = arch.loadIndex();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("s2"); // newer first
    expect(list.find((s) => s.id === "s1")?.cwd).toBe("D:/gitrep/foo");
    expect(list.find((s) => s.id === "s1")?.sdkSessionId).toBe("sdk-1");
  });

  it("persists and reloads hiddenFromList", () => {
    const arch = new SessionArchive(tmpDir());
    arch.upsertSummary({
      id: "hidden",
      title: "[room_mod] Bot",
      cwd: "D:/proj",
      updatedAt: 50,
      status: "idle",
      hiddenFromList: true,
    });
    arch.upsertSummary({
      id: "visible",
      title: "normal",
      cwd: "D:/proj",
      updatedAt: 40,
      status: "idle",
    });
    const list = arch.loadIndex();
    expect(list.find((s) => s.id === "hidden")?.hiddenFromList).toBe(true);
    expect(list.find((s) => s.id === "visible")?.hiddenFromList).toBeUndefined();
  });

  it("persists transcript items", () => {
    const arch = new SessionArchive(tmpDir());
    const items: ChatItem[] = [
      { kind: "text", id: "u1", role: "user", text: "hi", streaming: true },
      { kind: "text", id: "a1", role: "assistant", text: "hello" },
    ];
    arch.saveItems("s1", items);
    const loaded = arch.loadItems("s1");
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({
      kind: "text",
      role: "user",
      text: "hi",
      streaming: false,
    });
    expect(loaded[1]).toMatchObject({ role: "assistant", text: "hello" });
  });

  it("returns empty for missing transcript", () => {
    const arch = new SessionArchive(tmpDir());
    expect(arch.loadItems("missing")).toEqual([]);
  });

  it("pages the tail and older slices without dropping disk history", () => {
    const arch = new SessionArchive(tmpDir());
    const items: ChatItem[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "text",
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: String(i),
    }));
    arch.saveItems("s1", items);

    const tail = arch.loadItemsPage("s1", { limit: 2 });
    expect(tail.items.map((i) => i.id)).toEqual(["m3", "m4"]);
    expect(tail.total).toBe(5);
    expect(tail.hasMore).toBe(true);

    const older = arch.loadItemsPage("s1", { beforeId: "m3", limit: 2 });
    expect(older.items.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(older.hasMore).toBe(true);

    const rest = arch.loadItemsPage("s1", { beforeId: "m1", limit: 2 });
    expect(rest.items.map((i) => i.id)).toEqual(["m0"]);
    expect(rest.hasMore).toBe(false);
  });

  it("mergeSaveItems updates the tail without wiping unread history", () => {
    const arch = new SessionArchive(tmpDir());
    arch.saveItems("s1", [
      { kind: "text", id: "old", role: "user", text: "old" },
      { kind: "text", id: "mid", role: "assistant", text: "mid" },
    ]);
    arch.mergeSaveItems("s1", [
      { kind: "text", id: "mid", role: "assistant", text: "mid-upd" },
      { kind: "text", id: "new", role: "user", text: "new" },
    ]);
    const loaded = arch.loadItems("s1");
    expect(loaded.map((i) => i.id)).toEqual(["old", "mid", "new"]);
    expect(loaded[1]).toMatchObject({ id: "mid", text: "mid-upd" });
  });

  it("persists and reloads file changes", () => {
    const arch = new SessionArchive(tmpDir());
    const changes: FileChange[] = [
      {
        path: "src/a.ts",
        status: "M",
        hunks: "--- a/src/a.ts\n+++ b/src/a.ts\n+hello",
        updatedAt: 123,
        events: [{ id: "ev-1", tool: "Edit", at: 123, hunk: "+hello" }],
      },
      {
        path: "UIManager.cs",
        status: "A",
        hunks: "@@ new file\n+using UnityEngine;",
        updatedAt: 124,
        events: [
          { id: "ev-2", tool: "Bash", at: 124, hunk: "+using UnityEngine;" },
        ],
      },
    ];
    arch.saveChanges("s1", changes);
    const loaded = arch.loadChanges("s1");
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ path: "src/a.ts", status: "M" });
    expect(loaded[1]).toMatchObject({
      path: "UIManager.cs",
      status: "A",
    });
    expect(loaded[1].events[0]?.tool).toBe("Bash");
  });
});
