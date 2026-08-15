import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashModFiles } from "@claude-desktop/shared/mod-hash";
import { createModRuntime, loadGameFromSource, scanForbiddenApis } from "./mod-game";
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

const WEREWOLF_AGENTS = makeSeats([
  { id: "s1", name: "Alice", kind: "agent" },
  { id: "s2", name: "Bob", kind: "agent" },
  { id: "s3", name: "Carol", kind: "agent" },
  { id: "s4", name: "Dave", kind: "agent" },
]);

const VOTE_SEATS = makeSeats([
  { id: "s1", name: "Alice" },
  { id: "s2", name: "Bot", kind: "agent" },
]);

const VOTE_AGENTS = makeSeats([
  { id: "s1", name: "Alice", kind: "agent" },
  { id: "s2", name: "Bot", kind: "agent" },
]);

type WerewolfSnap = {
  phase?: string;
  living?: string[];
  dead?: string[];
  roles?: Record<string, string>;
  votes?: Record<string, string>;
  seerInspect?: { targetSeatId: string; role: string } | null;
  winner?: string | null;
};

function startWerewolfRuntime(seats: ModSeat[], seed: string) {
  const loaded = loadModDir(WEREWOLF_DIR);
  const runtime = createModRuntime(loaded.hostJsSource, seed);
  runtime.reduce(
    { seatId: seats[0]!.id, name: "mod.start", payload: {} },
    ctxFor(seats, seats[0]!.id),
  );
  return runtime;
}

function snapOf(runtime: ReturnType<typeof createModRuntime>): WerewolfSnap {
  return runtime.getSnapshot() as WerewolfSnap;
}

function roleMap(runtime: ReturnType<typeof createModRuntime>) {
  return snapOf(runtime).roles ?? {};
}

function publicText(view: unknown): string {
  return ((asView(view).lines as string[]) ?? []).join("\n");
}

function expectNoHiddenRolesInPublic(view: unknown) {
  const pub = asView(view);
  const text = publicText(pub);
  expect(text).not.toContain("You are the ");
  expect(text).not.toMatch(/Fellow wolves/);
  expect(text).not.toMatch(/Last inspect/);
  expect(text).not.toMatch(/seer may inspect/i);
  expect(text).not.toMatch(/is the (seer|wolf|villager|judge)/i);
  expect(JSON.stringify(pub)).not.toMatch(/"roles"\s*:/);
}

function playToAfterWolfNight(
  seats: ModSeat[],
  seed: string,
  exileId: string,
) {
  const runtime = startWerewolfRuntime(seats, seed);
  runtime.reduce(
    { seatId: seats[0]!.id, name: "next", payload: {} },
    ctxFor(seats, seats[0]!.id, 2),
  );
  let now = 3;
  for (const seat of seats) {
    runtime.reduce(
      {
        seatId: seat.id,
        name: "day_vote",
        payload: { targetSeatId: exileId },
      },
      ctxFor(seats, seat.id, now++),
    );
  }
  const afterVote = snapOf(runtime);
  if (afterVote.phase === "ended") return { runtime, reachedNight: false };
  const roles = afterVote.roles ?? {};
  const living = afterVote.living ?? [];
  const wolves = living.filter((id) => roles[id] === "wolf");
  const victim =
    living.find((id) => roles[id] !== "wolf") ?? living[0] ?? exileId;
  for (const wolf of wolves) {
    runtime.reduce(
      {
        seatId: wolf,
        name: "night_wolf",
        payload: { targetSeatId: victim },
      },
      ctxFor(seats, wolf, now++),
    );
  }
  return { runtime, reachedNight: snapOf(runtime).phase === "night_seer" };
}

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
    expect((pub.lines as string[]).join("\n")).toMatch(/Alice \(s1\)/);
    expect((pub.lines as string[]).join("\n")).toMatch(/Bob \(s2\)/);
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

  it("public night path does not leak seer liveness", () => {
    const seed = "night-hide-seer";
    const seats = WEREWOLF_SEATS;
    const peek = startWerewolfRuntime(seats, seed);
    const roles = roleMap(peek);
    const seerId = Object.keys(roles).find((id) => roles[id] === "seer");
    const villagerId = Object.keys(roles).find((id) => roles[id] === "villager");
    expect(seerId).toBeTruthy();
    expect(villagerId).toBeTruthy();

    const deadSeer = playToAfterWolfNight(seats, seed, seerId!);
    const liveSeer = playToAfterWolfNight(seats, seed, villagerId!);
    expect(deadSeer.reachedNight).toBe(true);
    expect(liveSeer.reachedNight).toBe(true);

    const deadPub = deadSeer.runtime.views(seats).publicView;
    const livePub = liveSeer.runtime.views(seats).publicView;
    expect(asView(deadPub).phase).toBe("night_seer");
    expect(asView(livePub).phase).toBe("night_seer");
    expectNoHiddenRolesInPublic(deadPub);
    expectNoHiddenRolesInPublic(livePub);
    expect(publicText(deadPub)).toContain("Night falls");
    expect(publicText(livePub)).toContain("Night falls");

    const seerSeat = asView(liveSeer.runtime.views(seats).seatViews[seerId!]);
    expect((seerSeat.lines as string[]).join("\n")).toMatch(
      /You may inspect someone/,
    );
    const villagerSeat = asView(
      deadSeer.runtime.views(seats).seatViews[villagerId!],
    );
    expect((villagerSeat.lines as string[]).join("\n")).not.toMatch(
      /You may inspect someone/,
    );
  });

  it("night_seer rejects a dead target", () => {
    const seed = "no-corpse-inspect";
    const seats = WEREWOLF_SEATS;
    const peek = startWerewolfRuntime(seats, seed);
    const roles = roleMap(peek);
    const seerId = Object.keys(roles).find((id) => roles[id] === "seer")!;
    const otherId = Object.keys(roles).find(
      (id) => id !== seerId && roles[id] !== "wolf",
    )!;
    const { runtime, reachedNight } = playToAfterWolfNight(
      seats,
      seed,
      otherId,
    );
    expect(reachedNight).toBe(true);
    expect(snapOf(runtime).dead).toContain(otherId);
    runtime.reduce(
      {
        seatId: seerId,
        name: "night_seer",
        payload: { targetSeatId: otherId },
      },
      ctxFor(seats, seerId, 50),
    );
    expect(snapOf(runtime).phase).toBe("night_seer");
    expect(snapOf(runtime).seerInspect).toBeNull();
  });

  it("latches communal next on one agent; personal actions only for the actor", async () => {
    const { host } = await startPack(WEREWOLF_DIR, "latch-seq");
    const seats = WEREWOLF_AGENTS;
    await host.dispatch(
      { seatId: "s1", name: "mod.start", payload: {} },
      ctxFor(seats, "s1"),
    );
    expect(await host.agentTurn("s1")).toMatchObject({ should: true });
    expect(await host.agentTurn("s2")).toBeNull();
    expect(await host.agentTurn("s3")).toBeNull();
    expect(await host.agentTurn("s4")).toBeNull();

    await host.dispatch(
      { seatId: "s1", name: "next", payload: {} },
      ctxFor(seats, "s1", 2),
    );
    expect(asView((await host.views(seats)).publicView).phase).toBe("day_vote");
    const voteActions = (await host.actions("s2")) as {
      day_vote?: { hint?: string; params?: { properties?: { targetSeatId?: { enum?: string[] } } } };
    };
    expect(voteActions.day_vote?.params?.properties?.targetSeatId?.enum).toEqual(
      ["s1", "s2", "s3", "s4"],
    );
    expect(voteActions.day_vote?.hint).toMatch(/Alice \(s1\)/);
    for (const id of ["s1", "s2", "s3", "s4"]) {
      expect(await host.agentTurn(id)).toMatchObject({ should: true });
    }
    await host.dispatch(
      { seatId: "s1", name: "day_vote", payload: { targetSeatId: "s2" } },
      ctxFor(seats, "s1", 3),
    );
    expect(await host.agentTurn("s1")).toBeNull();
    expect(await host.agentTurn("s2")).toMatchObject({ should: true });

    const loaded = loadModDir(WEREWOLF_DIR);
    const runtime = createModRuntime(loaded.hostJsSource, "latch-seq");
    runtime.reduce(
      { seatId: "s1", name: "mod.start", payload: {} },
      ctxFor(seats, "s1"),
    );
    const roles = roleMap(runtime);
    const wolfId = Object.keys(roles).find((id) => roles[id] === "wolf")!;
    const seerId = Object.keys(roles).find((id) => roles[id] === "seer")!;
    const exileId = Object.keys(roles).find(
      (id) => roles[id] === "villager",
    )!;
    runtime.reduce(
      { seatId: "s1", name: "next", payload: {} },
      ctxFor(seats, "s1", 2),
    );
    let now = 3;
    for (const seat of seats) {
      runtime.reduce(
        {
          seatId: seat.id,
          name: "day_vote",
          payload: { targetSeatId: exileId },
        },
        ctxFor(seats, seat.id, now++),
      );
    }
    expect(snapOf(runtime).phase).toBe("night_wolf");
    expect(runtime.agentTurn(wolfId)?.should).toBe(true);
    for (const seat of seats) {
      if (seat.id !== wolfId) expect(runtime.agentTurn(seat.id)).toBeNull();
    }
    const living = snapOf(runtime).living ?? [];
    const victim = living.find((id) => id !== wolfId) ?? living[0]!;
    runtime.reduce(
      {
        seatId: wolfId,
        name: "night_wolf",
        payload: { targetSeatId: victim },
      },
      ctxFor(seats, wolfId, now++),
    );
    expect(snapOf(runtime).phase).toBe("night_seer");
    expect(runtime.agentTurn(seerId)?.should).toBe(true);
    const speaker = firstLivingAgentFrom(snapOf(runtime), seats);
    for (const seat of seats) {
      if (seat.id === seerId) continue;
      if (seat.id === speaker) {
        expect(runtime.agentTurn(seat.id)?.should).toBe(true);
      } else {
        expect(runtime.agentTurn(seat.id)).toBeNull();
      }
    }
    host.dispose();
  });

  it("exiling the last wolf ends the game without publishing roles", () => {
    const seed = "village-win";
    const seats = WEREWOLF_SEATS;
    const runtime = startWerewolfRuntime(seats, seed);
    const wolfId = Object.keys(roleMap(runtime)).find(
      (id) => roleMap(runtime)[id] === "wolf",
    )!;
    runtime.reduce(
      { seatId: "s1", name: "next", payload: {} },
      ctxFor(seats, "s1", 2),
    );
    for (const seat of seats) {
      runtime.reduce(
        {
          seatId: seat.id,
          name: "day_vote",
          payload: { targetSeatId: wolfId },
        },
        ctxFor(seats, seat.id, 3),
      );
    }
    const snap = snapOf(runtime);
    expect(snap.phase).toBe("ended");
    expect(snap.winner).toBe("village");
    expectNoHiddenRolesInPublic(runtime.views(seats).publicView);
  });

  it("assigns judge only on a whole-token name/id hint", () => {
    const seats = makeSeats([
      { id: "s1", name: "judgemental" },
      { id: "s2", name: "not-a-judge" },
      { id: "s3", name: "Judge" },
      { id: "s4", name: "Dave", kind: "agent" },
    ]);
    const runtime = startWerewolfRuntime(seats, "judge-token");
    const roles = roleMap(runtime);
    expect(roles.s3).toBe("judge");
    expect(roles.s1).not.toBe("judge");
    expect(roles.s2).not.toBe("judge");
  });
});

function firstLivingAgentFrom(snap: WerewolfSnap, seats: ModSeat[]): string | null {
  const kind = Object.fromEntries(seats.map((s) => [s.id, s.kind]));
  return (snap.living ?? []).find((id) => kind[id] === "agent") ?? null;
}

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
    const doneText = (donePub.lines as string[]).join("\n");
    expect(doneText).toMatch(/Yes 1/);
    expect(doneText).toMatch(/No 1/);
    expect(doneText.match(/Ship it\?/g)?.length).toBe(1);
    expect(doneText).not.toMatch(/^Yes:/m);
    expect(doneText).not.toMatch(/^No:/m);
    host.dispose();
  });

  it("shouldPromptAgent is true in vote for an agent that has not voted", async () => {
    const { host } = await startPack(VOTE_DIR, "latch-seed");
    const seats = VOTE_SEATS;
    await host.dispatch(
      { seatId: "s1", name: "mod.start", payload: {} },
      ctxFor(seats, "s1"),
    );
    expect(await host.agentTurn("s2")).toMatchObject({ should: true });
    expect(await host.agentTurn("s1")).toBeNull();
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

  it("latches propose/next onto one living agent", async () => {
    const { host } = await startPack(VOTE_DIR, "vote-communal");
    const seats = VOTE_AGENTS;
    await host.dispatch(
      { seatId: "s1", name: "mod.start", payload: {} },
      ctxFor(seats, "s1"),
    );
    expect(await host.agentTurn("s1")).toMatchObject({ should: true });
    expect(await host.agentTurn("s2")).toBeNull();
    await host.dispatch(
      { seatId: "s1", name: "propose", payload: { text: "Go?" } },
      ctxFor(seats, "s1", 2),
    );
    expect(await host.agentTurn("s1")).toMatchObject({ should: true });
    expect(await host.agentTurn("s2")).toMatchObject({ should: true });
    await host.dispatch(
      { seatId: "s1", name: "vote", payload: { choice: "yes" } },
      ctxFor(seats, "s1", 3),
    );
    await host.dispatch(
      { seatId: "s2", name: "vote", payload: { choice: "yes" } },
      ctxFor(seats, "s2", 4),
    );
    expect(asView((await host.views(seats)).publicView).phase).toBe("result");
    expect(await host.agentTurn("s1")).toMatchObject({ should: true });
    expect(await host.agentTurn("s2")).toBeNull();
    host.dispose();
  });
});

describe("official packs forbid sandbox APIs", () => {
  const snippets: { code: string; message: RegExp }[] = [
    { code: "const x = Math.random();", message: /Math\.random/ },
    { code: "const t = Date.now();", message: /Date\.now/ },
    { code: "const d = new Date();", message: /Date/ },
    { code: "fetch('https://example.test');", message: /fetch/ },
    { code: "const w = WebSocket;", message: /WebSocket/ },
    { code: "require('fs');", message: /require/ },
    { code: "from 'fs'", message: /forbidden module import/ },
  ];

  it("official host.js passes the same FORBIDDEN scan as mod-game", () => {
    const werewolf = loadModDir(WEREWOLF_DIR);
    const vote = loadModDir(VOTE_DIR);
    expect(() => scanForbiddenApis(werewolf.hostJsSource)).not.toThrow();
    expect(() => scanForbiddenApis(vote.hostJsSource)).not.toThrow();
  });

  it("static scan and loader reject each forbidden API if added", () => {
    const werewolf = loadModDir(WEREWOLF_DIR);
    const vote = loadModDir(VOTE_DIR);
    for (const pack of [werewolf, vote]) {
      expect(pack.hostJsSource).not.toMatch(/Math\.random/);
      expect(pack.hostJsSource).not.toMatch(/Date\.now/);
      expect(pack.hostJsSource).not.toMatch(/\brequire\s*\(/);
      for (const snippet of snippets) {
        expect(() => scanForbiddenApis(`${pack.hostJsSource}\n${snippet.code}\n`)).toThrow(
          snippet.message,
        );
      }
    }
    expect(() =>
      loadGameFromSource(`${werewolf.hostJsSource}\nconst x = Math.random();\n`),
    ).toThrow(/Math\.random/);
  });
});
