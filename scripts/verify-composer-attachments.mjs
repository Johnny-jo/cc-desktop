// Real Electron file input/drag, production preload + attachment IPC, isolated model boundary.
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite"))("esbuild");
const scratch = mkdtempSync(join(tmpdir(), "composer-attachment-acceptance-"));
// A valid one-page PDF with a large whitespace content stream tests the 5–10 MiB range.
const stream = "BT /F1 12 Tf 72 720 Td (Attachment acceptance fixture) Tj ET\n" + " ".repeat(6 * 1024 * 1024);
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
let pdf = "%PDF-1.4\n";const offsets = [0];
objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const files = {
  pdf: join(scratch, "非常长的项目需求说明与附件排版回归验收报告-2026-11-04.pdf"),
  big: join(scratch, "超过限制.pdf"),
  doc: join(scratch, "合同资料.doc"), xlsx: join(scratch, "预算清单.xlsx"),
  txt: join(scratch, "说明.txt"), json: join(scratch, "数据.json"),
};
writeFileSync(files.pdf, pdf);
writeFileSync(files.big, "%PDF-1.4");truncateSync(files.big, 10 * 1024 * 1024 + 1);
writeFileSync(files.doc, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
writeFileSync(files.xlsx, Buffer.from([0x50, 0x4b, 3, 4]));
writeFileSync(files.txt, "附件排版与中文编码检查");writeFileSync(files.json, '{"message":"你好"}');

await build({stdin:{resolveDir:desktop,loader:"tsx",contents:`
  import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
  import {Composer} from './src/components/Composer';import {saveSettings} from './src/state/store';
  const root=createRoot(document.getElementById('root'));
  window.fixture={async start(){document.documentElement.style.setProperty('--ui-font-size','13px');await saveSettings({});flushSync(()=>root.render(<Composer/>));},
    drop(){const transfer=new DataTransfer();for(const file of document.getElementById('drop-source').files)transfer.items.add(file);document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},
    clear(){document.querySelectorAll('.composer-attachment-remove').forEach(button=>button.click());},
    input(value){const input=document.querySelector('.composer-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));},
  };
`},outfile:join(scratch,"fixture.js"),bundle:true,platform:"browser",format:"iife",jsx:"automatic",
define:{"process.env.NODE_ENV":'"production"'},logLevel:"silent"});
writeFileSync(join(scratch,"fixture.html"),`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>
${readFileSync(join(desktop,"src/styles.css"),"utf8")}
${readFileSync(join(scratch,"fixture.css"),"utf8")}
html,body{height:100%;margin:0}main{position:absolute;bottom:20px;left:0;right:0;max-width:820px;margin:auto;padding:0 20px}
</style></head><body><main><div id="root"></div></main><input type="file" id="drop-source" multiple hidden><script src="fixture.js"></script></body></html>`);

await build({stdin:{resolveDir:desktop,loader:"ts",contents:`
  import {app,BrowserWindow,ipcMain} from 'electron';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
  import {SettingsStore} from './electron/main/settings-store';import {registerIpcHandlers} from './electron/main/ipc-handlers';
  import {buildUserContent} from './electron/main/attachment-reader';import {IPC} from '@claude-desktop/shared';
  const scratch=${JSON.stringify(scratch)};const files=${JSON.stringify(files)};
  app.setPath('userData',path.join(scratch,'profile'));app.disableHardwareAcceleration();
  let win;const report={};const errors=[];let sent=0;const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const until=async source=>{for(let i=0;i<100;i++){if(await evaluate(source))return;await wait(30);}throw new Error('UI timeout: '+source);};
  const choose=async paths=>{const {root}=await win.webContents.debugger.sendCommand('DOM.getDocument');const {nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'#drop-source'});await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:paths});await evaluate('window.fixture.drop()');};
  const clear=async()=>{for(let i=0;i<6;i++){if(!await evaluate('!!document.querySelector(".composer-attachment-remove")'))return;await evaluate('document.querySelector(".composer-attachment-remove").click()');await wait(20);}};
  const shot=async name=>{await wait(100);fs.writeFileSync(path.join(scratch,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  app.whenReady().then(async()=>{
    const settings=new SettingsStore({userDataDir:path.join(scratch,'profile'),encrypt:s=>s,decrypt:s=>s});settings.update({locale:'zh',theme:'light'});
    registerIpcHandlers({settings,window:()=>win,sessions:{},cpa:{},permissions:{},userPrompts:{},diffs:{},snapshots:{},terminal:{}});
    ipcMain.removeHandler(IPC.cpaModelCatalog);ipcMain.handle(IPC.cpaModelCatalog,async()=>[]);
    ipcMain.removeHandler(IPC.sessionStart);ipcMain.handle(IPC.sessionStart,async(_event,payload)=>{
      const prompt=payload.prompt;const built=buildUserContent(prompt);assert.deepEqual(built.errors,[]);
      const document=built.content.find(block=>block.type==='document');
      assert.ok(document);assert.equal(document.source.media_type,'application/pdf');
      assert.deepEqual(Buffer.from(document.source.data,'base64'),fs.readFileSync(files.pdf));
      sent++;report.pdfPayload={type:document.type,bytes:Buffer.from(document.source.data,'base64').length};
      return {sessionId:'attachment-fixture'};
    });
    win=new BrowserWindow({show:false,width:960,height:620,webPreferences:{preload:${JSON.stringify(join(desktop,"out/preload/index.js"))},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
    win.webContents.debugger.attach('1.3');await win.loadFile(path.join(scratch,'fixture.html'));await evaluate('window.fixture.start()');
    await choose([files.pdf]);await until('document.querySelectorAll(".composer-attachment").length===1');
    assert.equal(await evaluate('!!document.querySelector(".composer-attachment-error")'),false);
    assert.equal(await evaluate('document.querySelector("[aria-label=Send]").disabled'),false);
    await choose([files.pdf]);await wait(80);assert.equal(await evaluate('document.querySelectorAll(".composer-attachment").length'),1);report.pdfDropAndDeduplicate=true;
    await evaluate('document.querySelector("[aria-label=Send]").click()');await wait(200);assert.equal(sent,1);
    await choose([files.big]);await until('!!document.querySelector(".composer-attachment-error")');
    assert.equal(await evaluate('document.querySelector("[aria-label=Send]").disabled'),true);
    await evaluate('document.querySelector(".composer-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');await wait(80);assert.equal(sent,1);report.oversizeBlocked=true;
    await clear();await choose([files.doc,files.pdf,files.xlsx,files.txt,files.json]);await until('document.querySelectorAll(".composer-attachment").length===5');
    const labels=await evaluate('Array.from(document.querySelectorAll(".composer-attachment-meta")).map(node=>node.textContent)');
    assert.ok(labels.some(s=>s.includes('Word 文档')));assert.ok(labels.some(s=>s.includes('电子表格')));assert.ok(labels.some(s=>s.includes('PDF 文档')));
    assert.ok(labels.every(s=>!s.includes('binary')&&!s.includes(' · text')));report.formatLabels=labels;
    await shot('files-wide');
    for(const theme of ['light','dark']){
      win.setContentSize(420,620);await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await wait(150);
      const layout=await evaluate('(()=>{const cards=Array.from(document.querySelectorAll(".composer-attachment"));return {overflow:document.documentElement.scrollWidth>innerWidth,cards:cards.length,removeInside:cards.every(card=>{const a=card.getBoundingClientRect(),b=card.querySelector("button").getBoundingClientRect();return b.left>=a.left&&b.right<=a.right;}),railHeight:document.querySelector(".composer-attachments").getBoundingClientRect().height,sendVisible:document.querySelector("[aria-label=Send]").getBoundingClientRect().bottom<=innerHeight};})()');
      assert.equal(layout.overflow,false);assert.equal(layout.removeInside,true);assert.equal(layout.sendVisible,true);assert.ok(layout.railHeight<=176);
      report[theme]=layout;await shot('files-'+theme);
    }
    await clear();assert.equal(await evaluate('document.querySelectorAll(".composer-attachment").length'),0);report.removeAll=true;
    assert.deepEqual(errors,[]);report.consoleErrors=errors;
    fs.writeFileSync(path.join(scratch,'report.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify({result:'passed',scratch,report})+'\\n');win.destroy();app.quit();
  }).catch(error=>{process.stdout.write(JSON.stringify({result:'failed',scratch,error:String(error.stack||error),errors,report})+'\\n');app.exit(1);});
  setTimeout(()=>app.exit(2),60000).unref();
`},outfile:join(scratch,"main.cjs"),bundle:true,platform:"node",format:"cjs",external:["electron"],logLevel:"silent"});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require("electron"),[join(scratch,"main.cjs")],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.on("exit",code=>{process.exitCode=code??1;});
