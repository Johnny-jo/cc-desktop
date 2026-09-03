import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatItem,
  FileChange,
  RoomTimelineItem,
} from "@claude-desktop/shared";
import { AppDatabase } from "./app-database";
import { HostRoomKv } from "./mod-kernel-store";
import { RoomArchive, type StoredRoom } from "./room-archive";
import { SessionArchive } from "./session-archive";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-db-"));
  dirs.push(dir);
  return dir;
}

function item(id: string, text: string): RoomTimelineItem {
  return {
    id,
    at: Date.now(),
    seatId: "seat-1",
    authorUserId: "user-1",
    authorLabel: "user",
    kind: "user",
    text,
  };
}

function room(items: RoomTimelineItem[]): StoredRoom {
  return {
    roomId: "room-1",
    name: "sqlite room",
    status: "open",
    role: "host",
    port: 18765,
    inviteHost: "127.0.0.1",
    memberCount: 1,
    updatedAt: Date.now(),
    items,
  };
}

describe("AppDatabase RoomArchive + Mod KV", () => {
  it("round-trips timeline deltas and preserves their order", () => {
    const archive = new RoomArchive(tmp());
    const first = item("a", "one");
    const second = item("b", "two");
    archive.saveRoom(room([first, second]));

    const recalled = { ...second, text: "", recalled: true };
    const third = item("c", "three");
    archive.saveRoom(room([recalled, third]));

    expect(archive.loadRoom("room-1")?.items).toEqual([recalled, third]);
    if (process.versions.electron) {
      expect(archive.database).not.toBeNull();
    }
    archive.close();
  });

  it("imports legacy Room JSON without deleting the source", () => {
    const dir = tmp();
    const root = path.join(dir, "rooms");
    fs.mkdirSync(root, { recursive: true });
    const legacy = room([item("legacy-item", "from json")]);
    fs.writeFileSync(
      path.join(root, "index.json"),
      JSON.stringify({ version: 1, rooms: [legacy] }),
      "utf8",
    );

    const archive = new RoomArchive(dir);
    expect(archive.loadRoom(legacy.roomId)?.items[0]?.text).toBe("from json");
    expect(fs.existsSync(path.join(root, "index.json"))).toBe(true);
    archive.close();
  });

  it("migrates Mod KV and then updates individual keys", () => {
    const dir = tmp();
    const file = path.join(dir, "room-kv.json");
    fs.writeFileSync(file, JSON.stringify({ memory: { old: "legacy" } }), "utf8");
    const archive = new RoomArchive(dir);
    const kv = new HostRoomKv(file, archive.database, "room-1");

    expect(kv.namespace("memory").get("old")).toBe("legacy");
    expect(kv.namespace("memory").set("new", "sqlite")).toEqual({ ok: true });
    expect(kv.remove("memory", "old")).toEqual({ ok: true });

    const again = new HostRoomKv(file, archive.database, "room-1");
    expect(again.namespace("memory").get("old")).toBeUndefined();
    expect(again.namespace("memory").get("new")).toBe("sqlite");
    archive.close();
  });
});

describe("AppDatabase SessionArchive", () => {
  function openDatabase(dir: string): AppDatabase {
    const database = AppDatabase.open(dir);
    expect(database).not.toBeNull();
    if (!database) throw new Error("node:sqlite unavailable in test runtime");
    return database;
  }

  it("stores summaries, paged transcripts and compact changes in SQLite", () => {
    const dir = tmp();
    const database = openDatabase(dir);
    try {
      const archive = new SessionArchive(dir, database);
      archive.upsertSummary({
        id: "session-sqlite",
        title: "SQLite session",
        cwd: "D:/project",
        updatedAt: 200,
        status: "running",
        pinned: true,
      });
      const items: ChatItem[] = Array.from({ length: 90 }, (_, index) => ({
        kind: "text",
        id: `message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        text: `message ${index}`,
        streaming: true,
      }));
      archive.saveItems("session-sqlite", items);
      archive.saveItems("session-sqlite", [
        ...items,
        {
          kind: "text",
          id: "message-90",
          role: "assistant",
          text: "appended",
        },
      ]);
      const changes: FileChange[] = [
        {
          path: "src/app.ts",
          status: "M",
          hunks: "+sqlite",
          updatedAt: 300,
          events: [
            { id: "event-1", tool: "Edit", at: 300, hunk: "+sqlite" },
          ],
        },
      ];
      archive.saveChanges("session-sqlite", changes);

      const restarted = new SessionArchive(dir, database);
      expect(restarted.loadIndex()[0]).toMatchObject({
        id: "session-sqlite",
        status: "idle",
        pinned: true,
      });
      const tail = restarted.loadItemsPage("session-sqlite", { limit: 3 });
      expect(tail.total).toBe(91);
      expect(tail.items.map((entry) => entry.id)).toEqual([
        "message-88",
        "message-89",
        "message-90",
      ]);
      expect(tail.items[0]).toMatchObject({ streaming: false });
      expect(
        restarted.loadItemsPage("session-sqlite", {
          beforeId: "message-88",
          limit: 2,
        }).items.map((entry) => entry.id),
      ).toEqual(["message-86", "message-87"]);
      expect(restarted.loadChanges("session-sqlite")).toEqual(changes);

      expect(
        fs.existsSync(
          path.join(dir, "sessions", "session-sqlite.transcript"),
        ),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it("imports legacy Session JSON/chunks without deleting the source", () => {
    const dir = tmp();
    const legacy = new SessionArchive(dir);
    legacy.upsertSummary({
      id: "legacy-session",
      title: "legacy",
      cwd: "D:/legacy",
      updatedAt: 100,
      status: "idle",
    });
    legacy.saveItems("legacy-session", [
      { kind: "text", id: "old-1", role: "user", text: "from json" },
      { kind: "text", id: "old-2", role: "assistant", text: "kept" },
    ]);
    legacy.saveChanges("legacy-session", [
      {
        path: "legacy.ts",
        status: "A",
        hunks: "+legacy",
        updatedAt: 101,
        events: [],
      },
    ]);

    const database = openDatabase(dir);
    try {
      const migrated = new SessionArchive(dir, database);
      expect(migrated.loadIndex().map((summary) => summary.id)).toContain(
        "legacy-session",
      );
      expect(migrated.loadItems("legacy-session").map((entry) => entry.id)).toEqual([
        "old-1",
        "old-2",
      ]);
      expect(migrated.loadChanges("legacy-session")[0]?.path).toBe("legacy.ts");
      expect(
        fs.existsSync(
          path.join(
            dir,
            "sessions",
            "legacy-session.transcript",
            "manifest.json",
          ),
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

});

describe("AppDatabase transcript search", () => {
  function openDatabase(dir: string): AppDatabase {
    const database = AppDatabase.open(dir);
    expect(database).not.toBeNull();
    if (!database) throw new Error("node:sqlite unavailable in test runtime");
    return database;
  }

  function seedSession(
    archive: SessionArchive,
    id: string,
    title: string,
    cwd: string,
    updatedAt: number,
    texts: string[],
  ): void {
    archive.upsertSummary({ id, title, cwd, updatedAt, status: "idle" });
    archive.saveItems(
      id,
      texts.map(
        (text, index): ChatItem => ({
          kind: "text",
          id: `${id}-item-${index}`,
          role: "user",
          text,
        }),
      ),
    );
  }

  it("matches transcript content and joins title/cwd from the archive", () => {
    const dir = tmp();
    const database = openDatabase(dir);
    try {
      const archive = new SessionArchive(dir, database);
      seedSession(archive, "session-alpha", "Alpha work", "D:/alpha", 100, [
        "the quick brown fox jumps over the lazy dog",
      ]);
      seedSession(archive, "session-beta", "Beta notes", "D:/beta", 200, [
        "nothing relevant in this transcript",
      ]);

      const hits = database.searchTranscripts("BROWN FOX");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        sessionId: "session-alpha",
        title: "Alpha work",
        cwd: "D:/alpha",
        updatedAt: 100,
      });
      expect(hits[0]?.snippet).toContain("brown fox");
    } finally {
      database.close();
    }
  });

  it("escapes LIKE wildcards so \"100%\" does not match \"1000\"", () => {
    const dir = tmp();
    const database = openDatabase(dir);
    try {
      const archive = new SessionArchive(dir, database);
      seedSession(archive, "session-pct", "Percent", "D:/pct", 100, [
        "progress reached 100% today",
      ]);
      seedSession(archive, "session-num", "Numbers", "D:/num", 200, [
        "processed 1000 rows",
      ]);

      const hits = database.searchTranscripts("100%");
      expect(hits.map((hit) => hit.sessionId)).toEqual(["session-pct"]);
    } finally {
      database.close();
    }
  });

  it("stops at the limit and orders hits by updated_at desc", () => {
    const dir = tmp();
    const database = openDatabase(dir);
    try {
      const archive = new SessionArchive(dir, database);
      seedSession(archive, "session-old", "Old", "D:/old", 100, ["keyword one"]);
      seedSession(archive, "session-mid", "Mid", "D:/mid", 200, ["keyword two"]);
      seedSession(archive, "session-new", "New", "D:/new", 300, [
        "keyword three",
      ]);

      const hits = database.searchTranscripts("keyword", 2);
      expect(hits.map((hit) => hit.sessionId)).toEqual([
        "session-new",
        "session-mid",
      ]);
    } finally {
      database.close();
    }
  });

  it("returns [] for a blank query", () => {
    const dir = tmp();
    const database = openDatabase(dir);
    try {
      const archive = new SessionArchive(dir, database);
      seedSession(archive, "session-alpha", "Alpha", "D:/alpha", 100, [
        "some text",
      ]);
      expect(database.searchTranscripts("   ")).toEqual([]);
    } finally {
      database.close();
    }
  });
});
