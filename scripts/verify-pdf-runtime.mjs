// Validates Electron utilityProcess OCR, including native dependencies in the Windows package.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite"))("esbuild");
const scratch = mkdtempSync(join(tmpdir(), "pdf-electron-acceptance-"));
const script = join(scratch, "main.cjs");
const workers = [join(desktop, "out/main/pdf-text-worker.js"), join(desktop, "release/win-unpacked/resources/app.asar/out/main/pdf-text-worker.js")];
const modelDirs = [join(desktop, "resources/models/ocr/ppocr_v5_mobile"), join(desktop, "release/win-unpacked/resources/models/ocr/ppocr_v5_mobile")];
const canvasModule = require.resolve("@napi-rs/canvas");
await build({ stdin: { resolveDir: desktop, contents: `
  const {app}=require('electron');const assert=require('node:assert/strict');
  const {pdfFixture,mixedPdfFixture}=require('./electron/main/pdf-test-fixture');
  const {PdfTextProcess}=require('./electron/main/pdf-text-process');
  const {createCanvas}=require(${JSON.stringify(canvasModule)});
  app.setPath('userData',${JSON.stringify(join(scratch, "profile"))});app.disableHardwareAcceleration();
  app.whenReady().then(async()=>{
    const canvas=createCanvas(1240,1754);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='black';ctx.font='36px "Microsoft YaHei"';
    ['本地 OCR 中文扫描测试','项目编号：CEDAR-731','合同金额：人民币 24680 元'].forEach((line,i)=>ctx.fillText(line,70,170+i*110));
    const scan=mixedPdfFixture([{image:{jpeg:canvas.toBuffer('image/jpeg'),width:canvas.width,height:canvas.height}}]);
    const report=[];const workers=${JSON.stringify(workers)};const modelDirs=${JSON.stringify(modelDirs)};
    for(let i=0;i<workers.length;i++) {
      const parser=new PdfTextProcess({scriptPath:workers[i],modelsDir:modelDirs[i]});
      try {
        const native=await parser.extract(pdfFixture(['项目预算合计三万元'],true));assert.ok(native.includes('项目预算合计三万元'));assert.ok(!native.includes('[本地 OCR]'));
        const start=Date.now();const text=await parser.extract(scan);assert.ok(text.includes('[本地 OCR]'));assert.ok(text.includes('CEDAR-731'));assert.ok(text.includes('24680'));assert.ok(text.includes('中文扫描测试'));
        report.push({runtime:i?'packaged':'development',scannedPdf:true,chinese:true,elapsedMs:Date.now()-start});
      } finally {parser.dispose();}
    }
    process.stdout.write(JSON.stringify({result:'passed',report})+'\\n');app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
` }, outfile: script, bundle: true, platform: "node", format: "cjs", external: ["electron", canvasModule], logLevel: "silent" });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [script], { env, windowsHide: true, stdio: "inherit" });
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
