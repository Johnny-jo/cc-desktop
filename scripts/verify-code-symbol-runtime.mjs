// Run after packaging. Exercises the lazy runner in Electron, with the same
// ASAR paths and compiler declarations that the installed desktop app uses.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(script), "../apps/desktop");
const require = createRequire(path.join(desktop, "package.json"));

if (process.type === "browser") {
  const { app } = require("electron");
  const [archive, scratch] = process.argv.slice(2);
  app.setPath("userData", path.join(scratch, "profile"));
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    app.setAppPath(archive);
    const chunks = path.join(archive, "out/main/chunks");
    const runner = fs.readdirSync(chunks).find(file => /^code-symbol-runner-.*\.js$/.test(file));
    assert.ok(runner, "Missing built symbol runner");
    const source = "value() { return 42; }";
    const root = path.join(scratch, "project");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "source.ts"), "export class Item { " + source + " }");
    fs.writeFileSync(path.join(root, "caller.ts"),
      "import { Item } from './source';\nconst map = new Map<string, Item>();\nmap.get('k')?.value();");
    const { runCodeSymbolLookup } = require(path.join(chunks, runner));
    const discovery = await runCodeSymbolLookup(root, {
      purpose: "find numeric value producer", hints: ["value"], scope: ".",
    });
    assert.equal(discovery.status, "candidates");
    const candidate = discovery.candidates.find(item => item.name === "value" && item.file === "source.ts");
    assert.ok(candidate, "Purpose search missed the implementation");
    assert.ok(candidate.excerpt.text.includes("return 42"));
    const result = await runCodeSymbolLookup(root, { name: candidate.name, file: candidate.file,
      line: candidate.startLine, column: candidate.startColumn });
    assert.equal(result.status, "found");
    assert.equal(result.definition.text, source);
    assert.equal(result.coverage.partial, false, result.coverage.reasons.join(", "));
    assert.equal(result.totalCalls, 1);
    assert.equal(result.calls[0].file, "caller.ts");
    assert.equal(result.calls[0].line, 3);
    console.log("Packaged purpose search expanded the definition and resolved a cross-file call through Map.get().");
    app.exit(0);
  }).catch(error => {
    console.error(error);
    app.exit(1);
  });
} else {
  const archive = path.resolve(process.argv[2] ?? path.join(desktop, "release/win-unpacked/resources/app.asar"));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cc-symbol-package-"));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(require("electron"), [script, archive, scratch], { env, windowsHide: true, stdio: "inherit", timeout: 60_000 });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
