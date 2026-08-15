import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashModFiles } from "@claude-desktop/shared/mod-hash";
import { createModRuntime, loadGameFromSource } from "./mod-game";
import { ModHost, type ModSeat } from "./mod-host";
import { loadModDir } from "./mod-package";

const WEREWOLF_DIR = path.resolve(__dirname, "../../resources/mods/werewolf");
const VOTE_DIR = path.resolve(__dirname, "../../resources/mods/vote");

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

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mod-ex-"));
  dirs.push(d);
  return d;
}

function makeSeats(
  specs: { id: string; kind?: "human" | "agent"; name?: string }[],
): ModSeat[] {
  return specs.map((s, i) => ({
    id: s.id,
    kind: s.kind ?? "human",
    name: s.name ?? s.id,
    occupantUserId: s.kind === "agent" ? null : `u${i + 1}`,
    takenOverBy: null,
    sessionId: s.kind === "agent" ? `sess-${s.id}` : null,
  }));
}

function ctxFor(seats: ModSeat[], seatId: string, now = 1000) {
  const seat = seats.find((s) => s.id === seatId) ?? seats[0]!;
  return {
    now,
    seats,
    actor: { userId: seat.occupantUserId ?? "sys", seatId: seat.id },
  };
}

type View = {
  title?: unknown;
  phase?: unknown;
  lines?: unknown;
  badges?: unknown;
};

function asView(value: unknown): View {
  return (value && typeof value === "object" ? value : {}) as View;
}

function expectModView(value: unknown) {
  const view = asView(value);
  expect(typeof view.title).toBe("string");
  expect(typeof view.phase).toBe("string");
  expect(Array.isArray(view.lines)).toBe(true);
  expect((view.lines as unknown[]).every((l) => typeof l === "string")).toBe(
    true,
  );
}

function selfRole(value: unknown): string | null {
  const view = asView(value);
  const line = (view.lines as string[] | undefined)?.find((l) =>
    l.startsWith("You are the "),
  );
  if (!line) return null;
  return line.slice("You are the ".length).replace(/\.$/, "");
}

const WEREWOLF_SEATS = makeSeats([
  { id: "s1", name: "Alice" },
  { id: "s2", name: "Bob" },
  { id: "s3", name: "Carol" },
  { id: "s4", name: "Dave", kind: "agent" },
]);

const VOTE_SEATS = makeSeats([
  { id: "s1", name: "Alice" },
  { id: "s2", name: "Bot", kind: "agent" },
]);

async function startPack(dir: string, seed = "example-seed") {
  const loaded = loadModDir(dir);
  const persistPath = path.join(tmp(), "room.mod.json");
  const host = await ModHost.start({
    roomId: "r-ex",
    loaded,
    persistPath,
    seed,
    inProcess: true,
  });
  return { loaded, host, persistPath };
}

describe("official werewolf pack", () => {
  it("loadModDir accepts the pack (checksum, no ui.js)", () => {
    const loaded = loadModDir(WEREWOLF_DIR);
    expect(loaded.manifest.id).toBe("werewolf");
    expect(loaded.manifest.hostApi).toBe(1);
    expect(loaded.manifest.permissions).toEqual([]);
    expect(loaded.manifest.seats).toEqual({
      min: 4,
      max: 12,
      roles: ["seer", "wolf", "villager", "judge"],
    });
    expect(loaded.manifest.agent).toBe(true);
    expect(loaded.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.checksum).toBe(
      hashModFiles(loaded.manifestSource, loaded.hostJsSource),
    );
    expect(fs.existsSync(path.join(WEREWOLF_DIR, "ui.js"))).toBe(false);
  });

  it("start + intents produce ModView public/seat views", async () => {
    const { host } = await startPack(WEREWOLF_DIR);
    const seats = WEREWOLF_SEATS;
    const started = await host.dispatch(
      { seatId: "s1", name: "mod.start", payload: {} },
      ctxFor(seats, "s1"),
    );
    expect(started).toEqual({ ok: true, seq: 1 });
    await host.dispatch(
      { seatId: "s1", name: "day_talk", payload: { say: "hello village" } },
      ctxFor(seats, "s1", 1001),
    );
    const views = await host.views(seats);
    expectModView(views.publicView);
    expectModView(views.seatViews.s1);
    expectModView(views.seatViews.s2);
    const pub = asView(views.publicView);
    expect(pub.phase).toBe("day_talk");
    expect((pub.lines as string[]).some((l) => l.includes("hello village"))).toBe(
      true,
    );
    expect((pub.lines as string[]).join("\n")).toMatch(/Alice|Bob|Carol|Dave/);
    host.dispose();
  });

  it("two seats cannot see each other's hidden role", async () => {
    const loaded = loadModDir(WEREWOLF_DIR);
    const runtime = createModRuntime(loaded.hostJsSource, "hidden-roles");
    const seats = WEREWOLF_SEATS;
    runtime.reduce(
      { seatId: "s1", name: "mod.start", payload: {} },
      ctxFor(seats, "s1"),
    );
    const views = runtime.views(seats);
    const assigned = seats.map((s) => ({
      id: s.id,
      role: selfRole(views.seatViews[s.id]),
      view: asView(views.seatViews[s.id]),
    }));
    expect(
      assigned.every((s) =>
        /^(seer|wolf|villager|judge)$/.test(s.role ?? ""),
      ),
    ).toBe(true);
    const left = assigned.find((s) => s.role === "seer") ?? assigned[0]!;
    const right =
      assigned.find((s) => s.role && s.role !== left.role) ?? assigned[1]!;
    expect(left.role).toBeTruthy();
    expect(right.role).toBeTruthy();
    expect(left.role).not.toBe(right.role);
    expect(JSON.stringify(views.publicView)).not.toContain("You are the ");
    expect((right.view.lines as string[]).join("\n")).not.toContain(
      `You are the ${left.role}.`,
    );
    expect((left.view.lines as string[]).join("\n")).not.toContain(
      `You are the ${right.role}.`,
    );
    const villager = assigned.find((s) => s.role === "villager");
    if (villager) {
      const text = (villager.view.lines as string[]).join("\n");
      expect(text).not.toMatch(/Fellow wolves/);
      expect(text).not.toMatch(/Last inspect/);
    }
  });

  it("unknown intents keep the previous public view", async () => {
    const { host } = await startPack(WEREWOLF_DIR, "unknown-seed");
    const seats = WEREWOLF_SEATS;
    await host.dispatch(
      { seatId: "s1", name: "mod.start", payload: {} },
      ctxFor(seats, "s1"),
    );
    const before = await host.views(seats);
    const result = await host.dispatch(
      { seatId: "s1", name: "nope", payload: { x: 1 } },
      ctxFor(seats, "s1", 2),
    );
    expect(result.ok).toBe(true);
    const after = await host.views(seats);
    expect(after.publicView).toEqual(before.publicView);
    host.dispose();
  });
});

describe("official vote pack", () => {
  it("loadModDir accepts the pack (checksum, no ui.js)", () => {
    const loaded = loadModDir(VOTE_DIR);
    expect(loaded.manifest.id).toBe("vote");
    expect(loaded.manifest.seats).toEqual({
      min: 2,
      max: 16,
      roles: ["voter"],
    });
    expect(loaded.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.checksum).toBe(
      hashModFiles(loaded.manifestSource, loaded.hostJsSource),
    );
    expect(fs.existsSync(path.join(VOTE_DIR, "ui.js"))).toBe(false);
  });

  it("start + propose produce ModView and hide tallies until result", async () => {
    const { host } = await startPack(VOTE_DIR, "vote-seed");
    const seats = VOTE_SEATS;
    await host.dispatch(
      { seatId: "s1", name: "mod.start", payload: {} },
      ctxFor(seats, "s1"),
    );
    await host.dispatch(
      { seatId: "s1", name: "propose", payload: { text: "Ship it?" } },
      ctxFor(seats, "s1", 2),
    );
    const mid = await host.views(seats);
    expectModView(mid.publicView);
    expectModView(mid.seatViews.s1);
    const midPub = asView(mid.publicView);
    expect(midPub.phase).toBe("vote");
    expect((midPub.lines as string[]).join("\n")).toContain("Ship it?");
    expect((midPub.lines as string[]).join("\n")).not.toMatch(/^Yes:/m);
    expect((midPub.lines as string[]).join("\n")).not.toMatch(/^No:/m);

    await host.dispatch(
      { seatId: "s1", name: "vote", payload: { choice: "yes" } },
      ctxFor(seats, "s1", 3),
    );
    await host.dispatch(
      { seatId: "s2", name: "vote", payload: { choice: "no" } },
      ctxFor(seats, "s2", 4),
    );
    const done = await host.views(seats);
    const donePub = asView(done.publicView);
    expect(donePub.phase).toBe("result");
    expect((donePub.lines as string[]).join("\n")).toMatch(/Yes: 1/);
    expect((donePub.lines as string[]).join("\n")).toMatch(/No: 1/);
    host.dispose();
  });

  it("shouldPromptAgent is true in vote for an agent that has not voted", async () => {
    const { host } = await startPack(VOTE_DIR, "latch-seed");
    const seats = VOTE_SEATS;
    await host.dispatch(
      { seatId: "s1", name: "mod.start", payload: {} },
      ctxFor(seats, "s1"),
    );
    expect(await host.agentTurn("s2")).toBeNull();
    await host.dispatch(
      { seatId: "s1", name: "propose", payload: { text: "Go?" } },
      ctxFor(seats, "s1", 2),
    );
    const turn = await host.agentTurn("s2");
    expect(turn).toMatchObject({ should: true });
    expect(typeof turn?.prompt).toBe("string");
    expect(turn?.actions).toMatchObject({
      vote: { params: { type: "object" } },
    });
    expect(await host.agentTurn("s1")).toBeNull();

    await host.dispatch(
      { seatId: "s2", name: "vote", payload: { choice: "yes" } },
      ctxFor(seats, "s2", 3),
    );
    expect(await host.agentTurn("s2")).toBeNull();
    host.dispose();
  });
});

describe("official packs forbid Math.random", () => {
  it("static scan rejects a pack that added Math.random", () => {
    const werewolf = loadModDir(WEREWOLF_DIR);
    const vote = loadModDir(VOTE_DIR);
    expect(werewolf.hostJsSource).not.toMatch(/Math\.random/);
    expect(vote.hostJsSource).not.toMatch(/Math\.random/);
    expect(() =>
      loadGameFromSource(`${werewolf.hostJsSource}\nconst x = Math.random();\n`),
    ).toThrow(/Math\.random/);
    expect(() =>
      loadGameFromSource(`${vote.hostJsSource}\nMath.random();\n`),
    ).toThrow(/Math\.random/);
  });
});
