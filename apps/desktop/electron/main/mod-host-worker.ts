import {
  createModRuntime,
  type ModIntent,
  type ModRuntime,
  type ModSeat,
  type PersistLogEntry,
} from "./mod-game";

export type WorkerState = {
  runtime: ModRuntime | null;
};

export type WorkerRequest =
  | {
      id?: number;
      type: "init";
      hostJsSource: string;
      seed: string;
      snapshot?: unknown;
      log?: unknown[];
      rngState?: number;
      seq?: number;
    }
  | {
      id?: number;
      type: "reduce";
      intent: ModIntent;
      ctx: {
        now: number;
        seats: ModSeat[];
        actor: { userId: string; seatId: string };
      };
    }
  | { id?: number; type: "views"; seats: ModSeat[] }
  | {
      id?: number;
      type: "query";
      method: "actions" | "agentTurn" | "public" | "seat";
      seatId?: string;
      seats?: ModSeat[];
    };

export type WorkerReply = {
  id?: number;
  ok: boolean;
  error?: string;
  seq?: number;
  snapshot?: unknown;
  rngState?: number;
  publicView?: unknown;
  seatViews?: Record<string, unknown>;
  result?: unknown;
};

export function createWorkerState(): WorkerState {
  return { runtime: null };
}

export function handleWorkerMessage(
  state: WorkerState,
  msg: unknown,
): WorkerReply {
  if (!msg || typeof msg !== "object") {
    return { ok: false, error: "invalid message" };
  }
  const req = msg as WorkerRequest;
  const id = req.id;
  try {
    if (req.type === "init") {
      state.runtime = createModRuntime(req.hostJsSource, req.seed, {
        snapshot: req.snapshot,
        log: req.log,
        rngState: req.rngState,
        seq: req.seq,
      });
      return { id, ok: true, seq: state.runtime.seq() };
    }
    const runtime = state.runtime;
    if (!runtime) return { id, ok: false, error: "not initialized" };
    if (req.type === "reduce") {
      const result = runtime.reduce(req.intent, req.ctx);
      return {
        id,
        ok: true,
        seq: result.seq,
        snapshot: runtime.getSnapshot(),
        rngState: runtime.getRngState(),
      };
    }
    if (req.type === "views") {
      const views = runtime.views(req.seats);
      return {
        id,
        ok: true,
        seq: views.seq,
        publicView: views.publicView,
        seatViews: views.seatViews,
      };
    }
    if (req.type === "query") {
      if (req.method === "actions") {
        if (!req.seatId) return { id, ok: false, error: "seatId required" };
        return { id, ok: true, result: runtime.actions(req.seatId), seq: runtime.seq() };
      }
      if (req.method === "agentTurn") {
        if (!req.seatId) return { id, ok: false, error: "seatId required" };
        return { id, ok: true, result: runtime.agentTurn(req.seatId), seq: runtime.seq() };
      }
      if (req.method === "public") {
        const views = runtime.views(req.seats ?? []);
        return { id, ok: true, result: views.publicView, seq: views.seq };
      }
      if (req.method === "seat") {
        if (!req.seatId) return { id, ok: false, error: "seatId required" };
        const views = runtime.views(
          req.seats ?? [
            {
              id: req.seatId,
              kind: "human",
              name: req.seatId,
              occupantUserId: null,
              takenOverBy: null,
              sessionId: null,
            },
          ],
        );
        return { id, ok: true, result: views.seatViews[req.seatId], seq: views.seq };
      }
      return { id, ok: false, error: "unknown query method" };
    }
    return { id, ok: false, error: "unknown message type" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { id, ok: false, error };
  }
}

type ParentPort = {
  on: (event: "message", cb: (e: { data: unknown }) => void) => void;
  postMessage: (msg: unknown) => void;
};

function attachIpc(): void {
  const state = createWorkerState();
  const proc = process as NodeJS.Process & { parentPort?: ParentPort };
  const reply = (msg: unknown) => {
    if (proc.parentPort) proc.parentPort.postMessage(msg);
    else if (typeof proc.send === "function") proc.send(msg);
  };
  const onMessage = (msg: unknown) => {
    reply(handleWorkerMessage(state, msg));
  };
  if (proc.parentPort) {
    proc.parentPort.on("message", (e) => onMessage(e.data));
    return;
  }
  proc.on("message", onMessage);
}

const isDirect =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  (process.argv[1]?.includes("mod-host-worker") ?? false);

if (isDirect) attachIpc();

export type { PersistLogEntry };
