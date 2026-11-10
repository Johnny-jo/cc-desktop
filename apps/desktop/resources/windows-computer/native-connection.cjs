const { createInterface } = require("node:readline");

// Each stream belongs to one helper. Once an action's outcome is uncertain,
// discard that stream before accepting another request.
function nativeConnection(spawnWorker, timeoutMs = 15000, { idleMs, onRevoke, onExit } = {}) {
  let current;
  let revoked = false;
  const unconfirmedRelease = () => new Error("Windows drag interrupted; mouse release is unconfirmed. Inspect the current state before retrying.");
  function abandonUnconfirmed(state) {
    revoked = true;
    state.awaitingCleanup = true;
    state.stopError = unconfirmedRelease();
    clearTimeout(state.cancelTimer);
    clearTimeout(state.idleTimer);
    state.failStop(state.stopError);
    state.pending?.reject(state.stopError);
    // Do not kill a possibly held press. EOF lets the independent native reader
    // release it and exit even while the main thread remains blocked in COM.
    try { state.child.stdin.end(); } catch {}
  }
  function retire(state, reason, force = false) {
    if (state.awaitingCleanup && !state.cancelConfirmed && !force) return;
    // A drag owns a held mouse button. The native worker must run its finally
    // before termination, including cancellation, EOF and connection disposal.
    if (state.pending?.operation === "drag" && !state.finished && !force) {
      if (!state.cancelReason) {
        state.cancelReason = reason;
        state.cancelTimer = setTimeout(() => abandonUnconfirmed(state), 2000);
        state.cancelTimer.unref();
        try { state.child.stdin.write('{"operation":"cancel_current","args":{}}\n'); } catch {}
      }
      return;
    }
    if (current === state) current = undefined;
    clearTimeout(state.idleTimer);
    state.pending?.reject(reason);
    state.child.kill();
  }
  function open() {
    const child = spawnWorker();
    let exited, failStop;
    const state = { child, pending: undefined, stopped:new Promise(resolve => { exited=resolve; }),
      stopFailure:new Promise(resolve => { failStop=resolve; }), failStop:error => failStop(error) };
    current = state;
    const failed = error => retire(state, error);
    child.once("error", error => { state.finished=true; failed(error); exited(); });
    child.stdin.on("error", failed);
    child.once("exit", code => {
      state.finished = true;
      clearTimeout(state.cancelTimer);
      if (state.cancelReason && !state.cancelConfirmed) state.stopError ??= unconfirmedRelease();
      exited();
      clearTimeout(state.idleTimer);
      const reason = new Error(code === 42 ? "Desktop control stopped by the user. Reconnect to resume." : "Windows helper exited. Observe the window again before retrying.");
      if (code === 42) {
        revoked = true;
        onRevoke?.();
        if (current && current !== state) retire(current, reason);
      }
      if (current === state) current = undefined;
      state.pending?.reject(state.stopError ?? state.cancelReason ?? reason);
      onExit?.(code);
    });
    createInterface({ input: child.stdout }).on("line", line => {
      if (current !== state || (!state.pending && !state.awaitingCleanup)) return;
      try {
        const result = JSON.parse(line);
        if (result.cancel_ack === true) {
          state.finished = true;
          if (result.pointerReleased !== true) {
            abandonUnconfirmed(state);
          } else {
            state.cancelConfirmed = true;
            retire(state,state.cancelReason ?? new Error("Windows action interrupted. Inspect the current state before retrying."),true);
          }
          return;
        }
        if (!result || typeof result !== "object" ||
            !(Object.prototype.hasOwnProperty.call(result,"value") || typeof result.error === "string"))
          throw new Error("Invalid Windows helper reply.");
        if (result.errorCode === "pointer_release_unconfirmed") { abandonUnconfirmed(state); return; }
        state.finished = true;
        if (state.cancelReason) {
          state.cancelConfirmed = true;
          retire(state,state.stopError ?? state.cancelReason); return;
        }
        if (result.error) state.pending.reject(Object.assign(new Error(result.error), {code:result.errorCode}));
        else state.pending.resolve(result.value);
      } catch (error) { failed(error); }
    });
    return state;
  }
  return {
    async request(operation, args, signal, deadlineMs = timeoutMs) {
      if (revoked) throw new Error("Desktop control was stopped by the user. Reconnect to resume.");
      if (operation === "release_control" && current?.pending?.operation === "drag") {
        const state = current;
        retire(state,new Error("Windows action interrupted. Inspect the resulting state before retrying."));
        const failure = await Promise.race([state.stopped.then(() => state.stopError),state.stopFailure]);
        if (failure) throw failure;
        return {released:true};
      }
      if (current?.pending) throw new Error("Another desktop action is running; wait for its result.");
      if (signal.aborted) throw new Error("Request cancelled.");
      const state = current ?? open();
      state.finished = false;
      clearTimeout(state.idleTimer);
      const abort = () => retire(state, new Error("Windows action interrupted. Inspect the resulting state before retrying."));
      const timer = setTimeout(abort, deadlineMs);
      try {
        return await new Promise((resolve, reject) => {
          state.pending = { resolve, reject, operation };
          signal.addEventListener("abort", abort, { once: true });
          state.child.stdin.write(JSON.stringify({ operation, args }) + "\n");
        });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        state.pending = undefined;
        if (idleMs && current === state && !state.awaitingCleanup) {
          state.idleTimer = setTimeout(() => retire(state, new Error("Idle helper released.")), idleMs);
          state.idleTimer.unref();
        }
      }
    },
    close() {
      revoked = true;
      if (current) retire(current, new Error("Desktop connection closed."));
    },
  };
}
module.exports = { nativeConnection };
