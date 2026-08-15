import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashModFiles } from "@claude-desktop/shared/mod-hash";
import { loadGameFromSource } from "./mod-game";
import { ModHost, type ModSeat } from "./mod-host";
import {
  createWorkerState,
  handleWorkerMessage,
} from "./mod-host-worker";
import type { LoadedMod } from "./mod-package";

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mod-host-"));
  dirs.push(d);
  return d;
}

const COUNTER_HOST = `
export function createGame() {
  return {
    initialState() { return { n: 0, last: 0, secret: "hidden" }; },
    reduce(state, intent, ctx) {
      if (intent.name === "boom") throw new Error("boom");
      return { n: state.n + 1, last: ctx.rng(), secret: state.secret };
    },
    getPublicView(state) { return { n: state.n, last: state.last }; },
    getSeatView(state, seatId) { return { n: state.n, seatId, secret: state.secret }; },
    getActions() { return [{ name: "inc" }]; },
    getPrompt() { return "go"; },
  };
}
`;

const AGENT_HOST = `
export function createGame() {
  return {
    initialState() { return { n: 0 }; },
    reduce(state) { return { n: state.n + 1 }; },
    getPublicView(state) { return { n: state.n }; },
    getSeatView(state, seatId) { return { n: state.n, seatId }; },
    getAgentView(state, seatId) { return { agent: true, seatId, n: state.n }; },
    getActions() { return [{ name: "inc" }]; },
    getPrompt() { return "act"; },
    shouldPromptAgent(_state, seatId) { return seatId === "agent-1"; },
  };
}
`;

const MANIFEST_SRC = JSON.stringify({
  id: "counter",
  name: "Counter",
  version: "1.0.0",
  hostApi: 1,
  permissions: [],
  seats: { min: 1, max: 4, roles: [] },
  agent: true,
});

function loadedFrom(hostJs: string): LoadedMod {
  return {
    dir: "/virtual",
    manifest: {
      id: "counter",
      name: "Counter",
      version: "1.0.0",
      hostApi: 1,
      permissions: [],
      seats: { min: 1, max: 4, roles: [] },
      agent: true,
    },
    manifestSource: MANIFEST_SRC,
    hostJsSource: hostJs,
    checksum: hashModFiles(MANIFEST_SRC, hostJs),
  };
}

const SEATS: ModSeat[] = [
  {
    id: "p1",
    kind: "human",
    name: "P1",
    occupantUserId: "u1",
    takenOverBy: null,
    sessionId: null,
  },
  {
    id: "agent-1",
    kind: "agent",
    name: "Bot",
    occupantUserId: null,
    takenOverBy: null,
    sessionId: "s1",
  },
];

function ctx(now = 1000) {
  return {
    now,
    seats: SEATS,
    actor: { userId: "u1", seatId: "p1" },
  };
}

async function startHost(hostJs = COUNTER_HOST, seed = "seed-1") {
  const persistPath = path.join(tmp(), "rooms", "r1.mod.json");
  const host = await ModHost.start({
    roomId: "r1",
    loaded: loadedFrom(hostJs),
    persistPath,
    seed,
    inProcess: true,
  });
  return { host, persistPath };
}

describe("loadGameFromSource", () => {
  it("rejects Math.random", () => {
    expect(() =>
      loadGameFromSource(`
        export function createGame() {
          return { initialState() { return { n: Math.random() }; } };
        }
      `),
    ).toThrow(/Math\.random/);
  });

  it("accepts export { createGame }", () => {
    const game = loadGameFromSource(`
      function createGame() {
        return {
          initialState() { return { ok: 1 }; },
          reduce(s) { return s; },
          getPublicView(s) { return s; },
          getSeatView(s) { return s; },
          getActions() { return []; },
          getPrompt() { return ""; },
        };
      }
      export { createGame };
    `);
    expect(game.initialState()).toEqual({ ok: 1 });
    expect(game.shouldPromptAgent({}, "x")).toBe(false);
  });
});

describe("ModHost", () => {
  it("reduce is deterministic given the same seed + intents", async () => {
    const a = await startHost(COUNTER_HOST, "same");
    const b = await startHost(COUNTER_HOST, "same");
    const intent = { seatId: "p1", name: "inc", payload: {} };
    expect(await a.host.dispatch(intent, ctx(1))).toEqual({ ok: true, seq: 1 });
    expect(await b.host.dispatch(intent, ctx(1))).toEqual({ ok: true, seq: 1 });
    expect(await a.host.dispatch(intent, ctx(2))).toEqual({ ok: true, seq: 2 });
    expect(await b.host.dispatch(intent, ctx(2))).toEqual({ ok: true, seq: 2 });
    expect(a.host.views(SEATS)).toEqual(b.host.views(SEATS));
    expect((a.host.views(SEATS).publicView as { last: number }).last).toBeGreaterThanOrEqual(0);
    a.host.dispose();
    b.host.dispose();
  });

  it("keeps public vs seat private fields split", async () => {
    const { host } = await startHost();
    await host.dispatch({ seatId: "p1", name: "inc", payload: {} }, ctx());
    const views = host.views(SEATS);
    expect(views.publicView).toMatchObject({ n: 1 });
    expect(views.publicView).not.toHaveProperty("seatId");
    expect(views.publicView).not.toHaveProperty("secret");
    expect(views.seatViews.p1).toMatchObject({ n: 1, seatId: "p1", secret: "hidden" });
    expect(views.seatViews["agent-1"]).toMatchObject({ seatId: "agent-1" });
    host.dispose();
  });

  it("shouldPromptAgent defaults to false; agentTurn returns null vs payload", async () => {
    const def = await startHost();
    expect(def.host.agentTurn("p1")).toBeNull();
    def.host.dispose();

    const { host } = await startHost(AGENT_HOST);
    expect(host.agentTurn("p1")).toBeNull();
    const turn = host.agentTurn("agent-1");
    expect(turn).toMatchObject({
      should: true,
      prompt: "act",
      view: { agent: true, seatId: "agent-1", n: 0 },
    });
    expect(turn?.actions).toEqual([{ name: "inc" }]);
    host.dispose();
  });

  it("rejects host.js that uses Math.random", async () => {
    await expect(
      startHost(`
        export function createGame() {
          Math.random();
          return {
            initialState() { return {}; },
            reduce(s) { return s; },
            getPublicView(s) { return s; },
            getSeatView(s) { return s; },
            getActions() { return []; },
            getPrompt() { return ""; },
          };
        }
      `),
    ).rejects.toThrow(/Math\.random/);
  });

  it("persist + restoreFromDisk replays remaining log", async () => {
    const { host, persistPath } = await startHost(COUNTER_HOST, "restore-seed");
    await host.dispatch({ seatId: "p1", name: "inc", payload: {} }, ctx(10));
    await host.dispatch({ seatId: "p1", name: "inc", payload: {} }, ctx(20));
    host.persist();
    const mid = host.views(SEATS);
    await host.dispatch({ seatId: "p1", name: "inc", payload: {} }, ctx(30));
    host.persist();
    const after = host.views(SEATS);
    expect((after.publicView as { n: number }).n).toBe(3);
    host.dispose();

    const host2 = await ModHost.start({
      roomId: "r1",
      loaded: loadedFrom(COUNTER_HOST),
      persistPath,
      seed: "ignored",
      inProcess: true,
    });
    await host2.restoreFromDisk();
    expect(host2.seed).toBe("restore-seed");
    expect(host2.views(SEATS)).toEqual(after);
    expect(host2.views(SEATS).seq).toBe(3);
    expect((mid.publicView as { n: number }).n).toBe(2);
    host2.dispose();
  });

  it("reduce throw marks failed=true and persist file still readable", async () => {
    const { host, persistPath } = await startHost();
    await host.dispatch({ seatId: "p1", name: "inc", payload: {} }, ctx());
    host.persist();
    const result = await host.dispatch(
      { seatId: "p1", name: "boom", payload: {} },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(host.failed).toBe(true);
    const raw = fs.readFileSync(persistPath, "utf8");
    const parsed = JSON.parse(raw) as { checksum: string; seq: number; log: unknown[] };
    expect(parsed.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.seq).toBe(1);
    expect(host.views(SEATS).publicView).toMatchObject({ n: 1 });
    host.dispose();
  });

  it("rejects over-limit JSON depth and size", async () => {
    const { host } = await startHost();
    let deep: unknown = { v: 1 };
    for (let i = 0; i < 9; i++) deep = { child: deep };
    const deepRes = await host.dispatch(
      { seatId: "p1", name: "inc", payload: deep },
      ctx(),
    );
    expect(deepRes.ok).toBe(false);
    expect(deepRes).toMatchObject({ error: expect.stringMatching(/depth/i) });
    expect(host.failed).toBe(false);

    const bigRes = await host.dispatch(
      { seatId: "p1", name: "inc", payload: { s: "x".repeat(70 * 1024) } },
      ctx(),
    );
    expect(bigRes.ok).toBe(false);
    expect(bigRes).toMatchObject({ error: expect.stringMatching(/bytes|exceeds/i) });
    expect(host.failed).toBe(false);
    expect(host.views(SEATS).seq).toBe(0);
    host.dispose();
  });
});

describe("mod-host-worker handler", () => {
  it("handles init + reduce", () => {
    const state = createWorkerState();
    const init = handleWorkerMessage(state, {
      type: "init",
      hostJsSource: COUNTER_HOST,
      seed: "w1",
    });
    expect(init.ok).toBe(true);
    expect(init.seq).toBe(0);
    const reduced = handleWorkerMessage(state, {
      type: "reduce",
      intent: { seatId: "p1", name: "inc", payload: {} },
      ctx: ctx(5),
    });
    expect(reduced.ok).toBe(true);
    expect(reduced.seq).toBe(1);
    const views = handleWorkerMessage(state, { type: "views", seats: SEATS });
    expect(views.ok).toBe(true);
    expect(views.publicView).toMatchObject({ n: 1 });
  });
});
