// Opt-in interactive Windows integration check. All writes target the fixture.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = path.join(root, "apps/desktop");
// Optional argument: win-unpacked directory produced by electron-builder.
const windowOnly = process.argv.includes("--window-only");
const gpuClick = process.argv.includes("--gpu-click");
// Keep the existing development helper and MCP bundle for before/after regression runs.
const skipBuild = process.argv.includes("--skip-build");
const flags = new Set(["--window-only", "--gpu-click", "--skip-build"]);
const packageArg = process.argv.slice(2).find(arg => !flags.has(arg));
const packaged = packageArg && path.resolve(packageArg);
if (!packaged && !existsSync(path.join(app, "out/main/desktop-vision-worker.js"))) {
  throw Error("Build the desktop vision worker first: pnpm --filter @claude-desktop/desktop build");
}
const require = createRequire(path.join(app, "package.json"));
const sdk = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = sdk("@modelcontextprotocol/sdk/client/stdio.js");
const scratch = mkdtempSync(path.join(tmpdir(), "agentos-desktop-fixture-"));
const fixtures = [];
const clients = [];
const exe = path.join(scratch, "Fixture.exe");
const framework = path.join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319");
async function fixture(title) {
  const child = spawn(exe, windowOnly ? [title, "--targets"] : [title], {
    windowsHide: false, stdio: ["pipe", "pipe", "inherit"],
  });
  fixtures.push(child);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await Promise.race([
      lines.next(),
      delay(8000, undefined, { ref: false }).then(() => { throw Error("Fixture response timeout"); }),
    ]);
    assert.ok(!line.done, "Fixture closed unexpectedly");
    return JSON.parse(line.value);
  };
  const geometry = await next();
  return { pid: child.pid, geometry, change: async command => {
    // Mutate the fixture outside MCP so the existing observation is still the latest.
    child.stdin.write(command + "\n");
    const reply = await next();
    assert.equal(reply.applied, command);
    return command === "overlays" ? reply.overlays : reply.geometry;
  } };
}
async function connect() {
  const client = new Client({ name: "integration-test", version: "1" });
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: packaged ? path.join(packaged, "CC Desktop.exe") : process.execPath,
    args: [packaged ? path.join(packaged, "resources/windows-computer/server.cjs") : path.join(app, "resources/windows-computer/dist/server.cjs")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stderr: "inherit" }));
  return client;
}
async function content(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw Error(result.content[0].text);
  return result.content;
}
async function call(client, name, args = {}) {
  return JSON.parse((await content(client, name, args))[0].text);
}
function regionAround(box, windowBounds) {
  const pad = 8;
  return { x: box.x - windowBounds.x - pad, y: box.y - windowBounds.y - pad,
    width: box.width + pad * 2, height: box.height + pad * 2 };
}
function inside(point, box) {
  return point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
}
function reportTargets(view, box) {
  const text = view.texts.find(row => row.text.replace(/\s/g, "").includes("保存报告"));
  assert.ok(text, "OCR missed the drawn 保存报告 label: " + JSON.stringify(view.texts));
  assert.ok(Number.isFinite(text.confidence) && text.confidence > 0, "OCR confidence must be positive");
  // Match the button outline itself, excluding boxes around its text and larger containers.
  const tolerance = Math.max(5, box.height * 0.1);
  const shape = view.shapes.find(row => row.kind === "rectangle" && ["x", "y", "width", "height"].every(
    key => Math.abs(row.bounds[key] - box[key]) <= tolerance));
  assert.ok(shape?.kind, "No shape matched the button outline: " + JSON.stringify(view.shapes));
  for (const row of [text, shape]) {
    assert.ok(Number.isInteger(row.point.x) && Number.isInteger(row.point.y));
    assert.ok(inside(row.point, row.bounds) && inside(row.point, box), "Expected an absolute clickable screen point");
  }
  return { text, shape };
}

async function swatchPointFromImage(image, bounds) {
  assert.equal(image.mimeType, "image/png");
  const png = Buffer.from(image.data, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const { createCanvas, loadImage } = require("@napi-rs/canvas");
  const bitmap = await loadImage(png);
  assert.deepEqual([bitmap.width, bitmap.height], [bounds.width, bounds.height]);
  const ctx = createCanvas(bitmap.width, bitmap.height).getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const y = Math.floor(bitmap.height / 2);
  const row = ctx.getImageData(0, y, bitmap.width, 1).data;
  for (let x = 0; x < bitmap.width; x++) {
    const [red, green, blue] = row.subarray(x * 4, x * 4 + 3);
    if (blue > 180 && blue - red > 120 && green > red) {
      assert.ok(x > 0 && x < bitmap.width - 3, "The crop should include the swatch's visible left edge");
      return { x: bounds.x + x + 3, y: bounds.y + y };
    }
  }
  assert.fail("The returned image must contain the blue swatch");
}

// Run on an interactive Windows desktop with: node scripts/verify-windows-computer.mjs --gpu-click
async function verifyGpuClicks(client, a, windowId, otherId, verify) {
  const run = (tool, args) => call(client, tool, { windowId, ...args });
  const click = (view, point) => run("click", { observationId: view.observationId, ...point });
  async function fixtureBounds() {
    const target = (await call(client, "list_windows")).find(w => w.windowId === windowId);
    assert.ok(target?.foreground && target.pid === a.pid, "Fixture must own foreground input");
    return target.bounds;
  }
  async function captureButton() {
    const bounds = await fixtureBounds();
    const geometry = await a.change("geometry");
    const region = regionAround(geometry.button, bounds);
    const view = await run("observe_visual", { region, ...captureOptions });
    assert.equal(view.captureSource, "compositor");
    assert.deepEqual(view.windowBounds, bounds);
    assert.deepEqual(view.bounds, { ...region, x: bounds.x + region.x, y: bounds.y + region.y });
    assert.ok(view.observationId && view.windowId === windowId);
    return { view, region, geometry, point: reportTargets(view, geometry.button).text.point };
  }
  const displays = await call(client, "list_displays");
  const primary = displays.find(d => d.primary);
  assert.ok(primary);
  const place = d => a.change(`place ${d.bounds.x + 64} ${d.bounds.y + 64}`);
  await place(primary);
  await a.change("black-print");
  await run("activate_window");
  const beforePrint = await a.change("geometry");
  const region = regionAround(beforePrint.button, await fixtureBounds());
  const probe = await run("observe_visual", { region });
  const afterPrint = await a.change("geometry");
  const prints = afterPrint.printRequests - beforePrint.printRequests;
  const painted = afterPrint.blackPrints - beforePrint.blackPrints;
  console.log(`Default window capture: ${probe.captureSource}; WM_PRINT messages: ${prints}; black paints: ${painted}.`);
  assert.ok(["print", "compositor"].includes(probe.captureSource), "Default observation must report the actual source");
  reportTargets(probe, beforePrint.button);
  // Some Windows versions copy the WPF surface directly for PW_RENDERFULLCONTENT,
  // bypassing the fixture's print procedure. Still exercise real WGC and input.
  const captureOptions = probe.captureSource === "print" ? { captureSource: "compositor" } : {};
  if (probe.captureSource === "print") console.log("PrintWindow returned visible pixels; using explicit compositor capture for this fixture.");
  const initial = await captureButton();

  // A custom-drawn target has no UIA peer. The default vision policy must
  // locate it via compositor pixels and retain its checked click binding.
  const scene = await run("inspect_window", { query: "保存报告", action: "activate", region: initial.region, ...captureOptions });
  assert.ok(scene.visionUsed);
  assert.equal(scene.captureSource, "compositor");
  const save = scene.targets.find(t => t.sources.includes("ocr") && !t.sources.includes("uia"));
  assert.ok(save, "Default inspect_window must identify the drawn target: " + JSON.stringify(scene));
  const physicalBefore = (await a.change("geometry")).cursor;
  const receipt = await run("act_on_target", {
    sceneId: scene.sceneId, targetId: save.id, action: "activate", verifyText: "Saved 1",
  });
  assert.ok(receipt.executed && receipt.via === "click" && receipt.verification?.status === "observed");
  await verify("result", c => c.name === "Saved 1");
  const physicalAfter = (await a.change("geometry")).cursor;
  assert.ok(Math.hypot(physicalAfter.x - physicalBefore.x, physicalAfter.y - physicalBefore.y) <= 2,
    "coordinate click took the user's pointer: " + JSON.stringify({ physicalBefore, physicalAfter }));
  const arrow = async () => (await a.change("overlays")).find(w => w.title === "AgentOS.ControlOverlay.Pointer");
  const before = await arrow();
  assert.ok(before);
  try {
    assert.notDeepEqual((await a.change("nudge")).cursor, physicalAfter);
    await delay(300);
    assert.deepEqual(await arrow(), before, "the virtual arrow followed independent system mouse movement");
  } finally { await a.change("undo-nudge"); }

  // Find an unlabeled target directly in the attached image, using only
  // imageBounds to translate the image point into physical desktop coordinates.
  const swatchRegion = regionAround(initial.geometry.swatch, initial.view.windowBounds);
  const blocks = await content(client, "inspect_window", { windowId, region: swatchRegion, includeImage: true, ...captureOptions });
  assert.deepEqual(blocks.map(b => b.type).sort(), ["image", "text"]);
  const imageView = JSON.parse(blocks.find(b => b.type === "text").text);
  assert.equal(imageView.windowId, windowId);
  assert.equal(imageView.captureSource, "compositor");
  assert.ok(imageView.observationId, "inspect_window(includeImage) must return an actionable observationId");
  const swatch = await swatchPointFromImage(blocks.find(b => b.type === "image"), imageView.imageBounds);
  assert.ok(inside(swatch, initial.geometry.swatch));
  await click(imageView, swatch);
  await verify("result", c => c.name === "Swatch selected");

  // The same visible fixture crop supports pixel-checked SendInput only when
  // it is explicitly bound to this HWND. Do not capture the rest of the desktop.
  async function displayCrop(button) {
    const { bounds } = button.view;
    const last = { x: bounds.x + bounds.width - 1, y: bounds.y + bounds.height - 1 };
    const display = displays.find(d => inside(bounds, d.bounds) && inside(last, d.bounds));
    assert.ok(display, "The fixture button must be entirely on one monitor");
    const args = { displayId: display.displayId,
      region: { ...bounds, x: bounds.x - display.bounds.x, y: bounds.y - display.bounds.y } };
    await fixtureBounds();
    const unbound = await call(client, "observe_display_visual", args);
    assert.equal(unbound.observationId, undefined);
    const view = await run("observe_display_visual", args);
    assert.equal(view.captureSource, "display");
    assert.ok(view.observationId && view.windowId === windowId);
    assert.deepEqual(view.bounds, bounds);
    return { view, point: reportTargets(view, button.geometry.button).text.point };
  }
  const fresh = await captureButton();
  const shown = await displayCrop(fresh);
  await click(shown.view, shown.point);
  await verify("result", c => c.name === "Saved 2");

  // Supersede a visual observation, then independently move the fixture while
  // its latest observation is still current. The old point stays in the fixture.
  const old = await captureButton();
  const current = await captureButton();
  assert.notEqual(old.view.observationId, current.view.observationId);
  await assert.rejects(click(old.view, old.point), /expired|stale|observation/i);
  const beforeMove = await captureButton();
  await a.change("move");
  const movedBounds = await fixtureBounds();
  assert.notDeepEqual(movedBounds, beforeMove.view.windowBounds);
  assert.ok(inside(beforeMove.point, movedBounds));
  await assert.rejects(click(beforeMove.view, beforeMove.point), /moved|resized|again|stale/i);
  await verify("result", c => c.name === "Saved 2");

  // Remeasure on each secondary so left-of-primary and mixed-DPI coordinates
  // are both exercised when these are different monitors.
  const secondaries = displays.filter(d => !d.primary);
  let saved = 2;
  for (const display of secondaries.length ? secondaries : [primary]) {
    if (!display.primary) await place(display);
    const relocated = await captureButton();
    assert.ok(inside(relocated.point, display.bounds));
    if (display.bounds.x + display.bounds.width <= 0) assert.ok(relocated.point.x < 0);
    await click(relocated.view, relocated.point);
    saved++;
    await verify("result", c => c.name === "Saved " + saved);
    console.log(`Verified cropped compositor input at (${relocated.point.x}, ${relocated.point.y}); scales ${initial.geometry.scale} -> ${relocated.geometry.scale}.`);
  }
  if (!secondaries.length) console.log("Single monitor: skipped cross-monitor placement.");

  const isolated = await captureButton();
  await assert.rejects(call(client, "click", { windowId: otherId,
    observationId: isolated.view.observationId, ...isolated.point }), /another window|different window/i);
  const beforeRepaint = await displayCrop(isolated);
  await a.change("repaint");
  await assert.rejects(click(beforeRepaint.view, beforeRepaint.point), /changed|stale|capture/i);
  await verify("result", c => c.name === "Saved " + saved);
  await client.close(); // Host ended this turn without a model-issued release_control.
  let layers = await a.change("overlays");
  for (let i = 0; layers.length && i < 30; i++) {
    await delay(50);
    layers = await a.change("overlays");
  }
  assert.equal(layers.length, 0, "the desktop overlay outlived its MCP connection");
  console.log("Verified compositor target and image clicks, bound display clicks, and stale, moved, changed and cross-window rejection.");
}

async function verifyUnifiedTargets(client, windowId, otherId, verify) {
  async function inspect(query, action, options = {}) {
    const blocks = await content(client, "inspect_window", { windowId, query, action, ...options });
    assert.deepEqual(blocks.map(b => b.type).sort(), options.includeImage ? ["image", "text"] : ["text"]);
    const scene = JSON.parse(blocks.find(b => b.type === "text").text);
    assert.equal(scene.windowId, windowId);
    assert.ok(scene.sceneId);
    assert.equal(typeof scene.visionUsed, "boolean");
    assert.ok(Array.isArray(scene.targets));
    for (const target of scene.targets) {
      assert.ok(target.id && target.role && target.sources.length);
      assert.ok(target.actions.includes(action));
    }
    return scene;
  }
  function byAutomationId(scene, id) {
    const target = scene.targets.find(t => t.automationId === id);
    assert.ok(target?.sources.includes("uia"), "Missing UIA target " + id + ": " + JSON.stringify(scene.targets));
    return target;
  }
  const act = (scene, target, action, options = {}) => call(client, "act_on_target", {
    windowId, sceneId: scene.sceneId, targetId: target.id, action, ...options,
  });

  const entry = await inspect("Fixture entry", "set_value");
  const field = byAutomationId(entry, "entry");
  assert.equal(entry.visionUsed, false);
  assert.deepEqual(field.sources, ["uia"]);
  const edit = await act(entry, field, "set_value", { value: "Fixture edited" });
  assert.equal(edit.executed, true);
  assert.equal(edit.via, "set_value");
  await assert.rejects(act(entry, field, "set_value", { value: "Unexpected replay" }), /scene|expired|stale|consumed/i);
  await verify("entry", c => c.value === "Fixture edited");

  const choice = await inspect("First choice", "select");
  assert.equal(choice.visionUsed, false);
  const first = choice.targets.find(t => t.name === "First choice" && t.sources.includes("uia"));
  assert.ok(first, "Missing first selectable item");
  const selection = await act(choice, first, "select", { verifyText: "Selected 0" });
  assert.equal(selection.executed, true);
  assert.equal(selection.via, "select");
  assert.equal(selection.verification?.status, "observed");
  await verify("result", c => c.name === "Selected 0");

  const checked = await inspect("Archive", "activate", { vision: "never" });
  await assert.rejects(call(client, "act_on_target", {
    windowId, sceneId: checked.sceneId, name: "Archive", action: "activate",
  }), /targetId|invalid arguments/i);
  await assert.rejects(act(checked, { id: randomUUID() }, "activate"), /target|unknown|invalid/i);
  const old = await inspect("Archive", "activate", { vision: "never" });
  const current = await inspect("Archive", "activate", { vision: "never" });
  assert.notEqual(current.sceneId, old.sceneId);
  await assert.rejects(act(old, byAutomationId(old, "archiveLeft"), "activate"), /scene|expired|stale/i);
  const isolated = await inspect("Archive", "activate", { vision: "never" });
  await assert.rejects(act(isolated, byAutomationId(isolated, "archiveRight"), "activate", { windowId: otherId }),
    /scene|different window|another window|windowId/i);
  const otherView = await call(client, "observe_window", { windowId: otherId });
  assert.equal(otherView.controls.find(c => c.automationId === "archiveResult")?.name, "No archive selected");
  await verify("archiveResult", c => c.name === "No archive selected");

  const fused = await inspect("Archive", "activate", { vision: "always", includeImage: true });
  assert.equal(fused.visionUsed, true);
  const twins = fused.targets.filter(t => t.name.toLowerCase() === "archive");
  assert.equal(twins.length, 2, "Each Archive button must appear once in the fused scene: " + JSON.stringify(fused.targets));
  const left = byAutomationId(fused, "archiveLeft");
  const right = byAutomationId(fused, "archiveRight");
  assert.ok(twins.includes(left) && twins.includes(right) && left.id !== right.id);
  const merged = twins.find(t => t.sources.includes("ocr") || t.sources.includes("shape"));
  assert.ok(merged, "Expected visual evidence on an Archive button: " + JSON.stringify(twins));
  const expected = merged.id === left.id ? "Left archive selected" : "Right archive selected";
  const invocation = await act(fused, merged, "activate", { verifyText: expected });
  assert.equal(invocation.executed, true);
  assert.equal(invocation.via, "invoke");
  assert.equal(invocation.verification?.status, "observed");
  // Try the other valid ID from that same scene before making any new observation.
  await assert.rejects(act(fused, merged.id === left.id ? right : left, "activate"), /scene|expired|stale|consumed/i);
  await verify("archiveResult", c => c.name === expected);

  const fresh = await inspect("Archive", "activate", { vision: "auto" });
  const remaining = merged.id === left.id ? "Right" : "Left";
  const mismatch = await act(fresh, byAutomationId(fresh, "archive" + remaining), "activate", {
    verifyText: "Missing fixture confirmation",
  });
  assert.equal(mismatch.executed, true);
  assert.equal(mismatch.via, "invoke");
  assert.equal(mismatch.verification?.status, "not_observed", "Readback must check the new state");
  await verify("archiveResult", c => c.name === remaining + " archive selected");

  const report = await inspect("保存报告", "activate", { vision: "auto" });
  assert.equal(report.visionUsed, true);
  const save = report.targets.find(t => t.name.replace(/\s/g, "").includes("保存报告") && t.sources.includes("ocr"));
  assert.ok(save && !save.sources.includes("uia"), "Expected the drawn OCR target: " + JSON.stringify(report.targets));
  const saved = await act(report, save, "activate", { verifyText: "Saved 3" });
  assert.equal(saved.executed, true);
  assert.equal(saved.via, "click");
  assert.equal(saved.verification?.status, "observed");
  await verify("result", c => c.name === "Saved 3");
}

async function runAcceptance() {
  if (!packaged && !skipBuild) await require("./build/windows-computer.cjs")();
  execFileSync(path.join(framework, "csc.exe"), ["/nologo", "/codepage:65001", "/utf8output", "/target:winexe", "/platform:x64", "/r:System.Xaml.dll", "/r:System.Web.Extensions.dll", "/out:" + exe,
    ...["WindowsBase", "PresentationCore", "PresentationFramework", "UIAutomationTypes"].map(name => "/r:" + path.join(framework, "WPF", name + ".dll")),
    path.join(root, "scripts/fixtures/windows-computer/DesktopFixture.cs"),
  ], { stdio: "inherit", windowsHide: true });
  const client = await connect();
  const other = await connect();
  // Start both helper processes before showing the target, so their startup
  // cannot change which fixture Windows granted foreground activation.
  await Promise.all([call(client, "list_displays"), call(other, "list_displays")]);
  const title = "AgentOS Desktop Test " + randomUUID();
  const b = await fixture(title + " other");
  const a = await fixture(title);
  const list = await call(client, "list_windows");
  const windowId = list.find(w => w.title === title && w.pid === a.pid)?.windowId;
  const otherId = list.find(w => w.title === title + " other" && w.pid === b.pid)?.windowId;
  assert.ok(windowId && otherId, "isolated fixture windows must be enumerated");
  const run = (op, args) => call(client, op, {windowId, ...args});
  const observe = () => run("observe_window");
  const control = (view, id) => {
    const c = view.controls.find(row => row.automationId === id);
    assert.ok(c, "Missing fixture control " + id);
    return c;
  };
  async function action(op, id, args) {
    const view = await observe();
    const target = control(view, id);
    const result = await run(op, { observationId: view.observationId, controlId: target.id, ...args });
    const { x, y, width, height } = target.bounds;
    await readPointer({ x: Math.floor(x + width / 2), y: Math.floor(y + height / 2) });
    return result;
  }
  async function verify(id, predicate) {
    for (let i = 0; i < 15; i++) {
      if (predicate(control(await observe(), id))) return;
      await delay(50);
    }
    throw Error("Expected state was not reached for " + id);
  }
  if (gpuClick) {
    await verifyGpuClicks(client, a, windowId, otherId, verify);
    return;
  }
  // Hold a first-operation capture at the native -> OCR boundary. Probe with an
  // invalid observation so the second connection can never deliver foreground input.
  const { nativeConnection } = require("./resources/windows-computer/native-connection.cjs");
  const helperPath = packaged ? path.join(packaged, "resources/windows-computer/AgentOS.Computer.exe")
    : path.join(app, "resources/windows-computer/dist/AgentOS.Computer.exe");
  const heldFrame = nativeConnection(() => spawn(helperPath, [String(process.pid)], {
    windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
  }));
  try {
    const signal = new AbortController().signal;
    await heldFrame.request("capture_window", {windowId}, signal);
    assert.deepEqual(await a.change("overlays"), [], "read-only capture should not show the foreground control overlay");
    const probe = () => call(other, "invoke_control", {windowId, observationId:"never-issued", controlId:"absent-test-control"});
    await assert.rejects(probe(), /owns desktop input/);
    await heldFrame.request("finish_visual", {}, signal);
    await assert.rejects(probe(), /expired|another window/i);
    await call(other, "release_control");
  } finally { heldFrame.close(); }
  if (!windowOnly) {
    const stale = await observe();
    await action("invoke_control", "button");
    await verify("result", c => c.name === "Invoked");
    await assert.rejects(run("invoke_control", { observationId: stale.observationId, controlId: control(stale, "button").id }), /observ/i);
    await action("set_value", "entry", { value: "初始文本" });
    await verify("entry", c => c.value === "初始文本");
    await action("select_item", "second");
    await verify("result", c => c.name === "Selected 1");
    await assert.rejects(call(other, "activate_window", {windowId: otherId}), /owns desktop input/);
    await run("activate_window");
    const view = await observe();
    const box = control(view, "entry").bounds;
    await run("click", { observationId: view.observationId, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
    await run("shortcut", { keys: ["Ctrl", "A"] });
    await run("type_text", { text: "AgentOS 中文输入" });
    await verify("entry", c => c.value === "AgentOS 中文输入");
    await run("shortcut", { keys: ["F5"] });
    await verify("result", c => c.name === "Shortcut received");
  }

  // Only the fixture has ground-truth geometry. Input for both positive button
  // clicks below must come from the visual tool's returned points.
  const ui = await observe();
  let page = ui;
  while (true) {
    assert.ok(!page.controls.some(c => c.name?.includes("保存报告")), "The drawn button must be invisible to UIA");
    if (!page.nextCursor) break;
    page = await run("observe_window", { cursor: page.nextCursor });
  }
  const buttonRegion = regionAround(a.geometry.button, ui.bounds);
  const swatchRegion = regionAround(a.geometry.swatch, ui.bounds);
  if (!windowOnly) {
    const displays = await call(client, "list_displays");
    const target = (await call(client, "list_windows")).find(w => w.windowId === windowId);
    assert.ok(target?.foreground, "Capture the small display region only while the fixture has focus");
    assert.deepEqual(target.bounds, ui.bounds, "The fixture must still be at its measured position");
    const screenCrop = { ...buttonRegion, x: ui.bounds.x + buttonRegion.x, y: ui.bounds.y + buttonRegion.y };
    const lastPixel = { x: screenCrop.x + screenCrop.width - 1, y: screenCrop.y + screenCrop.height - 1 };
    assert.ok(inside(screenCrop, target.bounds) && inside(lastPixel, target.bounds));
    const display = displays.find(d => inside(screenCrop, d.bounds) && inside(lastPixel, d.bounds));
    assert.ok(display?.displayId, "The small fixture crop must lie within one enumerated display");
    const displayBlocks = await content(client, "observe_display_visual", { displayId: display.displayId,
      region: { ...screenCrop, x: screenCrop.x - display.bounds.x, y: screenCrop.y - display.bounds.y } });
    assert.deepEqual(displayBlocks.map(b => b.type), ["text"]);
    const displayView = JSON.parse(displayBlocks[0].text);
    assert.deepEqual(displayView.bounds, screenCrop);
    assert.ok(!displayView.observationId, "Display observations must not authorize input");
    reportTargets(displayView, a.geometry.button);
  }

  const visual = async (region, includeImage = false) => {
    const blocks = await content(client, "observe_visual", { windowId, region, ...(includeImage && { includeImage }) });
    assert.deepEqual(blocks.map(b => b.type).sort(), includeImage ? ["image", "text"] : ["text"]);
    const view = JSON.parse(blocks.find(b => b.type === "text").text);
    assert.equal(view.windowId, windowId);
    assert.ok(view.observationId);
    assert.equal(typeof view.truncated, "boolean");
    assert.deepEqual(view.bounds, region ? { ...region, x: ui.bounds.x + region.x, y: ui.bounds.y + region.y } : ui.bounds);
    assert.equal(view.width, view.bounds.width);
    assert.equal(view.height, view.bounds.height);
    return { view, image: blocks.find(b => b.type === "image") };
  };
  const click = (view, point, target = windowId) => call(client, "click", {
    windowId: target, observationId: view.observationId, x: point.x, y: point.y,
  });
  if (windowOnly) {
    // Exercise one fixture-local UIA selection before switching to visual input,
    // just as the full acceptance workflow does. Capture after activation so
    // focus styling cannot invalidate an otherwise correct visual point.
    await action("select_item", "second");
    await verify("result", c => c.name === "Selected 1");
    await run("activate_window");
  }
  const full = (await visual()).view;
  const fullTargets = reportTargets(full, a.geometry.button);
  await click(full, fullTargets.text.point);
  await verify("result", c => c.name === "Saved 1");
  async function readPointer(point) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const overlays = await a.change("overlays");
      const pointer = overlays.find(w => w.title === "AgentOS.ControlOverlay.Pointer");
      // The arrow tip is at (20,20) in its 66-DIP tile. Allow one pixel for DPI rounding.
      if (pointer && Math.abs(pointer.x + pointer.width * 20 / 66 - point.x) <= 1 &&
          Math.abs(pointer.y + pointer.height * 20 / 66 - point.y) <= 1) {
        const passThrough = 0x20 | 0x08000000 | 0x80000; // TRANSPARENT, NOACTIVATE, LAYERED
        assert.ok(overlays.every(w => (w.style & passThrough) === passThrough));
        assert.ok(overlays.length >= 6, "expected four edge strips, a status notice and the pointer");
        return pointer;
      }
      await delay(40);
    }
    throw Error("The virtual pointer did not reach the fixture target");
  }
  const clickPointer = await readPointer(fullTargets.text.point);
  const duringControl = await call(other, "list_windows");
  assert.ok(!duringControl.some(w => w.title.startsWith("AgentOS.ControlOverlay.")));
  assert.ok(duringControl.find(w => w.windowId === windowId)?.foreground, "the overlay took focus from the fixture");
  await delay(260);
  assert.deepEqual(await readPointer(fullTargets.text.point), clickPointer, "the idle pointer must stay at the last action");
  const crop = (await visual(buttonRegion)).view;
  const croppedTargets = reportTargets(crop, a.geometry.button);
  await click(crop, croppedTargets.shape.point);
  await verify("result", c => c.name === "Saved 2");
  if (windowOnly) await verifyUnifiedTargets(client, windowId, otherId, verify);

  const fallback = await visual(swatchRegion, true);
  assert.deepEqual(fallback.view.texts, [], "The color swatch has no written label");
  const swatchPoint = await swatchPointFromImage(fallback.image, fallback.view.bounds);
  await click(fallback.view, swatchPoint);
  await verify("result", c => c.name === "Swatch selected");
  assert.notDeepEqual(await readPointer(swatchPoint), clickPointer, "the virtual pointer should follow the new target");

  const previous = (await visual(swatchRegion)).view;
  const current = (await visual(buttonRegion)).view;
  assert.notEqual(previous.observationId, current.observationId);
  await assert.rejects(click(previous, swatchPoint), /observ|expired|stale/i);
  const buttonPoint = croppedTargets.shape.point;
  const beforeChange = (await visual(buttonRegion)).view;
  await a.change("repaint");
  await assert.rejects(click(beforeChange, buttonPoint), /observ|changed|stale|capture/i);
  const beforeMove = (await visual(buttonRegion)).view;
  await a.change("move");
  await assert.rejects(click(beforeMove, buttonPoint), /observ|moved|changed|stale/i);
  await verify("result", c => c.name === "Swatch selected");

  const moved = (await call(client, "list_windows")).find(w => w.windowId === windowId);
  assert.notDeepEqual(moved.bounds, ui.bounds, "The fixture must actually move between captures");
  const movedCapture = await call(client, "observe_visual", { windowId, region: buttonRegion });
  const movedPoint = { x: buttonPoint.x + moved.bounds.x - ui.bounds.x, y: buttonPoint.y + moved.bounds.y - ui.bounds.y };
  await call(client, "activate_window", {windowId: otherId});
  await assert.rejects(click(movedCapture, movedPoint, otherId), /another window|different window/i);
  if (!windowOnly) {
    await assert.rejects(run("type_text", {text:"should never land"}), /foreground/i);
    await call(client, "release_control");
    await call(other, "activate_window", {windowId: otherId});
    // Send the registered emergency chord only while the other fixture owns focus.
    try { await call(other, "shortcut", {windowId: otherId, keys:["Ctrl", "Alt", "F10"]}); }
    catch (error) { if (!/stopped by the user/i.test(error.message)) throw error; }
    let stopped = false;
    for (let i = 0; i < 15 && !stopped; i++) {
      await delay(40);
      try { await call(other, "list_windows"); }
      catch (error) { if (!/stopped by the user/i.test(error.message)) throw error; stopped = true; }
    }
    assert.ok(stopped, "global stop must permanently revoke the current MCP connection");
    await call(client, "activate_window", {windowId: otherId});
    await call(client, "release_control");
  }
  await call(client, "release_control");
  assert.deepEqual(await a.change("overlays"), [], "releasing desktop control must remove its indicators");
  const beforeRelease = await observe();
  await call(client, "release_control");
  // A placeholder control id ensures the negative test can never deliver input.
  await assert.rejects(run("invoke_control", {observationId:beforeRelease.observationId,controlId:"absent-test-control"}), /expir|another window/i);
  await call(client, "release_control");
  console.log("Verified the desktop control overlay, click-through, pointer tracking, persistence and cleanup.");
  console.log(windowOnly ? "Verified fixture target discovery, fusion, UIA and visual actions, readback, OCR, PNG fallback and stale/changed/moved/cross-window rejection." : "Verified desktop input, display and window OCR, shape clicks, image fallback, stale observations and emergency stop.");
}

try {
  await runAcceptance();
} finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const child of fixtures) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  if (path.dirname(scratch) === path.resolve(tmpdir()) && path.basename(scratch).startsWith("agentos-desktop-fixture-")) {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}
