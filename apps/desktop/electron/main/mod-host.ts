import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  createModRuntime,
  type AgentTurn,
  type ModIntent,
  type ModRuntime,
  type ModSeat,
  type PersistLogEntry,
  type ReduceCtxIn,
} from "./mod-game";
import type { LoadedMod } from "./mod-package";
import {
  createWorkerState,
  handleWorkerMessage,
  type WorkerReply,
  type WorkerRequest,
} from "./mod-host-worker";

export type { ModIntent, ModSeat };

export type ModPersistFile = {
  checksum: string;
  seed: string;
  snapshot: unknown;
  log: PersistLogEntry[];
  seq: number;
  rngState?: number;
};

export type ModHostStartOpts = {
  roomId: string;
  loaded: LoadedMod;
  persistPath: string;
  seed?: string;
  workerScript?: string;
  inProcess?: boolean;
};

type FailCb = (err: string) => void;

type PersistSlice = {
  snapshot: unknown;
  log: PersistLogEntry[];
  seq: number;
  rngState: number;
};

type HostBackend = {
  views: (seats: ModSeat[]) => Promise<{
    seq: number;
    publicView: unknown;
    seatViews: Record<string, unknown>;
  }>;
  actions: (seatId: string) => Promise<unknown>;
  agentTurn: (seatId: string) => Promise<AgentTurn | null>;
  reduce: (
    intent: ModIntent,
    ctx: ReduceCtxIn,
  ) => Promise<{ seq: number }>;
  persistState: () => Promise<PersistSlice>;
  compact: () => Promise<void>;
  restore: (opts: {
    seed: string;
    snapshot?: unknown;
    log?: PersistLogEntry[];
    rngState?: number;
    seq?: number;
  }) => Promise<void>;
  reset: () => Promise<void>;
  dispose: () => void;
  isDead: () => boolean;
  simulateCrash: () => void;
};

type WorkerTransport = {
  postMessage: (msg: unknown) => void;
  onMessage: (cb: (msg: unknown) => void) => void;
  onExit: (cb: () => void) => void;
  kill: () => void;
};

const LIMIT_RE = /exceeds|JSON|depth|bytes|serializ/i;

function isLimitError(error: string): boolean {
  return LIMIT_RE.test(error);
}

function defaultInProcess(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  if (process.env.VITEST) return true;
  return !tryUtilityProcess();
}

function tryUtilityProcess(): { fork: (script: string) => UtilityChild } | null {
  try {
    const require = createRequire(__filename);
    const electron = require("electron") as {
      utilityProcess?: { fork: (script: string) => UtilityChild };
    };
    if (!electron.utilityProcess?.fork) return null;
    return electron.utilityProcess;
  } catch {
    return null;
  }
}

type UtilityChild = {
  on: (event: "message" | "exit", cb: (...args: unknown[]) => void) => void;
  postMessage: (msg: unknown) => void;
  kill: () => void;
};

function defaultWorkerScript(): string {
  return path.join(
    typeof __dirname !== "undefined" ? __dirname : process.cwd(),
    "mod-host-worker.js",
  );
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
    fs.renameSync(tmp, filePath);
  }
}

function readPersist(filePath: string): ModPersistFile {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw) as Partial<ModPersistFile>;
  if (typeof data.checksum !== "string" || typeof data.seed !== "string") {
    throw new Error("invalid persist file");
  }
  if (!Array.isArray(data.log)) throw new Error("invalid persist log");
  if (!Number.isInteger(data.seq)) throw new Error("invalid persist seq");
  return data as ModPersistFile;
}

function unwrapIpc(raw: unknown): unknown {
  if (
    raw &&
    typeof raw === "object" &&
    "data" in raw &&
    !("ok" in raw) &&
    !("type" in raw)
  ) {
    return (raw as { data: unknown }).data;
  }
  return raw;
}

function utilityTransport(child: UtilityChild): WorkerTransport {
  return {
    postMessage: (msg) => child.postMessage(msg),
    onMessage: (cb) => {
      child.on("message", (raw) => cb(unwrapIpc(raw)));
    },
    onExit: (cb) => {
      child.on("exit", () => cb());
    },
    kill: () => child.kill(),
  };
}

function childProcessTransport(child: ChildProcess): WorkerTransport {
  return {
    postMessage: (msg) => {
      child.send(msg as object);
    },
    onMessage: (cb) => {
      child.on("message", (raw) => cb(unwrapIpc(raw)));
    },
    onExit: (cb) => {
      child.on("exit", () => cb());
    },
    kill: () => {
      child.kill();
    },
  };
}

export function createLoopbackTransport(): WorkerTransport {
  const state = createWorkerState();
  let messageCb: ((msg: unknown) => void) | null = null;
  let exitCb: (() => void) | null = null;
  let dead = false;
  return {
    postMessage(msg) {
      if (dead) return;
      const reply = handleWorkerMessage(state, msg);
      messageCb?.(reply);
    },
    onMessage(cb) {
      messageCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
    kill() {
      if (dead) return;
      dead = true;
      exitCb?.();
    },
  };
}

class InProcessBackend implements HostBackend {
  private runtime: ModRuntime;
  private readonly hostJsSource: string;

  constructor(hostJsSource: string, seed: string) {
    this.hostJsSource = hostJsSource;
    this.runtime = createModRuntime(hostJsSource, seed);
  }

  async views(seats: ModSeat[]) {
    return this.runtime.views(seats);
  }

  async actions(seatId: string) {
    return this.runtime.actions(seatId);
  }

  async agentTurn(seatId: string) {
    return this.runtime.agentTurn(seatId);
  }

  async reduce(intent: ModIntent, ctx: ReduceCtxIn) {
    return this.runtime.reduce(intent, ctx);
  }

  async persistState() {
    return this.runtime.persistState();
  }

  async compact() {
    this.runtime.compact();
  }

  async restore(opts: {
    seed: string;
    snapshot?: unknown;
    log?: PersistLogEntry[];
    rngState?: number;
    seq?: number;
  }) {
    this.runtime = createModRuntime(this.hostJsSource, opts.seed, {
      snapshot: opts.snapshot,
      log: opts.log,
      rngState: opts.rngState,
      seq: opts.seq,
    });
  }

  async reset() {
    this.runtime.reset();
  }

  dispose() {}

  isDead() {
    return false;
  }

  simulateCrash() {}
}

class WorkerBackend implements HostBackend {
  private readonly transport: WorkerTransport;
  private readonly hostJsSource: string;
  private seed: string;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: WorkerReply) => void;
      reject: (e: Error) => void;
    }
  >();
  private dead = false;

  constructor(transport: WorkerTransport, hostJsSource: string, seed: string) {
    this.transport = transport;
    this.hostJsSource = hostJsSource;
    this.seed = seed;
    this.transport.onMessage((raw) => this.onReply(raw));
  }

  onExit(cb: () => void): void {
    this.transport.onExit(() => {
      this.dead = true;
      for (const [, p] of this.pending) {
        p.reject(new Error("mod worker exited"));
      }
      this.pending.clear();
      cb();
    });
  }

  async init(opts?: {
    snapshot?: unknown;
    log?: unknown[];
    rngState?: number;
    seq?: number;
  }): Promise<void> {
    const reply = await this.rpc({
      type: "init",
      hostJsSource: this.hostJsSource,
      seed: this.seed,
      snapshot: opts?.snapshot,
      log: opts?.log,
      rngState: opts?.rngState,
      seq: opts?.seq,
    });
    if (!reply.ok) throw new Error(reply.error || "mod worker init failed");
    this.initialized = true;
  }

  async views(seats: ModSeat[]) {
    const reply = await this.rpc({ type: "views", seats });
    if (!reply.ok) throw new Error(reply.error || "views failed");
    return {
      seq: reply.seq ?? 0,
      publicView: reply.publicView,
      seatViews: reply.seatViews ?? {},
    };
  }

  async actions(seatId: string) {
    const reply = await this.rpc({
      type: "query",
      method: "actions",
      seatId,
    });
    if (!reply.ok) throw new Error(reply.error || "actions failed");
    return reply.result;
  }

  async agentTurn(seatId: string) {
    const reply = await this.rpc({
      type: "query",
      method: "agentTurn",
      seatId,
    });
    if (!reply.ok) throw new Error(reply.error || "agentTurn failed");
    return (reply.result as AgentTurn | null) ?? null;
  }

  async reduce(intent: ModIntent, ctx: ReduceCtxIn) {
    const reply = await this.rpc({ type: "reduce", intent, ctx });
    if (!reply.ok) throw new Error(reply.error || "reduce failed");
    return { seq: reply.seq ?? 0 };
  }

  async persistState(): Promise<PersistSlice> {
    const reply = await this.rpc({ type: "persist" });
    if (!reply.ok) throw new Error(reply.error || "persist failed");
    return {
      snapshot: reply.snapshot,
      log: reply.log ?? [],
      seq: reply.seq ?? 0,
      rngState: reply.rngState ?? 0,
    };
  }

  async compact() {
    const reply = await this.rpc({ type: "compact" });
    if (!reply.ok) throw new Error(reply.error || "compact failed");
  }

  async restore(opts: {
    seed: string;
    snapshot?: unknown;
    log?: PersistLogEntry[];
    rngState?: number;
    seq?: number;
  }) {
    this.seed = opts.seed;
    await this.init({
      snapshot: opts.snapshot,
      log: opts.log,
      rngState: opts.rngState,
      seq: opts.seq,
    });
  }

  async reset() {
    if (!this.initialized) {
      await this.init();
      return;
    }
    const reply = await this.rpc({ type: "reset" });
    if (!reply.ok) throw new Error(reply.error || "reset failed");
  }

  isDead() {
    return this.dead;
  }

  simulateCrash() {
    this.transport.kill();
  }

  dispose() {
    this.dead = true;
    for (const [, p] of this.pending) {
      p.reject(new Error("disposed"));
    }
    this.pending.clear();
    this.transport.kill();
  }

  private onReply(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const reply = raw as WorkerReply;
    if (typeof reply.id !== "number") return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    pending.resolve(reply);
  }

  private rpc(msg: WorkerRequest): Promise<WorkerReply> {
    if (this.dead) return Promise.reject(new Error("mod worker exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.postMessage({ ...msg, id });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

function openWorkerTransport(opts: {
  workerScript?: string;
}): WorkerTransport {
  const script = opts.workerScript ?? defaultWorkerScript();
  const utility = tryUtilityProcess();
  if (utility) {
    return utilityTransport(utility.fork(script));
  }
  if (opts.workerScript) {
    const child = fork(opts.workerScript, [], { serialization: "json" });
    return childProcessTransport(child);
  }
  if (process.env.VITEST) {
    return createLoopbackTransport();
  }
  throw new Error("mod worker unavailable");
}

export class ModHost {
  readonly checksum: string;
  readonly roomId: string;
  private _seed: string;
  private _failed = false;
  private failReason = "";
  private disposed = false;
  private readonly persistPath: string;
  private readonly hostJsSource: string;
  private readonly workerScript?: string;
  private readonly useWorker: boolean;
  private backend: HostBackend;
  private readonly failCbs: FailCb[] = [];

  private constructor(opts: {
    roomId: string;
    loaded: LoadedMod;
    persistPath: string;
    seed: string;
    backend: HostBackend;
    hostJsSource: string;
    workerScript?: string;
    useWorker: boolean;
  }) {
    this.roomId = opts.roomId;
    this.checksum = opts.loaded.checksum;
    this.persistPath = opts.persistPath;
    this._seed = opts.seed;
    this.backend = opts.backend;
    this.hostJsSource = opts.hostJsSource;
    this.workerScript = opts.workerScript;
    this.useWorker = opts.useWorker;
  }

  get seed(): string {
    return this._seed;
  }

  get failed(): boolean {
    return this._failed;
  }

  static async start(opts: ModHostStartOpts): Promise<ModHost> {
    const seed = opts.seed ?? randomUUID();
    const inProcess = defaultInProcess(opts.inProcess);
    if (inProcess) {
      return new ModHost({
        roomId: opts.roomId,
        loaded: opts.loaded,
        persistPath: opts.persistPath,
        seed,
        backend: new InProcessBackend(opts.loaded.hostJsSource, seed),
        hostJsSource: opts.loaded.hostJsSource,
        workerScript: opts.workerScript,
        useWorker: false,
      });
    }
    const worker = new WorkerBackend(
      openWorkerTransport({ workerScript: opts.workerScript }),
      opts.loaded.hostJsSource,
      seed,
    );
    const host = new ModHost({
      roomId: opts.roomId,
      loaded: opts.loaded,
      persistPath: opts.persistPath,
      seed,
      backend: worker,
      hostJsSource: opts.loaded.hostJsSource,
      workerScript: opts.workerScript,
      useWorker: true,
    });
    worker.onExit(() => host.handleWorkerExit());
    try {
      await worker.init();
    } catch (err) {
      host.dispose();
      throw err instanceof Error ? err : new Error(String(err));
    }
    return host;
  }

  async views(seats: ModSeat[]): Promise<{
    seq: number;
    publicView: unknown;
    seatViews: Record<string, unknown>;
  }> {
    this.assertOpen();
    return this.backend.views(seats);
  }

  async actions(seatId: string): Promise<unknown> {
    this.assertOpen();
    return this.backend.actions(seatId);
  }

  async agentTurn(seatId: string): Promise<AgentTurn | null> {
    this.assertOpen();
    return this.backend.agentTurn(seatId);
  }

  async dispatch(
    intent: ModIntent,
    ctx: ReduceCtxIn,
  ): Promise<{ ok: true; seq: number } | { ok: false; error: string }> {
    if (this.disposed) return { ok: false, error: "disposed" };
    if (this._failed) return { ok: false, error: this.failReason || "mod host failed" };
    try {
      const result = await this.backend.reduce(intent, ctx);
      if (this.disposed) return { ok: false, error: "disposed" };
      return { ok: true, seq: result.seq };
    } catch (err) {
      if (this.disposed) return { ok: false, error: "disposed" };
      const error = err instanceof Error ? err.message : String(err);
      if (error === "disposed") return { ok: false, error: "disposed" };
      if (isLimitError(error)) {
        return { ok: false, error };
      }
      this.markFailed(error);
      return { ok: false, error };
    }
  }

  async persist(): Promise<void> {
    const state = await this.backend.persistState();
    const data: ModPersistFile = {
      checksum: this.checksum,
      seed: this._seed,
      snapshot: state.snapshot,
      log: state.log,
      seq: state.seq,
      rngState: state.rngState,
    };
    writeJsonAtomic(this.persistPath, data);
    await this.backend.compact();
  }

  async restoreFromDisk(): Promise<void> {
    this.assertOpen();
    const data = readPersist(this.persistPath);
    if (data.checksum !== this.checksum) {
      throw new Error("persist checksum mismatch");
    }
    this.replaceDeadWorker();
    await this.backend.restore({
      seed: data.seed,
      snapshot: data.snapshot,
      log: data.log,
      rngState: data.rngState,
      seq: data.seq,
    });
    this._seed = data.seed;
    this.clearFailed();
  }

  async resetToStart(_seats: ModSeat[]): Promise<void> {
    this.assertOpen();
    this.replaceDeadWorker();
    await this.backend.reset();
    this.clearFailed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.backend.dispose();
    } catch {
      // ignore
    }
  }

  onFail(cb: FailCb): void {
    this.failCbs.push(cb);
    if (this._failed) cb(this.failReason);
  }

  simulateWorkerCrash(): void {
    this.backend.simulateCrash();
  }

  private spawnWorker(): WorkerBackend {
    const worker = new WorkerBackend(
      openWorkerTransport({ workerScript: this.workerScript }),
      this.hostJsSource,
      this._seed,
    );
    worker.onExit(() => this.handleWorkerExit());
    return worker;
  }

  private replaceDeadWorker(): void {
    if (!this.useWorker || !this.backend.isDead()) return;
    try {
      this.backend.dispose();
    } catch {
      // ignore
    }
    this.backend = this.spawnWorker();
  }

  private handleWorkerExit(): void {
    if (this.disposed) return;
    this.markFailed("mod worker exited");
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("mod host disposed");
  }

  private clearFailed(): void {
    this._failed = false;
    this.failReason = "";
  }

  private markFailed(err: string): void {
    if (this.disposed || this._failed) return;
    this._failed = true;
    this.failReason = err;
    for (const cb of this.failCbs) {
      try {
        cb(err);
      } catch {
        // ignore
      }
    }
  }
}

export const __testing = {
  simulateWorkerCrash(host: ModHost): void {
    host.simulateWorkerCrash();
  },
};
