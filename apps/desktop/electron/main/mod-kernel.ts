import vm from "node:vm";
import * as acorn from "acorn";
import { MOD_KERNEL_API } from "@claude-desktop/shared";

export { MOD_KERNEL_API };

export const KERNEL_HOOK_CHAT_IN = "room.chat.in" as const;

export function kernelLog(
  event: string,
  extra?: Record<string, unknown>,
): void {
  if (extra) console.info("[mod-kernel]", event, extra);
  else console.info("[mod-kernel]", event);
}

/** Host-side inject stubs. Authors never receive the providing pack's closures. */
export function hostInjectStub(name: string, storage?: RoomKv): unknown {
  if (name === "memory" && storage) {
    const ns = storage.namespace("memory");
    return {
      get: (key: unknown) => ns.get(String(key ?? "")),
      set: (key: unknown, value: unknown) =>
        ns.set(String(key ?? ""), String(value ?? "")),
      list: (prefix?: unknown) =>
        ns.list(prefix == null || prefix === "" ? undefined : String(prefix)),
      search: (query: unknown) => ns.search(String(query ?? "")),
    };
  }
  return { provided: true };
}
export const KERNEL_PERM_STORAGE_ROOM = "storage:room" as const;
export const KERNEL_PERM_SCHEDULE_ROOM = "schedule:room" as const;
export const KERNEL_SCHEDULE_MIN_MS = 1000;
export const KERNEL_SCHEDULE_MAX_JOBS = 4;
export const KERNEL_SCHEDULE_TICK_MS = 200;

export type KernelModState = "pending" | "active" | "failed" | "disposed";

export type KernelBudget = {
  hookPerMin: number;
  schedulePerMin: number;
};

export const KERNEL_BUDGET_DEFAULT: KernelBudget = {
  hookPerMin: 120,
  schedulePerMin: 20,
};

export const KERNEL_ROOM_BUDGET: KernelBudget = {
  hookPerMin: 300,
  schedulePerMin: 40,
};

export const KERNEL_BUDGET_WINDOW_MS = 60_000;

export type KernelManifest = {
  id: string;
  name: string;
  version: string;
  hostApi: typeof MOD_KERNEL_API;
  inject: string[];
  provides: string[];
  permissions: string[];
  hooks: string[];
  budget: KernelBudget;
};

export type KernelInstance = {
  id: string;
  version: string;
  state: KernelModState;
  pendingReason?: string;
  failedReason?: string;
  provides: string[];
  inject: string[];
  hooks: string[];
};

export type KernelGraph = {
  active: KernelInstance[];
  pending: KernelInstance[];
  failed: KernelInstance[];
};

export type KernelRoomView = {
  id: string;
  seats: ReadonlyArray<{ id: string; kind: "human" | "agent"; name: string }>;
};

export type RoomKvSetResult = { ok: true } | { ok: false; error: string };

export type RoomKvNs = {
  get(key: string): string | undefined;
  set(key: string, value: string): RoomKvSetResult;
  list(prefix?: string): string[];
  search(query: string): Array<{ key: string; value: string }>;
};

export type RoomKv = {
  namespace(ns: string): RoomKvNs;
};

export type ChatInEnvelope = {
  roomId: string;
  seatId: string;
  authorUserId: string;
  authorLabel: string;
  text: string;
  at: number;
};

export type WaterfallResult<T> =
  | { action: "continue"; value: T }
  | { action: "replace"; value: T }
  | { action: "drop"; reason?: string };

export type ChatInHandler = (
  env: ChatInEnvelope,
) => WaterfallResult<ChatInEnvelope> | Promise<WaterfallResult<ChatInEnvelope>>;

export const CHAT_IN_HOOK_TIMEOUT_MS = 50;

export type KernelScheduleTick = {
  text?: string;
  toAgent?: boolean;
};

export type KernelScheduleJob = {
  packId?: string;
  budget?: KernelBudget;
  ms: number;
  run: () => KernelScheduleTick | void | Promise<KernelScheduleTick | void>;
};

export class KernelBudgetGate {
  private windowStart: number | null = null;
  private hookByPack = new Map<string, number>();
  private schedByPack = new Map<string, number>();
  private roomHook = 0;
  private roomSched = 0;

  constructor(
    private readonly windowMs = KERNEL_BUDGET_WINDOW_MS,
    private readonly room = KERNEL_ROOM_BUDGET,
    private readonly now: () => number = Date.now,
  ) {}

  allowHook(packId: string, packLimit: number): boolean {
    return this.allow("hook", packId, packLimit, this.room.hookPerMin);
  }

  allowSchedule(packId: string, packLimit: number): boolean {
    return this.allow("schedule", packId, packLimit, this.room.schedulePerMin);
  }

  private allow(
    kind: "hook" | "schedule",
    packId: string,
    packLimit: number,
    roomLimit: number,
  ): boolean {
    this.roll();
    const packMap = kind === "hook" ? this.hookByPack : this.schedByPack;
    const packUsed = packMap.get(packId) ?? 0;
    const roomUsed = kind === "hook" ? this.roomHook : this.roomSched;
    if (packUsed >= packLimit || roomUsed >= roomLimit) return false;
    packMap.set(packId, packUsed + 1);
    if (kind === "hook") this.roomHook += 1;
    else this.roomSched += 1;
    return true;
  }

  private roll(): void {
    const t = this.now();
    if (this.windowStart === null || t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.hookByPack.clear();
      this.schedByPack.clear();
      this.roomHook = 0;
      this.roomSched = 0;
    }
  }
}

export type KernelCtx = {
  readonly room: KernelRoomView;
  log: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
  onDispose: (fn: () => void | Promise<void>) => void;
  provide: (
    name: string,
    api: Record<string, (...args: unknown[]) => unknown>,
  ) => void;
  hooks: {
    on: (name: typeof KERNEL_HOOK_CHAT_IN, handler: ChatInHandler) => void;
  };
  storage?: RoomKv;
  schedule?: {
    every: (
      ms: number,
      run: KernelScheduleJob["run"],
    ) => void;
  };
};

export type KernelProvideReg = { name: string; methods: string[] };

export type CreateModCtxResult = {
  ctx: KernelCtx;
  disposers: Array<() => void | Promise<void>>;
  provides: KernelProvideReg[];
  hooks: Array<{ name: typeof KERNEL_HOOK_CHAT_IN; handler: ChatInHandler }>;
  schedules: KernelScheduleJob[];
  seal: () => void;
};

const BUILTIN_KEYS = new Set([
  "room",
  "log",
  "onDispose",
  "provide",
  "hooks",
]);

const ALLOWED_PERMS = new Set<string>([
  KERNEL_PERM_STORAGE_ROOM,
  KERNEL_PERM_SCHEDULE_ROOM,
]);
const ALLOWED_HOOKS = new Set<string>([KERNEL_HOOK_CHAT_IN]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function asStringList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

export function parseKernelManifest(raw: unknown): KernelManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.id)) throw new Error("id is required");
  if (!isNonEmptyString(o.version)) throw new Error("version is required");
  if (o.hostApi !== MOD_KERNEL_API) {
    throw new Error(`hostApi must be ${MOD_KERNEL_API}`);
  }
  const inject = asStringList(o.inject, "inject");
  const provides = asStringList(o.provides, "provides");
  const permissions = asStringList(o.permissions, "permissions");
  const hooks = asStringList(o.hooks, "hooks");
  const budget = parseBudget(o.budget);
  for (const p of permissions) {
    if (!ALLOWED_PERMS.has(p)) {
      throw new Error(`unknown permission: ${p}`);
    }
  }
  for (const h of hooks) {
    if (!ALLOWED_HOOKS.has(h)) {
      throw new Error(`unknown hook: ${h}`);
    }
  }
  const id = o.id.trim();
  const name = isNonEmptyString(o.name) ? o.name.trim() : id;
  return {
    id,
    name,
    version: o.version.trim(),
    hostApi: MOD_KERNEL_API,
    inject,
    provides,
    permissions,
    hooks,
    budget,
  };
}

function parseBudget(raw: unknown): KernelBudget {
  if (raw === undefined) return { ...KERNEL_BUDGET_DEFAULT };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("budget must be an object");
  }
  const o = raw as Record<string, unknown>;
  return {
    hookPerMin: parseBudgetInt(o.hookPerMin, KERNEL_BUDGET_DEFAULT.hookPerMin, "budget.hookPerMin"),
    schedulePerMin: parseBudgetInt(
      o.schedulePerMin,
      KERNEL_BUDGET_DEFAULT.schedulePerMin,
      "budget.schedulePerMin",
    ),
  };
}

function parseBudgetInt(v: unknown, fallback: number, field: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10_000) {
    throw new Error(`${field} invalid`);
  }
  return v;
}

const FORBIDDEN_ID_MSG: Record<string, string> = {
  Function: "Function constructor is forbidden",
  setTimeout: "setTimeout is forbidden; use ctx.schedule",
  setInterval: "setInterval is forbidden; use ctx.schedule",
  require: "require is forbidden",
  process: "process is forbidden",
  eval: "eval is forbidden",
};

function walkAst(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (typeof n.type === "string") visit(n);
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) {
      for (const item of v) walkAst(item, visit);
    } else {
      walkAst(v, visit);
    }
  }
}

export function scanKernelForbiddenApis(source: string): void {
  let ast: unknown;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    throw new Error("mod.js is not valid JavaScript");
  }
  walkAst(ast, (node) => {
    const type = String(node.type ?? "");
    if (type === "ImportExpression") {
      throw new Error("dynamic import is forbidden");
    }
    if (type === "ImportDeclaration") {
      throw new Error("module import is forbidden");
    }
    if (
      (type === "ExportAllDeclaration" || type === "ExportNamedDeclaration") &&
      node.source
    ) {
      throw new Error("module import is forbidden");
    }
    if (type === "Identifier") {
      const msg = FORBIDDEN_ID_MSG[String(node.name ?? "")];
      if (msg) throw new Error(msg);
    }
    if (type === "MemberExpression" && node.computed) {
      const prop = node.property as { type?: string; value?: unknown } | undefined;
      if (prop?.type === "Literal" && typeof prop.value === "string") {
        const msg = FORBIDDEN_ID_MSG[prop.value];
        if (msg) throw new Error(msg);
      }
    }
  });
}

export function compileKernelActivate(source: string): (ctx: KernelCtx) => void {
  scanKernelForbiddenApis(source);
  const transformed = source
    .replace(/export\s+default\s+function\s+activate\b/g, "function activate")
    .replace(/export\s+function\s+activate\b/g, "function activate")
    .replace(/export\s+const\s+activate\s*=/g, "const activate =")
    .replace(/export\s+default\s+activate\b/g, "")
    .replace(/export\s*\{\s*activate\s*(?:as\s+default\s*)?\}/g, "");
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
    Math,
    Date,
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
    Function: undefined,
    eval: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    process: undefined,
    require: undefined,
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  const wrapped = `(function (exports, module) {
${transformed}
if (typeof activate === "function") exports.activate = activate;
else if (typeof module.exports === "function") exports.activate = module.exports;
else if (module.exports && typeof module.exports.activate === "function") {
  exports.activate = module.exports.activate;
} else if (module.exports && typeof module.exports.default === "function") {
  exports.activate = module.exports.default;
}
})(exports, module);`;
  try {
    vm.runInNewContext(wrapped, sandbox, {
      timeout: 1000,
      displayErrors: true,
      contextCodeGeneration: { strings: false, wasm: false },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`mod.js failed to load: ${msg}`);
  }
  const activate = exportsObj.activate;
  if (typeof activate !== "function") throw new Error("activate is required");
  return activate as (ctx: KernelCtx) => void;
}

function instanceOf(
  m: KernelManifest,
  state: KernelModState,
  extra?: Pick<KernelInstance, "pendingReason" | "failedReason"> & { id?: string },
): KernelInstance {
  const { id: overrideId, ...rest } = extra ?? {};
  return {
    id: overrideId ?? m.id,
    version: m.version,
    state,
    provides: [...m.provides],
    inject: [...m.inject],
    hooks: [...m.hooks],
    ...rest,
  };
}

function sameNameSet(a: string[], b: string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((x, i) => x === right[i]);
}

function assertDeclaredProvides(manifest: KernelManifest, got: string[]): void {
  if (sameNameSet(manifest.provides, got)) return;
  throw new Error(
    `provides mismatch: declared [${manifest.provides.join(", ")}] got [${got.join(", ")}]`,
  );
}

/**
 * Plan the graph: pending / failed / active (ready to activate), Kahn order.
 * Does not run activate().
 */
export function planKernelGraph(manifests: KernelManifest[]): {
  order: string[];
  graph: KernelGraph;
} {
  const byId = new Map<string, KernelManifest>();
  const failed = new Map<string, KernelInstance>();

  for (const m of manifests) {
    if (byId.has(m.id) || failed.has(m.id)) {
      const prev = byId.get(m.id);
      if (prev) {
        failed.set(m.id, instanceOf(prev, "failed", { failedReason: "duplicate id" }));
        byId.delete(m.id);
      }
      let alias = `${m.id}#dup`;
      let n = 1;
      while (failed.has(alias)) {
        n += 1;
        alias = `${m.id}#dup${n}`;
      }
      failed.set(
        alias,
        instanceOf(m, "failed", { failedReason: "duplicate id", id: alias }),
      );
      continue;
    }
    byId.set(m.id, m);
  }

  const provideOwners = new Map<string, string[]>();
  for (const m of byId.values()) {
    for (const p of m.provides) {
      const list = provideOwners.get(p) ?? [];
      list.push(m.id);
      provideOwners.set(p, list);
    }
  }
  for (const [name, owners] of provideOwners) {
    if (owners.length < 2) continue;
    for (const id of owners) {
      const m = byId.get(id);
      if (!m) continue;
      failed.set(
        id,
        instanceOf(m, "failed", { failedReason: `duplicate provide: ${name}` }),
      );
      byId.delete(id);
    }
  }

  const pending = new Map<string, KernelInstance>();
  for (const m of [...byId.values()]) {
    const missing = m.inject.filter((x) => {
      const owners = (provideOwners.get(x) ?? []).filter((id) => byId.has(id));
      return owners.length === 0;
    });
    if (missing.length) {
      pending.set(
        m.id,
        instanceOf(m, "pending", {
          pendingReason: `missing inject: ${missing.join(", ")}`,
        }),
      );
      byId.delete(m.id);
    }
  }

  const remaining = new Set(byId.keys());
  const preds = new Map<string, Set<string>>();
  const succs = new Map<string, Set<string>>();
  for (const id of remaining) {
    preds.set(id, new Set());
    succs.set(id, new Set());
  }
  for (const m of byId.values()) {
    for (const x of m.inject) {
      const owners = (provideOwners.get(x) ?? []).filter((id) => remaining.has(id));
      for (const a of owners) {
        if (a === m.id) continue;
        preds.get(m.id)!.add(a);
        succs.get(a)!.add(m.id);
      }
    }
  }

  const order: string[] = [];
  const ready: string[] = [];
  for (const id of remaining) {
    if (preds.get(id)!.size === 0) ready.push(id);
  }
  ready.sort();
  while (ready.length) {
    const id = ready.shift()!;
    remaining.delete(id);
    order.push(id);
    for (const s of succs.get(id) ?? []) {
      preds.get(s)!.delete(id);
      if (preds.get(s)!.size === 0) {
        ready.push(s);
        ready.sort();
      }
    }
  }

  for (const id of remaining) {
    const m = byId.get(id)!;
    failed.set(id, instanceOf(m, "failed", { failedReason: "dependency cycle" }));
    byId.delete(id);
  }

  const active = order.map((id) => instanceOf(byId.get(id)!, "active"));
  return {
    order,
    graph: {
      active,
      pending: [...pending.values()],
      failed: [...failed.values()],
    },
  };
}

export function createModCtx(opts: {
  manifest: KernelManifest;
  room: KernelRoomView;
  bag?: Record<string, unknown>;
  storage?: RoomKv;
  log?: KernelCtx["log"];
}): CreateModCtxResult {
  const manifest = opts.manifest;
  const bag = { ...(opts.bag ?? {}) };
  const disposers: Array<() => void | Promise<void>> = [];
  const provides: KernelProvideReg[] = [];
  const hooks: CreateModCtxResult["hooks"] = [];
  const schedules: KernelScheduleJob[] = [];
  let sealed = false;
  const allowStorage = manifest.permissions.includes(KERNEL_PERM_STORAGE_ROOM);
  const allowSchedule = manifest.permissions.includes(KERNEL_PERM_SCHEDULE_ROOM);

  const declared = new Set<string>([
    ...BUILTIN_KEYS,
    ...manifest.inject,
    ...(allowStorage ? ["storage"] : []),
    ...(allowSchedule ? ["schedule"] : []),
  ]);

  const provide: KernelCtx["provide"] = (name, api) => {
    if (sealed) throw new Error("provide() after activate");
    if (!manifest.provides.includes(name)) {
      throw new Error(`undeclared provide: ${name}`);
    }
    const methods: string[] = [];
    for (const [k, v] of Object.entries(api)) {
      if (typeof v !== "function") {
        throw new Error(`provide ${name}.${k} must be a function`);
      }
      methods.push(k);
    }
    provides.push({ name, methods });
  };

  const hooksApi: KernelCtx["hooks"] = {
    on: (name, handler) => {
      if (sealed) throw new Error("hooks.on() after activate");
      if (!manifest.hooks.includes(name)) {
        throw new Error(`undeclared hook: ${name}`);
      }
      hooks.push({ name, handler });
    },
  };

  const scheduleApi: NonNullable<KernelCtx["schedule"]> = {
    every: (ms, run) => {
      if (sealed) throw new Error("schedule.every() after activate");
      if (typeof run !== "function") throw new Error("schedule.every requires a function");
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) throw new Error("schedule interval invalid");
      if (schedules.length >= KERNEL_SCHEDULE_MAX_JOBS) {
        throw new Error("schedule job limit");
      }
      schedules.push({
        ms: Math.max(Math.floor(n), KERNEL_SCHEDULE_MIN_MS),
        run,
      });
    },
  };

  const target: KernelCtx = {
    room: opts.room,
    log: opts.log ?? (() => undefined),
    onDispose: (fn) => {
      disposers.push(fn);
    },
    provide,
    hooks: hooksApi,
    ...(allowStorage && opts.storage ? { storage: opts.storage } : {}),
    ...(allowSchedule ? { schedule: scheduleApi } : {}),
  };

  const ctx = new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop !== "string") return Reflect.get(t, prop, recv);
      if (!declared.has(prop)) {
        throw new Error(`undeclared ctx.${prop}`);
      }
      if (prop === "storage") {
        if (!allowStorage) throw new Error("undeclared ctx.storage");
        const v = t.storage ?? bag.storage;
        if (v === undefined) throw new Error("ctx.storage is not provided");
        return v;
      }
      if (prop === "schedule") {
        if (!allowSchedule) throw new Error("undeclared ctx.schedule");
        return t.schedule;
      }
      if (BUILTIN_KEYS.has(prop)) return Reflect.get(t, prop, recv);
      if (manifest.inject.includes(prop)) {
        if (!(prop in bag) && !Object.prototype.hasOwnProperty.call(t, prop)) {
          throw new Error(`ctx.${prop} is not provided`);
        }
        if (prop in bag) return bag[prop];
      }
      return Reflect.get(t, prop, recv);
    },
    set() {
      throw new Error("ctx is read-only");
    },
    defineProperty() {
      throw new Error("ctx is read-only");
    },
    deleteProperty() {
      throw new Error("ctx is read-only");
    },
    ownKeys() {
      return [...declared];
    },
    getOwnPropertyDescriptor(t, prop) {
      if (typeof prop !== "string" || !declared.has(prop)) return undefined;
      return {
        enumerable: true,
        configurable: true,
        get: () => Reflect.get(t, prop),
      };
    },
  });

  return {
    ctx,
    disposers,
    provides,
    hooks,
    schedules,
    seal: () => {
      sealed = true;
    },
  };
}

export type KernelActivatePack = {
  manifest: KernelManifest;
  activate: (ctx: KernelCtx) => void;
};

/**
 * Fixture runner: plan the graph, then call activate() in order.
 * Activate throw → that pack failed; its provides vanish; dependents go pending.
 */
export function runKernelActivate(
  packs: KernelActivatePack[],
  room: KernelRoomView,
  storage?: RoomKv,
): { graph: KernelGraph; provides: KernelProvideReg[] } {
  const manifests = packs.map((p) => p.manifest);
  const byId = new Map(packs.map((p) => [p.manifest.id, p]));
  const planned = planKernelGraph(manifests);
  const active: KernelInstance[] = [];
  const pending = [...planned.graph.pending];
  const failed = [...planned.graph.failed];
  const liveProvides: KernelProvideReg[] = [];
  const providedNames = new Set<string>();

  for (const id of planned.order) {
    const pack = byId.get(id);
    if (!pack) continue;
    const missing = pack.manifest.inject.filter((x) => !providedNames.has(x));
    if (missing.length) {
      pending.push({
        id: pack.manifest.id,
        version: pack.manifest.version,
        state: "pending",
        pendingReason: `missing inject: ${missing.join(", ")}`,
        provides: [...pack.manifest.provides],
        inject: [...pack.manifest.inject],
        hooks: [...pack.manifest.hooks],
      });
      continue;
    }
    const bag: Record<string, unknown> = {};
    for (const name of pack.manifest.inject) {
      bag[name] = hostInjectStub(name, storage);
    }
    const session = createModCtx({
      manifest: pack.manifest,
      room,
      bag,
      storage,
    });
    try {
      pack.activate(session.ctx);
      session.seal();
      const liveNames = session.provides.map((reg) => reg.name);
      assertDeclaredProvides(pack.manifest, liveNames);
      for (const reg of session.provides) {
        liveProvides.push(reg);
        providedNames.add(reg.name);
      }
      active.push({
        id: pack.manifest.id,
        version: pack.manifest.version,
        state: "active",
        provides: liveNames,
        inject: [...pack.manifest.inject],
        hooks: [...pack.manifest.hooks],
      });
    } catch (err) {
      session.seal();
      failed.push({
        id: pack.manifest.id,
        version: pack.manifest.version,
        state: "failed",
        failedReason: err instanceof Error ? err.message : String(err),
        provides: [...pack.manifest.provides],
        inject: [...pack.manifest.inject],
        hooks: [...pack.manifest.hooks],
      });
    }
  }

  return {
    graph: { active, pending, failed },
    provides: liveProvides,
  };
}

export async function runChatInRailway(
  handlers: ChatInHandler[],
  env: ChatInEnvelope,
): Promise<WaterfallResult<ChatInEnvelope>> {
  let current = env;
  for (const handler of handlers) {
    let result: WaterfallResult<ChatInEnvelope>;
    try {
      result = await withTimeout(Promise.resolve(handler(current)), CHAT_IN_HOOK_TIMEOUT_MS);
    } catch {
      continue;
    }
    if (!result || (result.action !== "continue" && result.action !== "replace" && result.action !== "drop")) {
      continue;
    }
    if (result.action === "drop") return result;
    if (result.value) current = result.value;
  }
  return { action: "continue", value: current };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hook timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

type LivePack = {
  id: string;
  disposers: Array<() => void | Promise<void>>;
};

export class ModKernel {
  private graph: KernelGraph = { active: [], pending: [], failed: [] };
  private live: LivePack[] = [];
  private chatInHandlers: Array<{
    packId: string;
    handler: ChatInHandler;
    budget: KernelBudget;
  }> = [];
  private scheduleJobs: KernelScheduleJob[] = [];
  private disposed = false;
  readonly budget: KernelBudgetGate;

  constructor(
    private readonly storage?: RoomKv,
    opts?: { budget?: KernelBudgetGate },
  ) {
    this.budget = opts?.budget ?? new KernelBudgetGate();
  }

  snapshot(): KernelGraph {
    return {
      active: [...this.graph.active],
      pending: [...this.graph.pending],
      failed: [...this.graph.failed],
    };
  }

  listScheduleJobs(): KernelScheduleJob[] {
    return [...this.scheduleJobs];
  }

  consumeSchedule(packId: string, limit: number): boolean {
    const ok = this.budget.allowSchedule(packId, limit);
    if (!ok) kernelLog("budget", { packId, kind: "schedule", action: "skip" });
    return ok;
  }

  start(packs: KernelActivatePack[], room: KernelRoomView): KernelGraph {
    if (this.disposed) throw new Error("kernel disposed");
    this.chatInHandlers = [];
    this.scheduleJobs = [];
    this.live = [];
    const manifests = packs.map((p) => p.manifest);
    const byId = new Map(packs.map((p) => [p.manifest.id, p]));
    const planned = planKernelGraph(manifests);
    const active: KernelInstance[] = [];
    const pending = [...planned.graph.pending];
    const failed = [...planned.graph.failed];
    const providedNames = new Set<string>();

    for (const id of planned.order) {
      const pack = byId.get(id);
      if (!pack) continue;
      const missing = pack.manifest.inject.filter((x) => !providedNames.has(x));
      if (missing.length) {
        pending.push({
          id: pack.manifest.id,
          version: pack.manifest.version,
          state: "pending",
          pendingReason: `missing inject: ${missing.join(", ")}`,
          provides: [...pack.manifest.provides],
          inject: [...pack.manifest.inject],
          hooks: [...pack.manifest.hooks],
        });
        continue;
      }
      const bag: Record<string, unknown> = {};
      for (const name of pack.manifest.inject) {
        bag[name] = hostInjectStub(name, this.storage);
      }
      const session = createModCtx({
        manifest: pack.manifest,
        room,
        bag,
        storage: this.storage,
      });
      try {
        pack.activate(session.ctx);
        session.seal();
        const liveProvides = session.provides.map((reg) => reg.name);
        assertDeclaredProvides(pack.manifest, liveProvides);
        for (const name of liveProvides) providedNames.add(name);
        for (const h of session.hooks) {
          this.chatInHandlers.push({
            packId: pack.manifest.id,
            handler: h.handler,
            budget: pack.manifest.budget,
          });
        }
        this.scheduleJobs.push(
          ...session.schedules.map((job) => ({
            ...job,
            packId: pack.manifest.id,
            budget: pack.manifest.budget,
          })),
        );
        this.live.push({
          id: pack.manifest.id,
          disposers: [
            ...session.disposers,
            () => {
              this.chatInHandlers = this.chatInHandlers.filter(
                (reg) => !session.hooks.some((h) => h.handler === reg.handler),
              );
            },
          ],
        });
        kernelLog("activate", {
          id: pack.manifest.id,
          provides: liveProvides,
        });
        active.push({
          id: pack.manifest.id,
          version: pack.manifest.version,
          state: "active",
          provides: liveProvides,
          inject: [...pack.manifest.inject],
          hooks: [...pack.manifest.hooks],
        });
      } catch (err) {
        session.seal();
        const failedReason = err instanceof Error ? err.message : String(err);
        kernelLog("failed", { id: pack.manifest.id, error: failedReason });
        failed.push({
          id: pack.manifest.id,
          version: pack.manifest.version,
          state: "failed",
          failedReason,
          provides: [...pack.manifest.provides],
          inject: [...pack.manifest.inject],
          hooks: [...pack.manifest.hooks],
        });
      }
    }

    this.graph = { active, pending, failed };
    return this.snapshot();
  }

  runChatIn(env: ChatInEnvelope): Promise<WaterfallResult<ChatInEnvelope>> {
    if (this.disposed) return Promise.resolve({ action: "continue", value: env });
    const handlers = this.chatInHandlers
      .filter((reg) => {
        const ok = this.budget.allowHook(reg.packId, reg.budget.hookPerMin);
        if (!ok) {
          kernelLog("budget", { packId: reg.packId, kind: "hook", action: "skip" });
        }
        return ok;
      })
      .map((reg) => reg.handler);
    return runChatInRailway(handlers, env);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const pack of [...this.live].reverse()) {
      for (const fn of [...pack.disposers].reverse()) {
        try {
          await fn();
        } catch {
          // disposer errors must not block unload
        }
      }
    }
    kernelLog("dispose", { count: this.live.length });
    this.live = [];
    this.chatInHandlers = [];
    this.scheduleJobs = [];
    this.graph = {
      active: this.graph.active.map((x) => ({ ...x, state: "disposed" })),
      pending: this.graph.pending,
      failed: this.graph.failed,
    };
  }
}
