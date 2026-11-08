const { createInterface } = require("node:readline");

// Each stream belongs to one helper. Once an action's outcome is uncertain,
// discard that stream before accepting another request.
function nativeConnection(spawnWorker, timeoutMs = 15000, { idleMs, onRevoke, onExit } = {}) {
  let current;
  let revoked = false;
  function retire(state, reason) {
    if (current === state) current = undefined;
    clearTimeout(state.idleTimer);
    state.pending?.reject(reason);
    state.child.kill();
  }
  function open() {
    const child = spawnWorker();
    const state = { child, pending: undefined };
    current = state;
    const failed = error => retire(state, error);
    child.once("error", failed);
    child.stdin.on("error", failed);
    child.once("exit", code => {
      clearTimeout(state.idleTimer);
      const reason = new Error(code === 42 ? "Desktop control stopped by the user. Reconnect to resume." : "Windows helper exited. Observe the window again before retrying.");
      if (code === 42) {
        revoked = true;
        onRevoke?.();
        if (current && current !== state) retire(current, reason);
      }
      if (current === state) current = undefined;
      state.pending?.reject(reason);
      onExit?.(code);
    });
    createInterface({ input: child.stdout }).on("line", line => {
      if (current !== state || !state.pending) return;
      try {
        const result = JSON.parse(line);
        if (result.error) state.pending.reject(Object.assign(new Error(result.error), {code:result.errorCode}));
        else state.pending.resolve(result.value);
      } catch (error) { failed(error); }
    });
    return state;
  }
  return {
    async request(operation, args, signal, deadlineMs = timeoutMs) {
      if (revoked) throw new Error("Desktop control was stopped by the user. Reconnect to resume.");
      if (current?.pending) throw new Error("Another desktop action is running; wait for its result.");
      if (signal.aborted) throw new Error("Request cancelled.");
      const state = current ?? open();
      clearTimeout(state.idleTimer);
      const abort = () => retire(state, new Error("Windows action interrupted. Inspect the resulting state before retrying."));
      const timer = setTimeout(abort, deadlineMs);
      try {
        return await new Promise((resolve, reject) => {
          state.pending = { resolve, reject };
          signal.addEventListener("abort", abort, { once: true });
          state.child.stdin.write(JSON.stringify({ operation, args }) + "\n");
        });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        state.pending = undefined;
        if (idleMs && current === state) {
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
