import { randomUUID } from "node:crypto";
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

type UtilityChild = {
  on: (event: "message" | "exit", cb: (...args: unknown[]) => void) => void;
  postMessage: (msg: unknown) => void;
  kill: () => void;
};

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

export class ModHost {
  readonly checksum: string;
  readonly roomId: string;
  private _seed: string;
  private _failed = false;
  private failReason = "";
  private disposed = false;
  private readonly persistPath: string;
  private readonly hostJsSource: string;
  private runtime: ModRuntime;
  private readonly failCbs: FailCb[] = [];
  private child: UtilityChild | null = null;

  private constructor(opts: {
    roomId: string;
    loaded: LoadedMod;
    persistPath: string;
    seed: string;
    runtime: ModRuntime;
    child: UtilityChild | null;
  }) {
    this.roomId = opts.roomId;
    this.checksum = opts.loaded.checksum;
    this.persistPath = opts.persistPath;
    this.hostJsSource = opts.loaded.hostJsSource;
    this._seed = opts.seed;
    this.runtime = opts.runtime;
    this.child = opts.child;
    if (this.child) {
      this.child.on("exit", () => {
        this.markFailed("mod worker exited");
      });
    }
  }

  get seed(): string {
    return this._seed;
  }

  get failed(): boolean {
    return this._failed;
  }

  static async start(opts: ModHostStartOpts): Promise<ModHost> {
    const seed = opts.seed ?? randomUUID();
    const runtime = createModRuntime(opts.loaded.hostJsSource, seed);
    let child: UtilityChild | null = null;
    const inProcess = defaultInProcess(opts.inProcess);
    if (!inProcess) {
      const utility = tryUtilityProcess();
      const script = opts.workerScript ?? defaultWorkerScript();
      if (utility && fs.existsSync(script)) {
        try {
          child = utility.fork(script);
        } catch {
          child = null;
        }
      }
    }
    const host = new ModHost({
      roomId: opts.roomId,
      loaded: opts.loaded,
      persistPath: opts.persistPath,
      seed,
      runtime,
      child,
    });
    if (child) {
      try {
        child.postMessage({
          type: "init",
          hostJsSource: opts.loaded.hostJsSource,
          seed,
        });
      } catch {
        host.markFailed("mod worker init failed");
      }
    }
    return host;
  }

  views(seats: ModSeat[]): {
    seq: number;
    publicView: unknown;
    seatViews: Record<string, unknown>;
  } {
    this.assertOpen();
    return this.runtime.views(seats);
  }

  actions(seatId: string): unknown {
    this.assertOpen();
    return this.runtime.actions(seatId);
  }

  agentTurn(seatId: string): AgentTurn | null {
    this.assertOpen();
    return this.runtime.agentTurn(seatId);
  }

  async dispatch(
    intent: ModIntent,
    ctx: ReduceCtxIn,
  ): Promise<{ ok: true; seq: number } | { ok: false; error: string }> {
    if (this.disposed) return { ok: false, error: "disposed" };
    if (this._failed) return { ok: false, error: this.failReason || "mod host failed" };
    try {
      const result = this.runtime.reduce(intent, ctx);
      return { ok: true, seq: result.seq };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (/exceeds|JSON|depth|bytes/i.test(error)) {
        return { ok: false, error };
      }
      this.markFailed(error);
      return { ok: false, error };
    }
  }

  persist(): void {
    const state = this.runtime.persistState();
    const data: ModPersistFile = {
      checksum: this.checksum,
      seed: this._seed,
      snapshot: state.snapshot,
      log: state.log,
      seq: state.seq,
      rngState: state.rngState,
    };
    writeJsonAtomic(this.persistPath, data);
    this.runtime.compact();
  }

  async restoreFromDisk(): Promise<void> {
    this.assertOpen();
    const data = readPersist(this.persistPath);
    if (data.checksum !== this.checksum) {
      throw new Error("persist checksum mismatch");
    }
    this._seed = data.seed;
    this.runtime = createModRuntime(this.hostJsSource, data.seed, {
      snapshot: data.snapshot,
      log: data.log,
      rngState: data.rngState,
      seq: data.seq,
    });
    if (this.child) {
      try {
        this.child.postMessage({
          type: "init",
          hostJsSource: this.hostJsSource,
          seed: data.seed,
          snapshot: data.snapshot,
          log: data.log,
          rngState: data.rngState,
          seq: data.seq,
        });
      } catch {
        this.markFailed("mod worker restore failed");
      }
    }
  }

  async resetToStart(_seats: ModSeat[]): Promise<void> {
    this.assertOpen();
    this.runtime = createModRuntime(this.hostJsSource, this._seed);
    if (this.child) {
      try {
        this.child.postMessage({
          type: "init",
          hostJsSource: this.hostJsSource,
          seed: this._seed,
        });
      } catch {
        this.markFailed("mod worker reset failed");
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.child?.kill();
    } catch {
      // ignore
    }
    this.child = null;
  }

  onFail(cb: FailCb): void {
    this.failCbs.push(cb);
    if (this._failed) cb(this.failReason);
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("mod host disposed");
  }

  private markFailed(err: string): void {
    if (this._failed) return;
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
