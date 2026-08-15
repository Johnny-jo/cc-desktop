import vm from "node:vm";

export const MOD_JSON_MAX_BYTES = 64 * 1024;
export const MOD_JSON_MAX_DEPTH = 8;

export type ModIntent = { seatId: string; name: string; payload: unknown };
export type ModSeat = {
  id: string;
  kind: "human" | "agent";
  name: string;
  occupantUserId: string | null;
  takenOverBy: string | null;
  sessionId: string | null;
};

export type ModActor = { userId: string; seatId: string };

export type ReduceCtxIn = {
  now: number;
  seats: ModSeat[];
  actor: ModActor;
};

export type GameApi = {
  initialState: () => unknown;
  reduce: (state: unknown, intent: ModIntent, ctx: GameReduceCtx) => unknown;
  getPublicView: (state: unknown) => unknown;
  getSeatView: (state: unknown, seatId: string) => unknown;
  getAgentView: (state: unknown, seatId: string) => unknown;
  getActions: (state: unknown, seatId: string) => unknown;
  getPrompt: (state: unknown, seatId: string) => string;
  shouldPromptAgent: (state: unknown, seatId: string) => boolean;
};

export type GameReduceCtx = {
  rng: () => number;
  now: number;
  seats: readonly ModSeat[];
  actor: ModActor;
};

export type PersistLogEntry = ModIntent & {
  now: number;
  seats: ModSeat[];
  actor: ModActor;
};

export type AgentTurn = {
  should: boolean;
  view: unknown;
  prompt: string;
  actions: unknown;
};

const REQUIRED_METHODS = [
  "initialState",
  "reduce",
  "getPublicView",
  "getSeatView",
  "getActions",
  "getPrompt",
] as const;

const FORBIDDEN: { re: RegExp; message: string }[] = [
  { re: /Math\.random\b/, message: "Math.random is forbidden" },
  { re: /Date\.now\b/, message: "Date.now is forbidden" },
  { re: /\bnew\s+Date\b/, message: "Date is forbidden" },
  { re: /\bfetch\s*\(/, message: "fetch is forbidden" },
  { re: /\bWebSocket\b/, message: "WebSocket is forbidden" },
  { re: /\brequire\s*\(/, message: "require is forbidden" },
  {
    re: /\b(?:import\s*(?:[\s\S]*?\sfrom\s*)?|from\s+|import\s*\(\s*)['"](?:node:|fs|net|http|child_process|electron)(?:['"/])/,
    message: "forbidden module import",
  },
];

export function jsonDepth(value: unknown, seen?: Set<object>): number {
  if (value === null || typeof value !== "object") return 0;
  const trail = seen ?? new Set<object>();
  if (trail.has(value)) {
    throw new Error("value is not JSON-serializable");
  }
  trail.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) {
    trail.delete(value);
    return 1;
  }
  let max = 0;
  for (const child of children) {
    const d = jsonDepth(child, trail);
    if (d > max) max = d;
  }
  trail.delete(value);
  return 1 + max;
}

export function assertJsonLimit(value: unknown, label: string): void {
  try {
    if (jsonDepth(value) > MOD_JSON_MAX_DEPTH) {
      throw new Error(`${label} exceeds depth ${MOD_JSON_MAX_DEPTH}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("exceeds depth")) throw err;
    throw new Error(`${label} is not JSON-serializable`);
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new Error(`${label} is not JSON-serializable`);
  }
  if (bytes > MOD_JSON_MAX_BYTES) {
    throw new Error(`${label} exceeds ${MOD_JSON_MAX_BYTES} bytes`);
  }
}

export function cloneJson<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw new Error(`${label} is not JSON-serializable`);
  }
}

export function scanForbiddenApis(source: string): void {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(source)) {
      throw new Error(rule.message);
    }
  }
}

function transformHostJs(source: string): string {
  let code = source;
  code = code.replace(
    /export\s+default\s+function\s+createGame\b/g,
    "function createGame",
  );
  code = code.replace(/export\s+function\s+createGame\b/g, "function createGame");
  code = code.replace(/export\s+const\s+createGame\s*=/g, "const createGame =");
  code = code.replace(/export\s+default\s+createGame\b/g, "");
  code = code.replace(/export\s*\{\s*createGame\s*(?:as\s+default\s*)?\}/g, "");
  return code;
}

function isolatedMath(): Record<string, unknown> {
  const math = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(Math)) {
    if (key === "random") continue;
    const desc = Object.getOwnPropertyDescriptor(Math, key);
    if (!desc) continue;
    if (typeof desc.value === "function") {
      math[key] = (desc.value as (...args: unknown[]) => unknown).bind(Math);
    } else {
      Object.defineProperty(math, key, {
        enumerable: Boolean(desc.enumerable),
        configurable: false,
        writable: false,
        value: desc.value,
      });
    }
  }
  math.random = () => {
    throw new Error("Math.random is forbidden");
  };
  return Object.freeze(math);
}

function isolatedDate(): DateConstructor {
  function ForbiddenDate(): never {
    throw new Error("Date is forbidden");
  }
  ForbiddenDate.now = (): never => {
    throw new Error("Date.now is forbidden");
  };
  ForbiddenDate.parse = (): never => {
    throw new Error("Date.parse is forbidden");
  };
  ForbiddenDate.UTC = (): never => {
    throw new Error("Date.UTC is forbidden");
  };
  Object.setPrototypeOf(ForbiddenDate, null);
  return ForbiddenDate as unknown as DateConstructor;
}

export function loadGameFromSource(hostJsSource: string): GameApi {
  scanForbiddenApis(hostJsSource);
  const transformed = transformHostJs(hostJsSource);
  const exportsObj: Record<string, unknown> = {};
  const moduleObj = { exports: exportsObj };
  const sandbox: Record<string, unknown> = {
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    RangeError,
    JSON,
    Math: isolatedMath(),
    Date: isolatedDate(),
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Infinity,
    NaN,
    undefined,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    ArrayBuffer,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    RegExp,
    console,
    exports: exportsObj,
    module: moduleObj,
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;

  const wrapped = `(function (exports, module) {
${transformed}
if (typeof createGame === "function") exports.createGame = createGame;
else if (typeof module.exports === "function") exports.createGame = module.exports;
else if (module.exports && typeof module.exports.createGame === "function") {
  exports.createGame = module.exports.createGame;
} else if (module.exports && typeof module.exports.default === "function") {
  exports.createGame = module.exports.default;
}
})(exports, module);`;

  try {
    vm.runInNewContext(wrapped, sandbox, {
      timeout: 1000,
      displayErrors: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`host.js failed to load: ${msg}`);
  }

  const createGame = exportsObj.createGame;
  if (typeof createGame !== "function") {
    throw new Error("createGame is required");
  }
  const raw = (createGame as () => Record<string, unknown>)();
  if (!raw || typeof raw !== "object") {
    throw new Error("createGame() must return an object");
  }
  for (const name of REQUIRED_METHODS) {
    if (typeof raw[name] !== "function") {
      throw new Error(`createGame() missing ${name}`);
    }
  }

  const getSeatView = raw.getSeatView as GameApi["getSeatView"];
  const getAgentView: GameApi["getAgentView"] =
    typeof raw.getAgentView === "function"
      ? (raw.getAgentView as GameApi["getAgentView"])
      : (state, seatId) => ({ narrative: getSeatView(state, seatId) });
  const shouldPromptAgent: GameApi["shouldPromptAgent"] =
    typeof raw.shouldPromptAgent === "function"
      ? (raw.shouldPromptAgent as GameApi["shouldPromptAgent"])
      : () => false;

  return {
    initialState: raw.initialState as GameApi["initialState"],
    reduce: raw.reduce as GameApi["reduce"],
    getPublicView: raw.getPublicView as GameApi["getPublicView"],
    getSeatView,
    getAgentView,
    getActions: raw.getActions as GameApi["getActions"],
    getPrompt: (state, seatId) =>
      String((raw.getPrompt as (s: unknown, id: string) => unknown)(state, seatId)),
    shouldPromptAgent,
  };
}

function seedToUint32(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createMulberry32(seed: string | number): {
  next: () => number;
  getState: () => number;
  setState: (s: number) => void;
} {
  let a = typeof seed === "number" ? seed >>> 0 : seedToUint32(seed);
  return {
    next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    getState() {
      return a >>> 0;
    },
    setState(s: number) {
      a = s | 0;
    },
  };
}

function projectSeats(seats: ModSeat[]): readonly ModSeat[] {
  return Object.freeze(
    seats.map((s) =>
      Object.freeze({
        id: s.id,
        kind: s.kind,
        name: s.name,
        occupantUserId: s.occupantUserId,
        takenOverBy: s.takenOverBy,
        sessionId: s.sessionId,
      }),
    ),
  );
}

export type ModRuntime = {
  readonly seed: string;
  seq: () => number;
  reduce: (intent: ModIntent, ctx: ReduceCtxIn) => { seq: number };
  views: (seats: ModSeat[]) => {
    seq: number;
    publicView: unknown;
    seatViews: Record<string, unknown>;
  };
  actions: (seatId: string) => unknown;
  agentTurn: (seatId: string) => AgentTurn | null;
  persistState: () => {
    snapshot: unknown;
    log: PersistLogEntry[];
    seq: number;
    rngState: number;
  };
  restore: (opts: {
    snapshot?: unknown;
    log?: PersistLogEntry[];
    rngState?: number;
    seq?: number;
  }) => void;
  reset: () => void;
  compact: () => void;
  adopt: (opts: {
    snapshot: unknown;
    seq: number;
    log?: PersistLogEntry[];
    rngState?: number;
  }) => void;
  getSnapshot: () => unknown;
  getRngState: () => number;
};

function normalizeLogEntry(raw: unknown): PersistLogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const intent = (o.intent && typeof o.intent === "object" ? o.intent : o) as Record<
    string,
    unknown
  >;
  if (typeof intent.seatId !== "string" || typeof intent.name !== "string") {
    return null;
  }
  const actorRaw =
    o.actor && typeof o.actor === "object"
      ? (o.actor as Record<string, unknown>)
      : {};
  const seats = Array.isArray(o.seats) ? (o.seats as ModSeat[]) : [];
  return {
    seatId: intent.seatId,
    name: intent.name,
    payload: intent.payload,
    now: typeof o.now === "number" ? o.now : 0,
    seats,
    actor: {
      userId: typeof actorRaw.userId === "string" ? actorRaw.userId : "",
      seatId:
        typeof actorRaw.seatId === "string" ? actorRaw.seatId : intent.seatId,
    },
  };
}

export function createModRuntime(
  hostJsSource: string,
  seed: string,
  init?: {
    snapshot?: unknown;
    log?: unknown[];
    rngState?: number;
    seq?: number;
  },
): ModRuntime {
  const game = loadGameFromSource(hostJsSource);
  const rng = createMulberry32(seed);
  let snapshotRngState = rng.getState();
  let snapshot: unknown = cloneJson(game.initialState(), "initialState");
  assertJsonLimit(snapshot, "initialState");
  let state: unknown = cloneJson(snapshot, "initialState");
  let log: PersistLogEntry[] = [];
  let seq = 0;

  const applyIntent = (intent: ModIntent, ctx: ReduceCtxIn): void => {
    const recorded = cloneJson(intent.payload, "intent payload");
    assertJsonLimit(recorded, "intent payload");
    const forGame = cloneJson(recorded, "intent payload");
    const seats = projectSeats(ctx.seats);
    const next = game.reduce(
      state,
      { seatId: intent.seatId, name: intent.name, payload: forGame },
      {
        rng: () => rng.next(),
        now: ctx.now,
        seats,
        actor: Object.freeze({ ...ctx.actor }),
      },
    );
    assertJsonLimit(next, "reduce result");
    state = next;
    log.push({
      seatId: intent.seatId,
      name: intent.name,
      payload: recorded,
      now: ctx.now,
      seats: ctx.seats.map((s) => ({ ...s })),
      actor: { ...ctx.actor },
    });
    seq += 1;
  };

  const replay = (entries: unknown[]): void => {
    for (const raw of entries) {
      const entry = normalizeLogEntry(raw);
      if (!entry) throw new Error("invalid persist log entry");
      applyIntent(
        { seatId: entry.seatId, name: entry.name, payload: entry.payload },
        { now: entry.now, seats: entry.seats, actor: entry.actor },
      );
    }
  };

  if (init?.rngState !== undefined) rng.setState(init.rngState);
  snapshotRngState = rng.getState();
  if (init?.snapshot !== undefined) {
    snapshot = cloneJson(init.snapshot, "snapshot");
    assertJsonLimit(snapshot, "snapshot");
    state = cloneJson(snapshot, "snapshot");
  }
  if (init?.log?.length) replay(init.log);
  if (typeof init?.seq === "number") seq = init.seq;

  return {
    seed,
    seq: () => seq,
    reduce(intent, ctx) {
      applyIntent(intent, ctx);
      return { seq };
    },
    views(seats) {
      const publicView = game.getPublicView(state);
      assertJsonLimit(publicView, "publicView");
      const seatViews: Record<string, unknown> = {};
      for (const seat of seats) {
        const view = game.getSeatView(state, seat.id);
        assertJsonLimit(view, "seatView");
        seatViews[seat.id] = view;
      }
      return { seq, publicView, seatViews };
    },
    actions(seatId) {
      const result = game.getActions(state, seatId);
      assertJsonLimit(result, "actions");
      return result;
    },
    agentTurn(seatId) {
      if (!game.shouldPromptAgent(state, seatId)) return null;
      const view = game.getAgentView(state, seatId);
      assertJsonLimit(view, "agentView");
      const actions = game.getActions(state, seatId);
      assertJsonLimit(actions, "actions");
      return {
        should: true,
        view,
        prompt: game.getPrompt(state, seatId),
        actions,
      };
    },
    persistState() {
      const out = {
        snapshot: cloneJson(snapshot, "snapshot"),
        log: cloneJson(log, "log"),
        seq,
        rngState: snapshotRngState,
      };
      assertJsonLimit(out.snapshot, "snapshot");
      try {
        JSON.stringify(out.log);
      } catch {
        throw new Error("persist log is not JSON-serializable");
      }
      return out;
    },
    restore(opts) {
      rng.setState(
        opts.rngState !== undefined ? opts.rngState : seedToUint32(seed),
      );
      snapshotRngState = rng.getState();
      snapshot =
        opts.snapshot !== undefined
          ? cloneJson(opts.snapshot, "snapshot")
          : cloneJson(game.initialState(), "initialState");
      assertJsonLimit(snapshot, "snapshot");
      state = cloneJson(snapshot, "snapshot");
      log = [];
      seq = 0;
      if (opts.log?.length) replay(opts.log);
      if (typeof opts.seq === "number") seq = opts.seq;
    },
    reset() {
      rng.setState(seedToUint32(seed));
      snapshotRngState = rng.getState();
      snapshot = cloneJson(game.initialState(), "initialState");
      assertJsonLimit(snapshot, "initialState");
      state = cloneJson(snapshot, "initialState");
      log = [];
      seq = 0;
    },
    compact() {
      snapshot = cloneJson(state, "snapshot");
      snapshotRngState = rng.getState();
      log = [];
    },
    adopt(opts) {
      state = cloneJson(opts.snapshot, "snapshot");
      seq = opts.seq;
      if (opts.log) log = cloneJson(opts.log, "log");
      if (opts.rngState !== undefined) rng.setState(opts.rngState);
    },
    getSnapshot() {
      return state;
    },
    getRngState() {
      return rng.getState();
    },
  };
}
