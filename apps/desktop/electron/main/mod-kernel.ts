import { MOD_KERNEL_API } from "@claude-desktop/shared";

export { MOD_KERNEL_API };

export const KERNEL_HOOK_CHAT_IN = "room.chat.in" as const;
export const KERNEL_PERM_STORAGE_ROOM = "storage:room" as const;

export type KernelModState = "pending" | "active" | "failed" | "disposed";

export type KernelManifest = {
  id: string;
  name: string;
  version: string;
  hostApi: typeof MOD_KERNEL_API;
  inject: string[];
  provides: string[];
  permissions: string[];
  hooks: string[];
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

export type ChatInHandler = (env: {
  text: string;
  seatId: string;
  userId: string;
}) => { action: "continue" | "replace" | "drop"; value?: { text: string } };

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
};

export type KernelProvideReg = { name: string; methods: string[] };

export type CreateModCtxResult = {
  ctx: KernelCtx;
  disposers: Array<() => void | Promise<void>>;
  provides: KernelProvideReg[];
  hooks: Array<{ name: typeof KERNEL_HOOK_CHAT_IN; handler: ChatInHandler }>;
  seal: () => void;
};

const BUILTIN_KEYS = new Set([
  "room",
  "log",
  "onDispose",
  "provide",
  "hooks",
]);

const ALLOWED_PERMS = new Set<string>([KERNEL_PERM_STORAGE_ROOM]);
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
  };
}

const KERNEL_FORBIDDEN: { re: RegExp; message: string }[] = [
  { re: /\brequire\s*\(/, message: "require is forbidden" },
  { re: /\bimport\s*\(/, message: "dynamic import is forbidden" },
  { re: /\bfrom\s+['"]/, message: "module import is forbidden" },
  { re: /\bimport\s+['"]/, message: "module import is forbidden" },
];

export function scanKernelForbiddenApis(source: string): void {
  for (const rule of KERNEL_FORBIDDEN) {
    if (rule.re.test(source)) throw new Error(rule.message);
  }
}

function instanceOf(
  m: KernelManifest,
  state: KernelModState,
  extra?: Pick<KernelInstance, "pendingReason" | "failedReason">,
): KernelInstance {
  return {
    id: m.id,
    version: m.version,
    state,
    provides: [...m.provides],
    inject: [...m.inject],
    hooks: [...m.hooks],
    ...extra,
  };
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
      failed.set(
        `${m.id}#dup`,
        instanceOf(m, "failed", { failedReason: "duplicate id" }),
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
  let sealed = false;
  const allowStorage = manifest.permissions.includes(KERNEL_PERM_STORAGE_ROOM);

  const declared = new Set<string>([
    ...BUILTIN_KEYS,
    ...manifest.inject,
    ...(allowStorage ? ["storage"] : []),
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

  const target: KernelCtx = {
    room: opts.room,
    log: opts.log ?? (() => undefined),
    onDispose: (fn) => {
      disposers.push(fn);
    },
    provide,
    hooks: hooksApi,
    ...(allowStorage && opts.storage ? { storage: opts.storage } : {}),
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
    for (const name of pack.manifest.inject) bag[name] = { provided: true };
    const session = createModCtx({
      manifest: pack.manifest,
      room,
      bag,
      storage,
    });
    try {
      pack.activate(session.ctx);
      session.seal();
      for (const reg of session.provides) {
        liveProvides.push(reg);
        providedNames.add(reg.name);
      }
      active.push({
        id: pack.manifest.id,
        version: pack.manifest.version,
        state: "active",
        provides: [...pack.manifest.provides],
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

type LivePack = {
  id: string;
  disposers: Array<() => void | Promise<void>>;
};

export class ModKernel {
  private graph: KernelGraph = { active: [], pending: [], failed: [] };
  private live: LivePack[] = [];
  private disposed = false;

  constructor(private readonly storage?: RoomKv) {}

  snapshot(): KernelGraph {
    return {
      active: [...this.graph.active],
      pending: [...this.graph.pending],
      failed: [...this.graph.failed],
    };
  }

  start(packs: KernelActivatePack[], room: KernelRoomView): KernelGraph {
    if (this.disposed) throw new Error("kernel disposed");
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
      for (const name of pack.manifest.inject) bag[name] = { provided: true };
      const session = createModCtx({
        manifest: pack.manifest,
        room,
        bag,
        storage: this.storage,
      });
      try {
        pack.activate(session.ctx);
        session.seal();
        for (const reg of session.provides) providedNames.add(reg.name);
        this.live.push({ id: pack.manifest.id, disposers: session.disposers });
        active.push({
          id: pack.manifest.id,
          version: pack.manifest.version,
          state: "active",
          provides: [...pack.manifest.provides],
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

    this.graph = { active, pending, failed };
    return this.snapshot();
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
    this.live = [];
    this.graph = {
      active: this.graph.active.map((x) => ({ ...x, state: "disposed" })),
      pending: this.graph.pending,
      failed: this.graph.failed,
    };
  }
}
