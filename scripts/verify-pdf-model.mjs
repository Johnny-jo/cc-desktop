// Live acceptance against the configured local CPA. Sends synthetic documents only.
// Run after the desktop build: node scripts/verify-pdf-model.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { claudeBinaryVersion } from "./claude-vendor.mjs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite"))("esbuild");
const { parse } = require("yaml");
const { createCanvas } = require("@napi-rs/canvas");
const { query } = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href);
const fixtureModule = join(desktop, "out/main/pdf-acceptance.cjs");
const scratch = mkdtempSync(join(tmpdir(), "pdf-model-acceptance-"));
await build({ stdin: { resolveDir: desktop, contents: `
export { PdfCompatibilityProxy, extractPdfInWorker } from './electron/main/pdf-compatibility-proxy';
export { SessionManager } from './electron/main/session-manager';
export { DiffTracker } from './electron/main/diff-tracker';
export { buildUserContent } from './electron/main/attachment-reader';
export { attachmentFromFile } from '@claude-desktop/shared';
export { pdfFixture, mixedPdfFixture } from './electron/main/pdf-test-fixture';
` }, outfile: fixtureModule, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
const { PdfCompatibilityProxy, extractPdfInWorker, SessionManager, DiffTracker, buildUserContent, attachmentFromFile, pdfFixture, mixedPdfFixture } = require(fixtureModule);
const settings = JSON.parse(readFileSync(join(process.env.APPDATA, "@claude-desktop/desktop/settings.json"), "utf8"));
const config = parse(readFileSync(settings.cpaConfigPath, "utf8"));
const keys = config.access?.["api-keys"] ?? config["api-keys"];
const clientKey = Array.isArray(keys) ? keys[0] : null;
assert.equal(typeof clientKey, "string", "Configured CPA client key required");
assert.match(settings.defaultModel, /deepseek/i, "This regression probe expects the affected DeepSeek model");
const origin = `http://127.0.0.1:${settings.cpaPort}`;
const filePath = join(scratch, "synthetic-budget.pdf");
function scan(lines) {
  const canvas = createCanvas(1240, 1754);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "black"; ctx.font = '36px "Microsoft YaHei", sans-serif';
  lines.forEach((line, i) => ctx.fillText(line, 70, 170 + i * 110));
  return { image: { jpeg: canvas.toBuffer("image/jpeg"), width: canvas.width, height: canvas.height } };
}
const bytes = mixedPdfFixture([
  scan(["本地 OCR 扫描件验收", "Project reference: CEDAR-731", "Budget: 24680 USD"]),
  scan(["审批记录", "Approval code: 59283"]),
]);
writeFileSync(filePath, bytes);
const attachment = attachmentFromFile({ name: "synthetic-budget.pdf", path: filePath, size: bytes.length });
const prompt = { text: "Read the attached PDF. Return only the project reference and budget. Do not use tools.", attachments: [attachment] };
const built = buildUserContent(prompt); assert.deepEqual(built.errors, []);
const body = { model: settings.defaultModel, max_tokens: 128, thinking: { type: "disabled" }, messages: [{ role: "user", content: built.content }] };
const gate = new PdfCompatibilityProxy();
let manager;
const report = { model: settings.defaultModel, fixture: "two-page image-only PDF requiring local OCR",
  claudeVersion: claudeBinaryVersion(join(root, "vendor/win-x64/claude/claude.exe")),
  sdkVersion: JSON.parse(readFileSync(join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8")).version,
};
async function request(base, payload) {
  const response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": clientKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000) });
  return { status: response.status, body: await response.text() };
}
function textResponse(response) {
  assert.equal(response.status, 200, `Unexpected model status ${response.status}`);
  return JSON.parse(response.body).content.filter(block => block.type === "text").map(block => block.text).join("");
}
try {
  const workerText = await extractPdfInWorker(pdfFixture(["项目预算合计三万元"], true));
  assert.ok(workerText.includes("项目预算合计三万元")); report.builtWorkerChinese = true;
  const old = await request(origin, body);
  report.before = { status: old.status, sameFileContractError: old.body.includes("file must have a file_id or file_data") };
  assert.deepEqual(report.before, { status: 400, sameFileContractError: true });
  const env = await gate.environment({ ANTHROPIC_BASE_URL: origin });
  const first = textResponse(await request(env.ANTHROPIC_BASE_URL, body));
  assert.match(first, /CEDAR-731/); assert.match(first, /24,?680/);
  report.after = { status: 200, reply: first };
  const resumedBody = { ...body, messages: [...body.messages, { role: "assistant", content: first }, { role: "user", content: "What is the approval code on page 2 of the earlier PDF? Reply with only the code." }] };
  const second = textResponse(await request(env.ANTHROPIC_BASE_URL, resumedBody));
  assert.match(second, /59283/); report.history = { status: 200, reply: second };
  console.log(JSON.stringify({ phase: "CPA PDF requests passed", report }));

  const events = [];
  const readProbePath = join(scratch, "runtime-probe.txt");
  const readMarker = `READ-VERIFIED-${randomUUID()}`;
  writeFileSync(readProbePath, readMarker);
  let readPermissionChecks = 0;
  const sourceSettings = { ...settings, effort: undefined, modelEfforts: {}, defaultContextLimit: 200_000, modelContextLimits: {} };
  manager = new SessionManager({
    pdfCompatibility: new PdfCompatibilityProxy(),
    queryFn: args => query({ ...args, options: { ...args.options, tools: ["Read"], allowedTools: [], permissionMode: "default", settingSources: [], mcpServers: {}, systemPrompt: "Answer synthetic document questions directly. When asked to read runtime-probe.txt, use the Read tool for that exact local file.", maxTurns: 3 } }),
    permissionBroker: { canUseTool: async (name, input) => {
      readPermissionChecks++;
      return name === "Read" && resolve(scratch, String(input.file_path ?? "")) === readProbePath
        ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Only the synthetic probe file may be read" };
    } },
    diffTracker: new DiffTracker(),
    cpa: {
      ensureReady: async () => ({ state: "ready", port: settings.cpaPort, managedByApp: false }),
      getModelCatalog: () => [],
      buildProcessEnv: () => ({ ...process.env, ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: clientKey, ANTHROPIC_MODEL: settings.defaultModel, CLAUDE_CONFIG_DIR: join(scratch, "sdk-profile"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }),
    },
    settings: { get: () => sourceSettings },
    claudeExecutablePath: join(root, "vendor/win-x64/claude/claude.exe"),
    emit: event => events.push(event), emitSession: () => {}, emitDiff: () => {},
  });
  const timeout = setTimeout(() => manager?.disposeAll(), 120_000);
  try {
    const sessionId = await manager.start(prompt, scratch);
    let failures = events.filter(event => event.type === "result" && !event.ok);
    assert.equal(failures.length, 0, failures.map(event => event.error).join("; "));
    const firstTranscript = JSON.stringify(manager.getTranscript(sessionId));
    assert.match(firstTranscript, /CEDAR-731/); assert.match(firstTranscript, /24,?680/);
    manager.closeSession(sessionId);
    await manager.continue(sessionId, { text: "What is the approval code from page 2 of the earlier PDF? Reply with only the code.", attachments: [] });
    failures = events.filter(event => event.type === "result" && !event.ok);
    assert.equal(failures.length, 0, failures.map(event => event.error).join("; "));
    assert.match(JSON.stringify(manager.getTranscript(sessionId)), /59283/);
    await manager.continue(sessionId, { text: "Use the Read tool to open runtime-probe.txt in the current working directory. Return only the marker in that file.", attachments: [] });
    failures = events.filter(event => event.type === "result" && !event.ok);
    assert.equal(failures.length, 0, failures.map(event => event.error).join("; "));
    assert.ok(events.some(event => event.type === "tool_start" && event.tool?.name === "Read"), "Expected an actual SDK Read tool event");
    assert.ok(readPermissionChecks > 0, "Expected SDK permission callback");
    assert.ok(JSON.stringify(manager.getTranscript(sessionId)).includes(readMarker));
    report.sdk = { firstTurn: "passed", resumedTurn: "passed", readTool: "passed", permissionCallback: "passed", resultCount: events.filter(event => event.type === "result").length };
  } finally { clearTimeout(timeout); }
  writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: "passed", scratch, report }));
} finally {
  manager?.disposeAll(); gate.dispose(); unlinkSync(fixtureModule);
}
