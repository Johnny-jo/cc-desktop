'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const writes = new Map();
const fields = ['browser', 'profileName', 'ciphertext', 'updatedAt'];

function selection(storePath, browser, profileName) {
  if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) throw new Error('授权存储路径必须为绝对路径。');
  if (!['msedge', 'chrome'].includes(browser)) throw new Error('浏览器授权仅支持 Microsoft Edge 和 Google Chrome。');
  if (typeof profileName !== 'string' || !profileName || profileName.length > 80 ||
      profileName === '.' || profileName === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(profileName)) {
    throw new Error('浏览器授权配置目录无效，请选择 Default 或 Profile 2 等安全目录名称。');
  }
  return `${browser}:${profileName.toLowerCase()}`;
}

function normalizeToken(value) {
  if (typeof value !== 'string') throw new Error('浏览器授权令牌格式无效，请从官方扩展连接页重新复制。');
  let token = value.trim();
  if (token.startsWith('PLAYWRIGHT_MCP_EXTENSION_TOKEN=')) token = token.slice('PLAYWRIGHT_MCP_EXTENSION_TOKEN='.length).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').length !== 32 || Buffer.from(token, 'base64url').toString('base64url') !== token) {
    throw new Error('浏览器授权令牌格式无效，请从官方扩展连接页重新复制。');
  }
  return token;
}

function isCiphertext(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 65536 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value;
}

function readStore(storePath) {
  try {
    if (fs.statSync(storePath).size > 1024 * 1024) throw new Error();
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!store || store.version !== 1 || Object.keys(store).some((key) => !['version', 'entries'].includes(key)) ||
        !store.entries || typeof store.entries !== 'object' || Array.isArray(store.entries)) throw new Error();
    for (const [key, entry] of Object.entries(store.entries)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          Object.keys(entry).length !== fields.length || Object.keys(entry).some((field) => !fields.includes(field)) ||
          key !== selection(storePath, entry.browser, entry.profileName) || !isCiphertext(entry.ciphertext) ||
          typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error();
    }
    return store;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: {} };
    throw new Error('浏览器授权文件损坏或无法读取，请在应用数据目录备份并移除此文件后重新配置。');
  }
}

function storeIdentity(storePath) {
  const absolute = path.resolve(storePath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

async function serialize(storePath, operation) {
  const key = storeIdentity(storePath);
  const previous = writes.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  writes.set(key, pending);
  try { return await pending; }
  finally { if (writes.get(key) === pending) writes.delete(key); }
}

async function replaceStore(storePath, store) {
  const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await fs.promises.chmod(path.dirname(storePath), 0o700);
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(store), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporary, storePath);
  } catch {
    throw new Error('无法安全保存浏览器授权，请检查应用数据目录权限后重试。');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function dpapi(value, protect, options) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('浏览器授权需要 Windows 当前用户加密，当前平台无法安全保存。');
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('浏览器授权加密超时设置无效。');
  const env = options.env ?? process.env;
  const executable = path.join(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Secrets are supplied exclusively on stdin; these two scripts contain no caller data.
  const script = `$ErrorActionPreference='Stop';
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
try {
  Add-Type -AssemblyName System.Security;
  $entropy=[Text.Encoding]::UTF8.GetBytes('AgentOS.Playwright.ExtensionToken.v1');
  $inputData=[Console]::In.ReadToEnd();
  ${protect
    ? "$bytes=[Text.Encoding]::UTF8.GetBytes($inputData);$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Convert]::ToBase64String($result))"
    : "$bytes=[Convert]::FromBase64String($inputData);$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Text.Encoding]::UTF8.GetString($result))"}
} catch {[Console]::Error.Write('Browser authorization encryption failed.');exit 1}`;
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let output = Buffer.alloc(0);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const failure = () => {
      if (settled) return;
      finish(new Error('Windows 浏览器授权加密操作失败，请用当前用户重新配置授权。'));
      try { child?.kill(); } catch { /* The owned provider may already have exited. */ }
    };
    try {
      child = (options.spawn ?? spawn)(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('error', failure);
      child.stdin.on('error', failure);
      child.stdout.on('error', failure);
      child.stderr.on('error', failure);
      child.stderr.on('data', () => {}); // Drain without retaining or exposing provider error details.
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        output = Buffer.concat([output, Buffer.from(chunk)]);
        if (output.length > 65536) failure();
      });
      child.once('close', (code) => code === 0 ? finish(null, output.toString('utf8').trim()) : failure());
      timer = setTimeout(() => { finish(new Error('Windows 浏览器授权加密操作超时，请重试。')); child.kill(); }, timeoutMs);
      child.stdin.end(value, 'utf8');
    } catch { failure(); }
  });
}

async function saveBrowserAuthorization(storePath, channel, profileName, token, options = {}) {
  const key = selection(storePath, channel, profileName);
  const normalized = normalizeToken(token);
  return serialize(storePath, async () => {
    const store = readStore(storePath);
    let ciphertext;
    try { ciphertext = await (options.protect ? options.protect(normalized) : dpapi(normalized, true, options)); }
    catch { throw new Error('无法加密浏览器授权，请确认 Windows 当前用户加密可用后重新配置。'); }
    if (!isCiphertext(ciphertext)) throw new Error('浏览器授权加密结果无效，未保存授权。');
    store.entries[key] = { browser: channel, profileName, ciphertext, updatedAt: new Date().toISOString() };
    await replaceStore(storePath, store);
    return { configured: true };
  });
}

async function loadBrowserAuthorization(storePath, channel, profileName, options = {}) {
  const key = selection(storePath, channel, profileName);
  await writes.get(storeIdentity(storePath))?.catch(() => {});
  const entry = readStore(storePath).entries[key];
  if (!entry) return undefined;
  try {
    const token = await (options.unprotect ? options.unprotect(entry.ciphertext) : dpapi(entry.ciphertext, false, options));
    return normalizeToken(token);
  } catch { throw new Error('无法解密浏览器授权，请用当前 Windows 用户重新配置该浏览器授权。'); }
}

async function removeBrowserAuthorization(storePath, channel, profileName) {
  const key = selection(storePath, channel, profileName);
  return serialize(storePath, async () => {
    const store = readStore(storePath);
    if (!Object.hasOwn(store.entries, key)) return;
    delete store.entries[key];
    await replaceStore(storePath, store);
  });
}

function hasBrowserAuthorization(storePath, channel, profileName) {
  const key = selection(storePath, channel, profileName);
  return Object.hasOwn(readStore(storePath).entries, key);
}

module.exports = { saveBrowserAuthorization, loadBrowserAuthorization, removeBrowserAuthorization, hasBrowserAuthorization };
