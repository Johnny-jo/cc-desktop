import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIFF_HISTORY_HUNK_CHARS,
  DIFF_MAX_CHARS,
  DIFF_MAX_EVENTS_PER_FILE,
  type ChatItem,
  type FileChange,
} from "@claude-desktop/shared";
import {
  SessionArchive,
  TRANSCRIPT_CHUNK_ITEMS,
} from "./session-archive";

describe("SessionArchive", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
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
    const dir = tmpDir();
    const arch = new SessionArchive(dir);
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
    const raw = fs.readFileSync(
      path.join(dir, "sessions", "s1.transcript", "chunk-000000.json"),
      "utf8",
    );
    expect(raw.includes("\n  ")).toBe(false);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(dir, "sessions", "s1.transcript", "manifest.json"),
        "utf8",
      ),
    ) as { version: number; total: number };
    expect(manifest).toMatchObject({ version: 2, total: 2 });
  });

  it("loads legacy transcripts and migrates them on the next save", () => {
    const dir = tmpDir();
    const sessionsDir = path.join(dir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "legacy.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy",
        items: [{ kind: "text", id: "m1", role: "user", text: "old" }],
      }),
      "utf8",
    );

    const arch = new SessionArchive(dir);
    const items = arch.loadItems("legacy");
    expect(items.map((item) => item.id)).toEqual(["m1"]);
    arch.saveItems("legacy", items);

    expect(fs.existsSync(path.join(sessionsDir, "legacy.json"))).toBe(false);
    expect(
      fs.existsSync(path.join(sessionsDir, "legacy.transcript", "manifest.json")),
    ).toBe(true);
    expect(arch.loadItems("legacy").map((item) => item.id)).toEqual(["m1"]);
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
    expect(tail.hasNewer).toBe(false);

    const older = arch.loadItemsPage("s1", { beforeId: "m3", limit: 2 });
    expect(older.items.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(older.hasMore).toBe(true);
    expect(older.hasNewer).toBe(true);

    const rest = arch.loadItemsPage("s1", { beforeId: "m1", limit: 2 });
    expect(rest.items.map((i) => i.id)).toEqual(["m0"]);
    expect(rest.hasMore).toBe(false);
    expect(rest.hasNewer).toBe(true);
  });

  it("pages newer slices after afterId without dropping disk history", () => {
    const arch = new SessionArchive(tmpDir());
    const items: ChatItem[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "text",
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: String(i),
    }));
    arch.saveItems("s1", items);

    const newer = arch.loadItemsPage("s1", { afterId: "m1", limit: 2 });
    expect(newer.items.map((i) => i.id)).toEqual(["m2", "m3"]);
    expect(newer.hasMore).toBe(true);
    expect(newer.hasNewer).toBe(true);

    const last = arch.loadItemsPage("s1", { afterId: "m3", limit: 2 });
    expect(last.items.map((i) => i.id)).toEqual(["m4"]);
    expect(last.hasMore).toBe(true);
    expect(last.hasNewer).toBe(false);

    const miss = arch.loadItemsPage("s1", { afterId: "nope", limit: 2 });
    expect(miss.items).toEqual([]);
  });

  it("reads only chunks intersecting a requested page", () => {
    const dir = tmpDir();
    const arch = new SessionArchive(dir);
    const items: ChatItem[] = Array.from(
      { length: TRANSCRIPT_CHUNK_ITEMS * 2 + 5 },
      (_, i) => ({
        kind: "text",
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        text: String(i),
      }),
    );
    arch.saveItems("s1", items);

    // If paging loaded the whole transcript, the unrelated missing first chunk
    // would make this fail. The tail lives entirely in chunk 2.
    fs.rmSync(
      path.join(
        dir,
        "sessions",
        "s1.transcript",
        "chunk-000000.json",
      ),
    );
    const tail = arch.loadItemsPage("s1", { limit: 5 });
    expect(tail.items.map((item) => item.id)).toEqual([
      `m${TRANSCRIPT_CHUNK_ITEMS * 2}`,
      `m${TRANSCRIPT_CHUNK_ITEMS * 2 + 1}`,
      `m${TRANSCRIPT_CHUNK_ITEMS * 2 + 2}`,
      `m${TRANSCRIPT_CHUNK_ITEMS * 2 + 3}`,
      `m${TRANSCRIPT_CHUNK_ITEMS * 2 + 4}`,
    ]);
  });

  it("rewrites only the dirty tail chunk when appending", () => {
    const arch = new SessionArchive(tmpDir());
    const items: ChatItem[] = Array.from(
      { length: TRANSCRIPT_CHUNK_ITEMS + 2 },
      (_, i) => ({
        kind: "text",
        id: `m${i}`,
        role: "assistant",
        text: String(i),
      }),
    );
    arch.saveItems("s1", items);
    const write = vi.spyOn(fs, "writeFileSync");

    arch.saveItems("s1", [
      ...items,
      { kind: "text", id: "new", role: "assistant", text: "new" },
    ]);

    const writtenFiles = write.mock.calls.map(([file]) => String(file));
    expect(writtenFiles.some((file) => file.includes("chunk-000001.json"))).toBe(
      true,
    );
    expect(writtenFiles.some((file) => file.includes("chunk-000000.json"))).toBe(
      false,
    );
    write.mockRestore();
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

  it("compacts oversized legacy change histories while loading", () => {
    const dir = tmpDir();
    const arch = new SessionArchive(dir);
    const total = DIFF_MAX_EVENTS_PER_FILE + 9;
    const events = Array.from({ length: total }, (_, i) => ({
      id: `legacy-event-${i}`,
      tool: "Edit" as const,
      at: i + 1,
      hunk: `${i}:${"x".repeat(
        i === total - 1 ? DIFF_MAX_CHARS + 100 : DIFF_HISTORY_HUNK_CHARS + 100,
      )}`,
    }));
    fs.writeFileSync(
      path.join(dir, "sessions", "legacy.changes.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy",
        changes: [
          {
            path: "large.ts",
            status: "M",
            hunks: events.at(-1)!.hunk,
            updatedAt: total,
            events,
          },
        ],
      }),
      "utf8",
    );

    const [loaded] = arch.loadChanges("legacy");
    expect(loaded.events).toHaveLength(DIFF_MAX_EVENTS_PER_FILE);
    expect(loaded.events[0]!.id).toBe("legacy-event-0");
    expect(loaded.events.at(-1)!.id).toBe(`legacy-event-${total - 1}`);
    expect(loaded.events[0]!.hunk.length).toBeLessThanOrEqual(
      DIFF_HISTORY_HUNK_CHARS,
    );
    expect(loaded.events.at(-1)!.hunk.length).toBeLessThanOrEqual(DIFF_MAX_CHARS);
  });

  it("persists pinned and sorts pinned sessions first", () => {
    const arch = new SessionArchive(tmpDir());
    arch.upsertSummary({
      id: "old-pinned",
      title: "pinned",
      cwd: "D:/proj",
      updatedAt: 100,
      status: "idle",
      pinned: true,
    });
    arch.upsertSummary({
      id: "newer",
      title: "newer",
      cwd: "D:/proj",
      updatedAt: 200,
      status: "idle",
    });
    const list = arch.loadIndex();
    expect(list[0].id).toBe("old-pinned"); // pinned beats recency
    expect(list[0].pinned).toBe(true);
    expect(list.find((s) => s.id === "newer")?.pinned).toBeUndefined();
  });

  it("remove drops the session from the index and deletes its files", () => {
    const dir = tmpDir();
    const arch = new SessionArchive(dir);
    arch.upsertSummary({
      id: "s1",
      title: "gone",
      cwd: "D:/proj",
      updatedAt: 100,
      status: "idle",
    });
    arch.upsertSummary({
      id: "s2",
      title: "kept",
      cwd: "D:/proj",
      updatedAt: 200,
      status: "idle",
    });
    arch.saveItems("s1", [{ kind: "text", id: "m1", role: "user", text: "hi" }]);
    arch.saveChanges("s1", [
      { path: "a.ts", status: "M", hunks: "+x", updatedAt: 1, events: [] },
    ]);
    const sessDir = path.join(dir, "sessions");
    expect(fs.existsSync(path.join(sessDir, "s1.transcript"))).toBe(true);

    arch.remove("s1");
    expect(arch.loadIndex().map((s) => s.id)).toEqual(["s2"]);
    expect(fs.existsSync(path.join(sessDir, "s1.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessDir, "s1.transcript"))).toBe(false);
    expect(fs.existsSync(path.join(sessDir, "s1.changes.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessDir, "s2.json"))).toBe(false);
  });
});
