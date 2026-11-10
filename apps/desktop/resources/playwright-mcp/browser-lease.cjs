'use strict';

const net = require('node:net');
const { createHash } = require('node:crypto');

const busyMessage = 'This browser is already controlled by another AgentOS connection. Release that connection before trying again.';

async function acquireBrowserLease(resource) {
  if (!resource) return { release: async () => {} };
  const hash = createHash('sha256').update(resource).digest('hex');
  const server = net.createServer(socket => socket.destroy());
  // An OS handle is released even after a crash or forced process exit. Never
  // expire a live owner's lease based on a timestamp or a pid file.
  const address = process.platform === 'win32'
    ? { path: `\\\\.\\pipe\\agentos-browser-${hash}`, exclusive: true }
    : { host: '127.0.0.1', port: 20000 + (parseInt(hash.slice(0, 8), 16) % 40000), exclusive: true };
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error(busyMessage)));
    server.listen(address, resolve);
  });
  let releasing;
  return {
    release() {
      releasing ??= new Promise(resolve => server.close(() => resolve()));
      return releasing;
    },
  };
}

module.exports = { acquireBrowserLease };
