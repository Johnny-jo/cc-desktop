'use strict';

const path = require('node:path');
const { hasBrowserAuthorization, saveBrowserAuthorization } = require('./browser-auth.cjs');
const extensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const pendingScopes = new Map();

function isConnectionPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'chrome-extension:' && url.host === extensionId &&
      url.pathname === '/connect.html' && !url.username && !url.password;
  } catch { return false; }
}

function isRawToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
}

/** Call only after the user-approved extension handshake has succeeded. */
async function persistConnectionAuthorization(context, storePath, browser, profileName, options = {}) {
  if (storePath === undefined || storePath === null || storePath === '') return false;
  try {
    // This also validates the path/browser/profile before inspecting any browser page.
    if (hasBrowserAuthorization(storePath, browser, profileName)) return false;
    const absolute = path.resolve(storePath);
    const identity = `${process.platform === 'win32' ? absolute.toLowerCase() : absolute}:${browser}:${profileName.toLowerCase()}`;
    const previous = pendingScopes.get(identity) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      if (hasBrowserAuthorization(storePath, browser, profileName)) return false;
      for (const page of context.pages()) {
        if (!isConnectionPage(page.url())) continue;
        const result = await page.evaluate(({ extensionId }) => {
          if (location.protocol !== 'chrome-extension:' || location.host !== extensionId || location.pathname !== '/connect.html') return { source: false };
          const current = new URL(location.href);
          if (current.username || current.password) return { source: false };
          return { source: true, token: localStorage.getItem('auth-token') };
        }, { extensionId });
        if (!result || result.source !== true) continue;
        if (!isRawToken(result.token)) throw new Error();
        // A manual configuration may have arrived while page evaluation was in flight.
        if (hasBrowserAuthorization(storePath, browser, profileName)) return false;
        await saveBrowserAuthorization(storePath, browser, profileName, result.token, { protect: options.protect });
        return true;
      }
      return false;
    });
    pendingScopes.set(identity, pending);
    try { return await pending; }
    finally { if (pendingScopes.get(identity) === pending) pendingScopes.delete(identity); }
  } catch {
    // Neither provider errors nor page-evaluation errors may disclose authorization material.
    throw new Error('未能自动保存浏览器连接授权。当前连接可继续使用；请在设置中手动保存授权后重试。');
  }
}

module.exports = { persistConnectionAuthorization };
