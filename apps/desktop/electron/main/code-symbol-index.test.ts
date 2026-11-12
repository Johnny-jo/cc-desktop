import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lookupCodeSymbol } from "./code-symbol-index";

const roots: string[] = [];
function project(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "code-symbol-index-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("lookupCodeSymbol", () => {
  it("returns complete overloads and only calls to the selected definition across import and export aliases", () => {
    const source = [
      "export function draw(x: number): number;",
      "export function draw(x: string): string;",
      "export function draw(x: string | number) {",
      "  return x;",
      "}",
    ].join("\n");
    const root = project({
      "src/draw.ts": source,
      "lib/barrel.mts": "export { draw as sketch } from '../src/draw.js';",
      "lib/other.ts": "export const draw = () => 'other';\ndraw();",
      "examples/use.tsx": [
        "import { sketch as paint } from '@lib/barrel.mjs';",
        "import * as tools from '../src/draw';",
        "paint(1); tools.draw('x');",
        "const copy = paint; copy(2);",
        "function shadow(paint: () => void) { paint(); }",
        "const mention = 'draw(1)';",
      ].join("\n"),
      "tsconfig.base.json": '{"compilerOptions":{"paths":{"@lib/*":["./lib/*"]}}}',
      "examples/tsconfig.json": '{"extends":"../tsconfig.base.json"}',
    });
    const ambiguous = lookupCodeSymbol(root, { name: "draw" });
    expect(ambiguous).toMatchObject({ status: "ambiguous", candidates: [
      { file: "lib/other.ts", startLine: 1 }, { file: "src/draw.ts", startLine: 1 },
    ] });
    const result = lookupCodeSymbol(root, { name: "draw", file: "src/draw.ts", line: 4 });
    expect(result).toMatchObject({
      status: "found",
      definition: { file: "src/draw.ts", startLine: 1, endLine: 5, text: source },
      calls: [{ file: "examples/use.tsx", line: 3 }, { file: "examples/use.tsx", line: 3 }, { file: "examples/use.tsx", line: 4 }],
      totalCalls: 3, nextCallOffset: null, coverage: { partial: false },
    });
  });

  it("disambiguates methods in the same file and distinguishes callers with different receiver types", () => {
    const root = project({ "model.ts": [
      "class Left { run() { return 1; } }",
      "class Right { run() { return 2; } }",
      "new Left().run();",
      "new Right().run();",
      "const left = new Left(); left['run']();",
      "let dynamic: any; dynamic.run();",
    ].join("\n") });
    expect(lookupCodeSymbol(root, { name: "run", file: "model.ts" })).toMatchObject({ status: "ambiguous" });
    expect(lookupCodeSymbol(root, { name: "run", file: "model.ts", line: 1 })).toMatchObject({
      status: "found", definition: { text: "run() { return 1; }" }, calls: [{ line: 3 }, { line: 5 }], totalCalls: 2,
    });
  });

  it("indexes JS/TS module variants, JSX, local arrow functions and complete long source", () => {
    const source = "export const arrow = (x: number) => {\n" + "// padding\n".repeat(4000) + "  return x;\n};";
    const files: Record<string, string> = { "util.cts": source };
    for (const ext of ["js", "jsx", "ts", "tsx", "cjs", "mjs", "mts", "cts"]) {
      files["use." + ext] = "import { arrow } from './util.cjs';\narrow(1);";
    }
    expect(lookupCodeSymbol(project(files), { name: "arrow" })).toMatchObject({
      status: "found", definition: { text: source, endLine: 4003 }, totalCalls: 8,
    });
  });

  it("tracks receiver types through standard Map, Array and Promise declarations", () => {
    const root = project({ "main.ts": [
      "class Stream { end() { return true; } }",
      "class Unrelated { end() { return false; } }",
      "const streams = new Map<string, { input?: Stream }>();",
      "streams.get('first')?.input?.end();",
      "const items = [new Stream()]; items[0].end();",
      "Promise.resolve(new Stream()).then(item => item.end());",
      "Promise.resolve(new Unrelated()).then(item => item.end());",
    ].join("\n") });
    expect(lookupCodeSymbol(root, { name: "end", file: "main.ts", line: 1 })).toMatchObject({
      status: "found", totalCalls: 3, calls: [{ line: 4 }, { line: 5 }, { line: 6 }], coverage: { indexedFiles: 1 },
    });
  });

  it("paginates stable one-based call positions", () => {
    const root = project({ "file.js": "function run() {}\n" + "  run();\n".repeat(240) });
    const first = lookupCodeSymbol(root, { name: "run" });
    expect(first.status).toBe("found");
    if (first.status !== "found") throw Error("missing symbol");
    expect(first.totalCalls).toBe(240);
    expect(first.nextCallOffset).toBe(first.calls.length);
    expect(first.calls[0]).toMatchObject({ file: "file.js", line: 2, column: 3 });
    const next = lookupCodeSymbol(root, { name: "run", callOffset: first.calls.length });
    expect(next.status).toBe("found");
    if (next.status === "found") {
      expect(next.calls[0].line).toBe(2 + first.calls.length);
      expect(next.definition).toEqual({ file: "file.js", startLine: 1, endLine: 1 });
      expect(next.totalCalls).toBe(240);
    }
  });

  it("excludes dependency, output, hidden, temporary and external files, even through imports", () => {
    const other = project({ "secret.ts": "export function outsideRoot() {}" });
    const root = project({
      ".private/x.ts": "export function outsideRoot() {}",
      "node_modules/fake/x.ts": "export function outsideRoot() {}",
      "out/main/x.js": "function outsideRoot() {}",
      "tmp/x.js": "function outsideRoot() {}",
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "secret": [path.join(other, "secret.ts")] } } }),
      "inside.ts": "import { outsideRoot } from 'secret'; import './link/secret'; outsideRoot();",
    });
    expect(lookupCodeSymbol(root, { name: "outsideRoot" })).toMatchObject({ status: "not_found", coverage: { indexedFiles: 1 } });
  });

  it("excludes directory links", ({ skip }) => {
    const other = project({ "secret.ts": "export function outsideRoot() {}" });
    const root = project({ "inside.ts": "import './link/secret';" });
    try {
      symlinkSync(other, path.join(root, "link"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip();
      throw error;
    }
    expect(lookupCodeSymbol(root, { name: "outsideRoot" })).toMatchObject({ status: "not_found", coverage: { indexedFiles: 1 } });
    expect(lookupCodeSymbol(path.join(root, "link"), { name: "outsideRoot" })).toMatchObject({
      status: "incomplete", coverage: { indexedFiles: 0, partial: true },
    });
  });

  it("resolves CommonJS export assignments and destructured require calls", () => {
    const root = project({
      "util.cjs": "exports.work = function (n) { return n; };",
      "main.cjs": "const { work: task } = require('./util.cjs');\ntask(42);",
    });
    expect(lookupCodeSymbol(root, { name: "work" })).toMatchObject({
      status: "found", definition: { file: "util.cjs", text: "exports.work = function (n) { return n; };" },
      calls: [{ file: "main.cjs", line: 2 }],
    });
  });

  it("finds named function expressions, recursion and a renamed CommonJS default import", () => {
    const root = project({
      "util.cjs": "module.exports = function calculate(x) { return x ? calculate(0) : x; };",
      "main.cjs": "const compute = require('./util.cjs');\ncompute(3);",
    });
    expect(lookupCodeSymbol(root, { name: "calculate" })).toMatchObject({
      status: "found", definition: { file: "util.cjs", text: "function calculate(x) { return x ? calculate(0) : x; }" },
      totalCalls: 2, calls: [{ file: "main.cjs" }, { file: "util.cjs" }],
    });
    const sameName = project({ "job.js": "const work = function work() { work(); }; work();" });
    expect(lookupCodeSymbol(sameName, { name: "work" })).toMatchObject({ status: "found", totalCalls: 2 });
  });

  it("resolves a local scoped package's exported barrel and subpath without installed dependencies", () => {
    const root = project({
      "packages/shared/package.json": JSON.stringify({
        name: "@example/shared", version: "1.0.0", exports: {
          ".": { types: "./src/index.ts", default: "./dist/index.js" }, "./helper": "./src/helper.ts",
        },
      }),
      "packages/shared/src/helper.ts": "export function compute() {}",
      "packages/shared/src/index.ts": "export * from './helper';",
      "app/main.ts": "import { compute as a } from '@example/shared';\nimport { compute as b } from '@example/shared/helper';\na(); b();",
    });
    expect(lookupCodeSymbol(root, { name: "compute" })).toMatchObject({
      status: "found", totalCalls: 2, calls: [{ file: "app/main.ts", column: 1 }, { file: "app/main.ts", column: 6 }],
    });
  });

  it("reports same-line ambiguity with distinguishable column positions", () => {
    const root = project({ "x.ts": "class A { run() { return 1; } }; class B { run() { return 2; } }\nnew A().run();\nnew B().run();" });
    expect(lookupCodeSymbol(root, { name: "run", file: "x.ts", line: 1 })).toMatchObject({
      status: "ambiguous", hint: expect.stringMatching(/column/i),
      candidates: [{ startColumn: 11 }, { startColumn: 44 }],
    });
    expect(lookupCodeSymbol(root, { name: "run", file: "x.ts", line: 1, column: 11 })).toMatchObject({
      status: "found", definition: { text: "run() { return 1; }" }, calls: [{ line: 2 }],
    });
    expect(lookupCodeSymbol(root, { name: "run", file: "x.ts", line: 1, column: 44 })).toMatchObject({
      status: "found", definition: { text: "run() { return 2; }" }, calls: [{ line: 3 }],
    });
  });

  it("reports an incomplete search when a source file exceeds the indexing budget", () => {
    const root = project({ "big.ts": "//" + "x".repeat(2 * 1024 * 1024) + "\nexport function wanted() {}" });
    expect(lookupCodeSymbol(root, { name: "wanted" })).toMatchObject({
      status: "incomplete", coverage: { partial: true, reasons: [expect.any(String)] },
    });
  });
});
