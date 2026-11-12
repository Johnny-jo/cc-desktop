// Real stdio MCP + disposable headless Chrome; deterministic planner, no LLM.
// Host navigation/oracles are never passed to the planner or counted as model IO.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(repo, 'apps/desktop'), out = path.join(repo, '.tmp');
mkdirSync(out, { recursive: true });
const require = createRequire(path.join(desktop, 'package.json'));
const mcpRequire = createRequire(require.resolve('@playwright/mcp/package.json'));
const { chromium } = mcpRequire('playwright');
const { Client, StdioClientTransport } = mcpRequire('playwright-core/lib/utilsBundle');
const control = path.join(desktop, 'resources/playwright-mcp/control.cjs');
const sourceFiles = ['scripts/verify-browser-targets.mjs', 'apps/desktop/resources/playwright-mcp/control.cjs', 'apps/desktop/resources/playwright-mcp/browser-target-tools.cjs', 'apps/desktop/resources/playwright-mcp/browser-targets.cjs'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(f => [f, existsSync(path.join(repo, f)) ? createHash('sha256').update(readFileSync(path.join(repo, f))).digest('hex') : null]));
const textOf = result => result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
const payloadOf = result => {
  const text = textOf(result);
  for (const block of [text, ...text.split('\n')]) { try { const value = JSON.parse(block); if (value && typeof value === 'object') return value; } catch {} }
  throw new Error('No JSON payload: ' + text.slice(0, 600));
};
const jsonFile = (name, data) => writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));
const scenes = [
  { id: 'large-duplicate', region: '通知设置', query: '保存', expected: 'notification', task: '点击通知设置区域的保存。' },
  { id: 'disabled-enabled', region: '通知设置', query: '保存', expected: 'enabled', task: '点击通知设置里可用的保存；禁止点击禁用按钮。' },
  { id: 'native-modal', region: '通知设置', query: '保存', expected: null, task: '点击通知设置的保存；若模态弹窗挡住则停止，不关闭弹窗。' },
  { id: 'duplicate-regions', region: '渠道设置', query: '保存', nearby: '邮件提醒', expected: 'email', task: '两个渠道设置区域中，点击邮件提醒旁边的保存。' },
  { id: 'dom-replacement', region: '通知设置', query: '保存', expected: 'replacement', mutate: true, task: '点击通知设置的保存；若引用失效则重新查找。' },
  { id: 'missing-target', region: '通知设置', query: '发布', expected: null, task: '查找通知设置的发布按钮；没有可靠目标则查看整页并停止。' },
];
const button = (id, disabled = false) => `<button data-key="${id}" ${disabled ? 'disabled' : ''} onclick="hit('${id}')">保存</button>`;
const region = (name, content) => `<section role="region" aria-label="${name}">${content}</section>`;
function fixtureHtml(id) {
  let content;
  if (id === 'disabled-enabled') content = region('通知设置', button('disabled', true) + button('enabled'));
  else if (id === 'duplicate-regions') content = region('渠道设置', '<p>短信提醒</p>' + button('sms')) + region('渠道设置', '<p>邮件提醒</p>' + button('email'));
  else content = region('个人设置', '<p>账户资料</p>' + button('profile')) + region('通知设置', '<p>通知偏好</p>' + button('notification'));
  return `<!doctype html><meta charset="utf-8"><title>Target discovery fixture</title>
    <style>body{font:16px sans-serif}section{display:inline-block;vertical-align:top;padding:12px;margin:8px;border:1px solid #aaa}button{padding:12px}dialog{padding:32px}</style>
    <h1>设置中心</h1>${content}<p role="status" id="result">尚未保存</p>
    ${Array.from({ length: 240 }, (_, i) => `<article aria-label="帮助主题 ${i}"><h2>帮助主题 ${i}</h2><p>这是独立背景说明 ${i}，用于验证大页面定位成本，包含账户资料、通知设置说明和常见问题。</p><a href="#help-${i}">阅读帮助 ${i}</a></article>`).join('')}
    <dialog aria-label="确认提示"><p>请先处理当前模态弹窗。</p><button>知道了</button></dialog>
    <script>window.hits={};function hit(key){window.hits[key]=(window.hits[key]||0)+1;document.querySelector('#result').textContent='已保存 '+key;}
    window.replaceTarget=()=>{const old=document.querySelector('[data-key="notification"]');old.outerHTML=${JSON.stringify(button('replacement'))};};
    ${id === 'native-modal' ? "document.querySelector('dialog').showModal();" : ''}</script>`;
}

// Parse only actual native ARIA lines. DOM IDs/expected keys never choose refs.
function nativeCandidates(text, scene) {
  const rows = text.split('\n').map((line, index) => ({ line, index, indent: line.search(/\S/) }));
  const found = [];
  for (const row of rows) {
    const match = row.line.match(/- button "([^"]*)".*?\[ref=([^\]]+)\]/);
    if (!match || !match[1].includes(scene.query) || row.line.includes('[disabled]')) continue;
    const parent = rows.slice(0, row.index).reverse().find(r => r.indent < row.indent && /- (region|form|dialog) /.test(r.line));
    if (!parent || !parent.line.includes(`"${scene.region}"`)) continue;
    const end = rows.findIndex(r => r.index > parent.index && r.indent <= parent.indent && /^\s*- /.test(r.line));
    const subtree = rows.slice(parent.index, end < 0 ? undefined : end).map(r => r.line).join('\n');
    if (scene.nearby && !subtree.includes(scene.nearby)) continue;
    found.push({ ref: match[2], name: match[1] });
  }
  return [...new Map(found.map(c => [c.ref, c])).values()];
}
function baselineSchemas(current) {
  const saved = path.join(out, 'browser-target-native-tools.json');
  if (existsSync(saved)) return { source: 'actual pre-change stdio listTools captured during red phase', tools: JSON.parse(readFileSync(saved, 'utf8')) };
  const copied = structuredClone(current).filter(t => t.name !== 'browser_expand_region');
  for (const t of copied) {
    if (t.inputSchema?.properties) for (const key of ['observationId', ...(t.name === 'browser_find' ? ['query', 'role', 'region'] : [])]) delete t.inputSchema.properties[key];
    if (t.name === 'browser_find') t.description = 'Search the accessibility snapshot of the current page for text or a regular expression. Returns matching snapshot nodes with a few lines of surrounding context (like search snippets), each shown under its path from the root of the tree, which is cheaper than capturing the whole snapshot when you only need to locate an element and its ref.';
  }
  return { source: 'current listTools minus added tool and optional fields; description approximation', tools: copied };
}
class Replay {
  constructor(client, schemas, scene, strategy, token) {
    Object.assign(this, { client, schemas, scene, strategy, token });
    this.messages = [{ role: 'user', content: scene.task }]; this.requests = []; this.calls = [];
    this.toolPayloadTokens = 0; this.outputProxyTokens = 0; this.started = performance.now();
  }
  request() {
    const request = { model: 'deterministic-planner-proxy-not-an-LLM', max_tokens: 1024,
      system: '操作已打开的当前页面。仅根据工具可见结果选取原生 ref。结果必须验证；无可靠目标时回退整页快照。',
      tools: this.schemas.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })), messages: structuredClone(this.messages) };
    this.requests.push({ request, tokens: this.token(JSON.stringify(request)) });
  }
  async call(name, input = {}) {
    this.request();
    const use = { type: 'tool_use', id: `call_${this.calls.length + 1}`, name, input };
    this.messages.push({ role: 'assistant', content: [use] }); this.outputProxyTokens += this.token(JSON.stringify(use));
    const started = performance.now(); let result;
    try { result = await this.client.callTool({ name, arguments: input }); }
    catch (error) { result = { isError: true, content: [{ type: 'text', text: String(error) }] }; }
    assert.ok(!result.content?.some(b => b.type === 'image'), 'Do not count image base64 as vision tokens');
    this.toolPayloadTokens += this.token(JSON.stringify({ name, input, result }));
    this.calls.push({ name, input, result, durationMs: Math.round(performance.now() - started) });
    this.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, is_error: !!result.isError, content: textOf(result) }] });
    return result;
  }
  finish(conclusion) {
    this.request(); // Include final reasoning request with full history/schema.
    this.outputProxyTokens += this.token(JSON.stringify({ role: 'assistant', content: conclusion }));
    const toolDefinitionTokens = this.token(JSON.stringify(this.schemas.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))));
    const fullRequestProxyTokens = this.requests.reduce((sum, r) => sum + r.tokens, 0);
    return { strategy: this.strategy, scene: this.scene.id, conclusion, toolCalls: this.calls.length, modelRequestProxyCount: this.requests.length,
      fullSnapshotCalls: this.calls.filter(c => c.name === 'browser_snapshot').length, expansionCalls: this.calls.filter(c => c.name === 'browser_expand_region').length,
      errorCalls: this.calls.filter(c => c.result.isError).length, actionCalls: this.calls.filter(c => c.name === 'browser_click').length,
      toolDefinitionTokens, toolOnlyProxyTokens: toolDefinitionTokens + this.toolPayloadTokens,
      toolPayloadTokens: this.toolPayloadTokens, fullRequestProxyTokens, fullExchangeProxyTokens: fullRequestProxyTokens + this.outputProxyTokens,
      outputProxyTokens: this.outputProxyTokens, durationMs: Math.round(performance.now() - this.started) };
  }
}
async function locate(replay, scene, strategy) {
  if (strategy === 'query-guarded') {
    const result = await replay.call('browser_find', { query: scene.query, role: 'button', region: scene.region });
    assert.ok(!result.isError, textOf(result)); const payload = payloadOf(result);
    assert.ok(payload.candidates.length <= 5); let candidates = payload.candidates.filter(c => c.available === true);
    if (scene.nearby && candidates.length > 1) {
      const matched = [];
      for (const candidate of candidates) {
        const expanded = await replay.call('browser_expand_region', { observationId: payload.observationId, ref: candidate.ref });
        assert.ok(!expanded.isError, textOf(expanded)); const subtree = payloadOf(expanded);
        assert.ok(Object.hasOwn(subtree, 'truncated'), 'Expansion must declare truncation');
        if (JSON.stringify(subtree.snapshot).includes(scene.nearby)) matched.push(candidate);
      }
      candidates = matched;
    }
    if (candidates.length === 1) return { ...candidates[0], observationId: payload.observationId };
    const snapshot = await replay.call('browser_snapshot'); const fallback = nativeCandidates(textOf(snapshot), scene);
    return fallback.length === 1 ? fallback[0] : null;
  }
  const result = await replay.call(strategy === 'native-find' ? 'browser_find' : 'browser_snapshot', strategy === 'native-find' ? { text: scene.query, maxResults: 5 } : {});
  assert.ok(!result.isError, textOf(result)); let candidates = nativeCandidates(textOf(result), scene);
  if (strategy === 'native-find' && candidates.length !== 1) candidates = nativeCandidates(textOf(await replay.call('browser_snapshot')), scene);
  return candidates.length === 1 ? candidates[0] : null;
}
async function runScene(client, page, baseUrl, schemas, scene, strategy, token) {
  await page.goto(baseUrl + scene.id); // Setup: no navigate snapshot given to planner.
  const replay = new Replay(client, schemas, scene, strategy, token); let target = await locate(replay, scene, strategy);
  if (strategy === 'query-guarded' && target) assert.ok(target.observationId, 'Positive query scenes must use the guarded path, not silently pass via native fallback');
  if (scene.mutate && target) {
    await page.evaluate(() => window.replaceTarget()); // Change DOM, supply no ref.
    const stale = await replay.call('browser_click', { target: target.ref, element: target.name, ...(target.observationId ? { observationId: target.observationId } : {}) });
    assert.ok(stale.isError, 'Replacing observed node must reject old ref');
    if (target.observationId) assert.match(textOf(stale), /stale|fresh|changed|invalid|失效|变化|重新|过期/i);
    assert.deepEqual(await page.evaluate(() => ({ ...window.hits })), {}, 'Stale action must not write');
    target = await locate(replay, scene, strategy);
    if (strategy === 'query-guarded' && target) assert.ok(target.observationId, 'Replacement must be re-observed before guarded action');
  }
  if (target) {
    const clicked = await replay.call('browser_click', { target: target.ref, element: target.name, ...(target.observationId ? { observationId: target.observationId } : {}) });
    assert.ok(!clicked.isError, textOf(clicked));
    if (target.observationId) assert.ok(!textOf(clicked).includes('### Snapshot'), 'Guarded action must suppress automatic full snapshot');
  }
  const observedModal = replay.calls.some(c => /- dialog /.test(textOf(c.result)) && textOf(c.result).includes('请先处理当前模态弹窗'));
  const verified = await replay.call('browser_verify', { text: target ? '已保存' : (observedModal ? '请先处理当前模态弹窗' : '尚未保存'), timeoutMs: 0 });
  assert.ok(!verified.isError, textOf(verified)); assert.match(textOf(verified), /"status"\s*:\s*"observed"/);
  // Independent actual state oracle; keys/results never supplied to planner.
  const actualHits = await page.evaluate(() => ({ ...window.hits }));
  assert.deepEqual(actualHits, scene.expected ? { [scene.expected]: 1 } : {}, `${strategy}/${scene.id}: real click counts`);
  const actualResult = await page.locator('#result').innerText(); assert.equal(actualResult, scene.expected ? `已保存 ${scene.expected}` : '尚未保存');
  const summary = { ...replay.finish(target ? '已操作并观察到保存反馈。' : '未找到可靠且可用的目标；整页回退后停止。'), passed: true, wrongWrites: 0, actualHits, actualResult };
  const traceFile = `browser-target-trace-${strategy}-${scene.id}.json`; jsonFile(traceFile, { summary, requests: replay.requests, calls: replay.calls });
  summary.traceFile = '.tmp/' + traceFile; return summary;
}
async function safetyProbes(client, page, baseUrl) {
  const probes = [];
  for (const kind of ['disabled', 'modal-after-find', 'reuse-after-action']) {
    await page.goto(baseUrl + (kind === 'disabled' ? 'disabled-enabled' : 'large-duplicate')); const calls = [];
    const call = async (name, input) => { const result = await client.callTool({ name, arguments: input }); calls.push({ name, input, result }); return result; };
    const found = payloadOf(await call('browser_find', { query: '保存', role: 'button', region: '通知设置' }));
    const target = found.candidates.find(c => kind === 'disabled' ? c.enabled === false : c.available === true); assert.ok(target, `${kind}: observed native candidate`);
    if (kind === 'modal-after-find') await page.evaluate(() => document.querySelector('dialog').showModal());
    const input = { target: target.ref, observationId: found.observationId, element: target.name };
    if (kind === 'reuse-after-action') { const first = await call('browser_click', input); assert.ok(!first.isError, textOf(first)); }
    const rejected = await call('browser_click', input);
    assert.ok(rejected.isError, `${kind} guarded action must fail`);
    assert.match(textOf(rejected), kind === 'disabled' ? /unavailable|state is unknown|不可用/i : kind === 'modal-after-find' ? /stale|changed|变化|失效/i : /expired|unknown.*observation|过期|失效/i,
      `${kind}: must be an observation guard rejection, not a native timeout or locator error`);
    const actualHits = await page.evaluate(() => ({ ...window.hits })); assert.deepEqual(actualHits, kind === 'reuse-after-action' ? { notification: 1 } : {});
    probes.push({ kind, passed: true, actualHits, calls });
  }
  jsonFile('browser-target-safety-probes.json', probes); return probes.map(({ calls, ...probe }) => ({ ...probe, toolCalls: calls.length }));
}

const client = new Client({ name: 'browser-target-acceptance', version: '1' }); let browser; let fixture;
const transport = endpoint => new StdioClientTransport({ command: process.execPath, args: [control, 'chrome', 'cdp', 'Target fixture', '', endpoint], cwd: desktop,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTOS_BROWSER_AUTH_STORE: path.join(out, 'browser-target-unused-auth.json') }, stderr: 'inherit' });
try {
  if (process.argv.includes('--schema-only') || process.argv.includes('--record-native-tools')) {
    await client.connect(transport('http://127.0.0.1:1')); const { tools } = await client.listTools();
    if (process.argv.includes('--record-native-tools')) jsonFile('browser-target-native-tools.json', tools);
    else { assert.ok(tools.some(t => t.name === 'browser_expand_region'), 'Missing browser_expand_region in actual MCP listTools');
      assert.ok(tools.find(t => t.name === 'browser_find')?.inputSchema.properties.query, 'Missing browser_find query mode'); console.log('Target MCP schema acceptance passed'); }
  } else {
    const sourceSha256 = sourceHashes();
    const tokenModule = process.env.CC_JS_TIKTOKEN || 'D:/gitRep/aiRep/unsloth/studio/frontend/node_modules/js-tiktoken';
    const { getEncoding } = require(tokenModule), encoding = getEncoding('o200k_base'), token = value => encoding.encode(value).length;
    fixture = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fixtureHtml(req.url.slice(1))); });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${fixture.address().port}/`;
    const debugPort = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
    browser = await chromium.launch({ executablePath: process.env.CC_TARGET_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: [`--remote-debugging-port=${debugPort}`] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await context.newPage(); await page.goto(baseUrl + scenes[0].id);
    await client.connect(transport(`http://127.0.0.1:${debugPort}`)); const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'browser_expand_region'), 'Missing browser_expand_region in actual MCP listTools');
    assert.ok(tools.find(t => t.name === 'browser_find')?.inputSchema.properties.query, 'Missing browser_find query mode');
    assert.ok(tools.find(t => t.name === 'browser_click')?.inputSchema.properties.observationId, 'Missing guarded action schema');
    jsonFile('browser-target-current-tools.json', tools); const old = baselineSchemas(tools);
    // Equal setup only, never part of replay or planner evidence.
    await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 0 } }); const results = [];
    for (const strategy of ['full-snapshot', 'native-find', 'query-guarded']) for (const scene of scenes) {
      const summary = await runScene(client, page, baseUrl, strategy === 'query-guarded' ? tools : old.tools, scene, strategy, token); results.push(summary);
      console.log(`${strategy}/${scene.id}: pass, calls=${summary.toolCalls}, requestProxyTokens=${summary.fullRequestProxyTokens}, toolPayloadTokens=${summary.toolPayloadTokens}`);
    }
    const probes = await safetyProbes(client, page, baseUrl);
    const totals = Object.fromEntries(['full-snapshot', 'native-find', 'query-guarded'].map(strategy => {
      const subset = results.filter(r => r.strategy === strategy), sum = key => subset.reduce((n, r) => n + r[key], 0);
      return [strategy, { scenes: subset.length, passed: subset.filter(r => r.passed).length, wrongWrites: sum('wrongWrites'), toolCalls: sum('toolCalls'),
        modelRequestProxyCount: sum('modelRequestProxyCount'), fullRequestProxyTokens: sum('fullRequestProxyTokens'), fullExchangeProxyTokens: sum('fullExchangeProxyTokens'),
        outputProxyTokens: sum('outputProxyTokens'), toolDefinitionTokens: sum('toolDefinitionTokens'), toolOnlyProxyTokens: sum('toolOnlyProxyTokens'), toolPayloadTokens: sum('toolPayloadTokens'), durationMs: sum('durationMs') }];
    }));
    assert.deepEqual(sourceHashes(), sourceSha256, 'Sources changed during benchmark; rerun to obtain one coherent measurement');
    jsonFile('browser-target-benchmark.json', { generatedAt: new Date().toISOString(), methodology: {
      kind: 'actual stdio MCP; deterministic planner JSON request replay; NOT real LLM success rate',
      boundary: 'Each sample starts from already-open current fixture page. Host setup navigation and browser_tabs output excluded equally and never given to planner.',
      counting: 'o200k_base of full serialized hypothetical provider requests, including all tools, system, task, arguments, results, errors, expansions, fallback and repeated history; final reasoning request included. outputProxyTokens separate. No image/vision estimation.',
      toolPayloadTokens: 'Each actual {name,input,result} counted once; toolOnlyProxyTokens adds definitions once per sample. Full requests resend definitions each model turn; fullExchangeProxyTokens also includes every assistant tool-use and final output.', baselineSchemaSource: old.source, tokenizer: tokenModule,
      limitations: ['Deterministic scripted task policies; no paid model or stochastic model robustness claim.', 'Six synthetic pages in one Chrome build; not broad web compatibility.', 'Serialized-request token proxies are not provider billing/usage.', 'Safety probes separate, excluded from strategy totals.', 'Wall times include local MCP and offline tokenization; no LLM/network latency.'],
    }, environment: { node: process.version, chrome: await browser.version(), playwrightMcp: require('@playwright/mcp/package.json').version },
      sourceSha256, scenes, totals, safetyProbes: probes, results });
    console.log(JSON.stringify({ totals, safetyProbes: probes.map(p => ({ kind: p.kind, passed: p.passed })), report: '.tmp/browser-target-benchmark.json' }, null, 2));
  }
} finally { await client.close().catch(() => {}); await browser?.close().catch(() => {}); fixture?.closeAllConnections(); fixture?.close(); }
