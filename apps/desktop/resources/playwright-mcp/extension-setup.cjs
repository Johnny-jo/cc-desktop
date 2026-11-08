'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { resolveBrowserProfile } = require('./browser-data.cjs');

const extensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const updateUrl = 'https://clients2.google.com/service/update2/crx';
const inFlight = new Map();
const launched = new Set();

function context(channel, profileName, options) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('自动准备浏览器扩展目前仅支持 Windows。');
  const env = options.env ?? process.env;
  const localAppData = options.localAppData ?? env.LOCALAPPDATA;
  const profile = resolveBrowserProfile(channel, { profileName: profileName === '' ? undefined : profileName, localAppData });
  return {
    channel, profile, env, localAppData,
    key: `HKCU\\Software\\${channel === 'msedge' ? 'Microsoft\\Edge' : 'Google\\Chrome'}\\Extensions\\${extensionId}`,
    regExe: path.join(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows', 'System32', 'reg.exe'),
    execFile: options.execFile ?? childProcess.execFile,
    spawn: options.spawn ?? childProcess.spawn,
  };
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw new Error(`无法读取浏览器扩展状态，请确认当前 Windows 用户能访问所选配置：${error.message}`, { cause: error });
  }
}

function installation(profile) {
  let record;
  for (const filename of ['Preferences', 'Secure Preferences']) {
    const candidate = readJson(path.join(profile.directory, filename))?.extensions?.settings?.[extensionId];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) record = candidate;
  }
  const directory = path.join(profile.directory, 'Extensions', extensionId);
  let manifest = false;
  try {
    manifest = fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      const value = readJson(path.join(directory, entry.name, 'manifest.json'));
      return value && typeof value.name === 'string' && typeof value.version === 'string' && Number.isInteger(value.manifest_version);
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const reasons = record?.disable_reasons;
  // Modern Chromium removed state; enablement now follows disable reasons and malware blocklists.
  const hasRecord = record && Object.keys(record).length > 0;
  const legacyEnabled = record?.state === undefined || record.state === 1;
  const blocklisted = record?.blacklist === true || record?.blacklist_state === 1 ||
    (Number.isInteger(record?.omaha_blocklist_state) && (record.omaha_blocklist_state & 1) !== 0) ||
    record?.extension_telemetry_service_blocklist_state === 1;
  const enabled = hasRecord && legacyEnabled && !blocklisted &&
    (reasons == null || reasons === 0 || (Array.isArray(reasons) && reasons.length === 0));
  if (manifest && enabled) return { state: 'ready', message: '官方 Playwright 扩展已安装并启用，可以连接日常浏览器。' };
  if (manifest && blocklisted) return { state: 'pending-enable', message: '官方扩展被浏览器安全检查阻止。请查看浏览器扩展页的说明，然后重新检测。' };
  const reasonValues = Array.isArray(reasons) ? reasons : [reasons];
  if (manifest && reasonValues.some(value => Number.isInteger(value) && (value & 8192) !== 0)) {
    const browser = profile.channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
    return { state: 'pending-enable', message: `${browser} 已安装官方扩展，正在等待首次启用确认。请在扩展页对“Playwright Extension”点击“启用”或打开开关，确认权限后再重新连接。` };
  }
  if (manifest) return { state: 'pending-enable', message: '官方 Playwright 扩展尚未启用。请在已打开的浏览器扩展页确认安装并启用，然后重新检测。' };
  return { state: 'pending-download', message: '官方 Playwright 扩展的安装文件尚未就绪。' };
}

function command(ctx, args, executable = ctx.regExe) {
  return new Promise((resolve, reject) => {
    // Decode reg.exe's localized errors without losing Windows OEM characters.
    const decode = (value) => {
      if (!Buffer.isBuffer(value)) return String(value ?? '');
      const utf8 = value.toString('utf8');
      return utf8.includes('\ufffd') ? new TextDecoder('gb18030').decode(value) : utf8;
    };
    ctx.execFile(executable, args, { windowsHide: true, encoding: 'buffer' }, (error, stdout, stderr) => {
      const output = { stdout: decode(stdout), stderr: decode(stderr) };
      if (error) reject(Object.assign(new Error(`无法${args[0] === 'add' ? '登记' : '读取'}官方浏览器扩展：${output.stderr || error.message}`, { cause: error }), { code: error.code, ...output }));
      else resolve(output);
    });
  });
}

async function structuredRegistration(ctx) {
  // Both possible subkeys are fixed by the validated browser channel, never caller commands.
  const subkey = ctx.key.slice('HKCU\\'.length);
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
try {
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${subkey}',$false);
  if($null -eq $key){[Console]::Write('{"exists":false}');exit 0};
  try {
    if($key.GetValueNames() -notcontains 'update_url'){[Console]::Write('{"exists":false}')}
    else {$result=@{exists=$true;kind=$key.GetValueKind('update_url').ToString();value=$key.GetValue('update_url',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)};[Console]::Write(($result|ConvertTo-Json -Compress))}
  } finally {$key.Dispose()}
} catch {[Console]::Error.Write($_.Exception.Message);exit 2}`;
  const executable = path.join(path.dirname(ctx.regExe), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = await command(ctx, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], executable);
  let result;
  try { result = JSON.parse(output.stdout.replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error('无法读取浏览器扩展登记：注册表返回了无法识别的状态。', { cause: error }); }
  if (result?.exists === false) return false;
  if (result?.exists === true && result.kind === 'String' && result.value === updateUrl) return true;
  throw new Error('无法读取官方扩展注册表登记，或现有登记与预期不同；未覆盖原值。');
}

async function registered(ctx) {
  let output;
  try { output = await command(ctx, ['query', ctx.key, '/v', 'update_url']); }
  catch (error) {
    if (error.code === 1 && /unable to find|cannot find|not found|找不到.*(?:注册表|项|值)/i.test(error.stderr)) return false;
    if (error.code === 1) return structuredRegistration(ctx);
    throw error;
  }
  const value = output.stdout.match(/^\s*update_url\s+REG_SZ\s+([^\r\n]+?)\s*$/im)?.[1];
  if (value !== updateUrl) throw new Error('官方扩展的现有注册表登记与预期不同，未覆盖原值。请检查浏览器扩展登记后重试。');
  return true;
}

async function status(ctx, registeredHint = false) {
  const current = installation(ctx.profile);
  // A working manual install does not depend on external-install registry permissions.
  if (current.state === 'ready') return { browser: ctx.channel, profileName: ctx.profile.profileName, ...current, registered: registeredHint };
  const isRegistered = await registered(ctx);
  if (current.state === 'pending-download') {
    current.message = isRegistered
      ? '官方扩展自动安装已登记，等待浏览器处理并下载。若浏览器已经运行，可能需要保存工作后完整退出并重启浏览器，再重新检测。'
      : '官方 Playwright 扩展尚未安装就绪，也未登记自动安装。请选择自动准备。';
  }
  return { browser: ctx.channel, profileName: ctx.profile.profileName, ...current, registered: isRegistered };
}

/** Read-only: inspect the selected profile and current-user extension registration. */
async function getBrowserExtensionStatus(channel, profileName, options = {}) {
  return status(context(channel, profileName, options));
}

function browserExecutable(ctx) {
  const components = ctx.channel === 'msedge' ? ['Microsoft', 'Edge'] : ['Google', 'Chrome'];
  const roots = [ctx.env['ProgramFiles(x86)'], ctx.env.ProgramFiles, ctx.localAppData].filter(Boolean);
  for (const root of roots) {
    const filename = path.join(root, ...components, 'Application', `${ctx.channel === 'msedge' ? 'msedge' : 'chrome'}.exe`);
    try { if (fs.statSync(filename).isFile()) return filename; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`未找到已安装的 ${ctx.channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'} 浏览器。请先安装并打开所选浏览器，再重试自动准备。`);
}

function launch(ctx, executable) {
  return new Promise((resolve, reject) => {
    const url = `${ctx.channel === 'msedge' ? 'edge' : 'chrome'}://extensions/?id=${extensionId}`;
    // This is an interactive browser confirmation page, so it must be visible.
    const child = ctx.spawn(executable, [`--profile-directory=${ctx.profile.profileName}`, url], { windowsHide: false, stdio: 'ignore' });
    child.once('error', (error) => reject(new Error(`无法启动浏览器扩展确认页：${error.message}`, { cause: error })));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** Register only this official extension, then let the browser enforce user confirmation. */
async function prepareBrowserExtension(channel, profileName, options = {}) {
  const ctx = context(channel, profileName, options);
  const identity = `${channel}:${ctx.profile.directory}`;
  if (inFlight.has(identity)) return inFlight.get(identity);
  const work = (async () => {
    const before = await status(ctx);
    if (before.state === 'ready') return before;
    const executable = browserExecutable(ctx); // Never write registration when the browser is absent.
    if (!before.registered) await command(ctx, ['add', ctx.key, '/v', 'update_url', '/t', 'REG_SZ', '/d', updateUrl, '/f']);
    if (!launched.has(identity)) {
      await launch(ctx, executable);
      launched.add(identity);
    }
    return status(ctx, true); // Re-read immediately; registration alone is never readiness.
  })();
  inFlight.set(identity, work);
  try { return await work; }
  finally { inFlight.delete(identity); }
}

module.exports = { getBrowserExtensionStatus, prepareBrowserExtension };
