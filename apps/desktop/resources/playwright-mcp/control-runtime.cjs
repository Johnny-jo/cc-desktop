'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function withTimeout(action, timeoutMs = 250) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => action?.()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser observation timed out.')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// The endpoint path/query may carry a token or a transient browser id. The
// listening browser, not that token, is the resource whose input we serialize.
function browserResource({ connection, cdpEndpoint, profileDirectory }) {
  if (connection === 'isolated') return undefined;
  if (connection === 'extension') {
    const directory = fs.realpathSync.native(profileDirectory);
    return `profile:${process.platform === 'win32' ? directory.toLowerCase() : path.resolve(directory)}`;
  }
  let endpoint;
  if (typeof cdpEndpoint !== 'string' || !cdpEndpoint.trim() || cdpEndpoint.length > 2048 || /[\u0000-\u001f\u007f]/.test(cdpEndpoint)) {
    throw new Error('Invalid CDP endpoint.');
  }
  try { endpoint = new URL(cdpEndpoint); } catch { throw new Error('Invalid CDP endpoint.'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Invalid CDP endpoint. Use HTTP(S) or WS(S) without credentials, query parameters or fragments.');
  }
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase()) ? 'loopback' : endpoint.hostname.toLowerCase();
  const port = endpoint.port || (['https:', 'wss:'].includes(endpoint.protocol) ? '443' : '80');
  return `cdp:${host}:${port}`;
}

function createCallQueue(message) {
  let tail = Promise.resolve();
  let revoked = false;
  const check = signal => {
    if (revoked) throw new Error(message);
    if (signal?.aborted) throw new Error('Browser tool call cancelled.');
  };
  return {
    revoke() { revoked = true; },
    check,
    run(task, signal) {
      const result = tail.then(async () => {
        check(signal);
        const value = await task();
        check(signal);
        return value;
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}

// All references belong to this one backend. A late dispose cannot close a
// replacement backend created by the MCP backend manager.
function createOwnership(state) {
  let releasing;
  const safely = async action => { try { await action?.(); } catch { /* Continue all cleanup paths. */ } };
  return {
    release() {
      releasing ??= (async () => {
        try {
          await safely(() => withTimeout(state.beforeRelease));
          await safely(() => state.driver?.close());
          if (!state.attached) await safely(() => state.context?.close());
          await safely(() => state.browser?.unbind());
          // Playwright's attached Browser.close disconnects its CDP/extension
          // client. Never call context.close or page.close for attached owners.
          await safely(() => state.browser?.close());
        } finally {
          await safely(state.releaseLease);
        }
      })();
      return releasing;
    },
  };
}

module.exports = { browserResource, createCallQueue, createOwnership, withTimeout };
