// Isolated acceptance: real Electron/preload/IPC/settings/components; no CPA or user profile.
// Run after desktop build: node scripts/verify-photo-flow.mjs
// Use --cache-from=<isolated-cache-directory> to repeat UI checks without downloading again.
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite"))("esbuild");
const scratch = mkdtempSync(join(tmpdir(), "photo-flow-acceptance-"));
const cacheFrom = process.argv.find(arg => arg.startsWith("--cache-from="))?.slice("--cache-from=".length);
if (cacheFrom) cpSync(cacheFrom, join(scratch, "profile/photo-flow"), { recursive: true });
const assets = join(desktop, "src/assets/photo-flow");
const fixtureImages = readdirSync(assets).filter(name => name.endsWith(".jpg")).map(name => ({
  id: `bundled-${name}`, src: `data:image/jpeg;base64,${readFileSync(join(assets, name)).toString("base64")}`,
  portrait: name.includes("portrait"), position: "50% 50%",
}));

await build({
  stdin: { resolveDir: desktop, loader: "tsx", contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {ChatPanel} from './src/components/ChatPanel';
    import {SettingsDrawer} from './src/components/SettingsDrawer';
    import {saveSettings} from './src/state/store';
    let settingsOpen = true;
    const root = createRoot(document.getElementById('root'));
    // Hidden offscreen windows otherwise suppress the component's animation.
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
    const frames = new Map(); let next = 0; let time = 0;
    let decoded=0;const decode=Image.prototype.decode;
    Image.prototype.decode=async function(){await decode.call(this);decoded++;};
    window.requestAnimationFrame = fn => { frames.set(++next, fn); return next; };
    window.cancelAnimationFrame = id => frames.delete(id);
    function render() { flushSync(() => root.render(<><ChatPanel onOpenSettings={() => {settingsOpen=true;render();}}/><SettingsDrawer open={settingsOpen} onClose={() => {settingsOpen=false;render();}}/></>)); }
    window.fixture = {
      async start() { await saveSettings({}); render(); },
      settings(open) { settingsOpen = open; render(); },
      async locale(locale) { await saveSettings({locale}); },
      advance(count) { let executed=0;for(let i=0;i<count;i++) {time+=50;const batch=[...frames.values()];frames.clear();batch.forEach(fn=>{executed++;fn(time);});}return executed; },
      saveSettings,
      get decoded(){return decoded;},
    };
  ` },
  outfile: join(scratch, "fixture.js"), bundle: true, platform: "browser", format: "iife",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "bundled-photo-assets", setup(build) {
    build.onLoad({filter: /photo-flow-images\.ts$/}, () => ({contents: `export const PHOTO_FLOW_IMAGES=${JSON.stringify(fixtureImages)};`, loader: "ts"}));
  } }], logLevel: "silent",
});
writeFileSync(join(scratch, "fixture.html"), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>
${readFileSync(join(desktop, "src/styles.css"), "utf8")}
${readFileSync(join(scratch, "fixture.css"), "utf8")}
html,body,#root{height:100%;margin:0}.chat-panel{height:100%}
</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);

await build({
  stdin: { resolveDir: desktop, loader: "ts", contents: `
    import {app,BrowserWindow,ipcMain,nativeImage} from 'electron';
    import {PhotoFlowService} from './electron/main/photo-flow-service';
    import {fetchPhotoFlow} from './electron/main/photo-flow-fetch';
    import {SettingsStore} from './electron/main/settings-store';
    import {registerIpcHandlers} from './electron/main/ipc-handlers';
    import {IPC} from '@claude-desktop/shared';
    import fs from 'node:fs';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    const scratch=${JSON.stringify(scratch)};
    const profile=path.join(scratch,'profile');
    app.setPath('userData',profile);app.disableHardwareAcceleration();
    const report={}; let service; let win;
    const log = value => process.stdout.write(JSON.stringify(value)+'\\n');
    const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
    const evaluate = source => win.webContents.executeJavaScript(source,true);
    const until = async source => {for(let i=0;i<100;i++){if(await evaluate(source))return;await wait(50);}throw new Error('UI wait timed out: '+source);};
    app.whenReady().then(async()=>{
      const settingsDeps={userDataDir:profile,encrypt:s=>s,decrypt:s=>s};
      const settings=new SettingsStore(settingsDeps);
      settings.update({locale:'zh',theme:'light',setupCompleted:true});
      let requests=0;
      const photoDeps={userDataDir:profile,
        fetch:(input,init)=>{requests++;return fetchPhotoFlow(input,init);},
        validateImage:bytes=>{const image=nativeImage.createFromBuffer(bytes);const size=image.getSize();return !image.isEmpty()&&size.width<=600&&size.height<=600;},
        onChanged:()=>win?.webContents.send(IPC.photoFlowUpdated,null),
      };
      service=new PhotoFlowService(photoDeps);service.setEnabled(true);
      log({phase:${JSON.stringify(cacheFrom ? "cached-ui-check" : "live-download")}});
      await service.refreshIfDue();
      const photos=await service.getImages();
      report.live={mode:${JSON.stringify(cacheFrom ? "reused-live-cache" : "fresh-download")},images:photos.length,requests,cache:path.join(profile,'photo-flow')};
      log(report.live);
      service.dispose();service=new PhotoFlowService(photoDeps);service.setEnabled(true);
      const before=requests;await service.refreshIfDue();
      assert.equal(requests,before,'restart must not repeat the download');
      assert.equal((await service.getImages()).length,photos.length);
      report.cacheRestart=true;
      registerIpcHandlers({settings,photoFlow:service,window:()=>win,
        sessions:{},permissions:{},userPrompts:{},cpa:{},diffs:{},snapshots:{},terminal:{},
        onSettingsSynced:()=>win?.webContents.send(IPC.settingsUpdated,settings.getPublic()),
      });
      const stub=(channel,value)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,async()=>value);};
      stub(IPC.cpaModelCatalog,[]);stub(IPC.mcpProbe,{statuses:[]});stub(IPC.skillsList,{userDir:'',projectDir:null,skills:[]});
      win=new BrowserWindow({show:false,width:1100,height:820,webPreferences:{
        preload:${JSON.stringify(join(desktop, "out/preload/index.js"))},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,
      }});
      const errors=[];win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
      await win.loadFile(path.join(scratch,'fixture.html'));
      await evaluate('window.fixture.start()');
      await until('!!document.querySelector("[aria-label=日间照片流]")');
      const placement=await evaluate('(()=>{const p=document.querySelector("[aria-label=日间照片流]");const g=document.querySelector("[aria-label=银河粒子特效]");return {above:!!(p.compareDocumentPosition(g)&Node.DOCUMENT_POSITION_FOLLOWING),checked:p.getAttribute("aria-checked"),flow:!!document.querySelector(".photo-flow")};})()');
      assert.deepEqual(placement,{above:true,checked:'true',flow:true});report.placement=placement;
      await evaluate('document.querySelector("[aria-label=日间照片流]").scrollIntoView({block:"center"})');await wait(100);
      fs.writeFileSync(path.join(scratch,'settings.png'),(await win.webContents.capturePage()).toPNG());
      await evaluate('document.querySelector("[aria-label=日间照片流]").click()');
      await until('!document.querySelector(".photo-flow")');
      assert.equal(new SettingsStore(settingsDeps).getPublic().photoFlowEnabled,false);
      assert.equal(settings.getPublic().galaxyEffectsEnabled,true);
      assert.equal(await evaluate('document.querySelector(".chat-panel").classList.contains("has-photo-flow")'),false);
      assert.deepEqual(await service.getImages(),[]);
      report.switchOffAndPersistence=true;
      await evaluate('document.querySelector("[aria-label=日间照片流]").click()');
      await until('document.querySelector(".photo-flow")?.dataset.active==="true"');
      await evaluate('window.fixture.settings(false)');
      await wait(300);
      const decodedBefore=await evaluate('window.fixture.decoded');
      win.webContents.send(IPC.photoFlowUpdated,null);
      await until('window.fixture.decoded>'+decodedBefore);
      report.cacheUpdateEvent=true;
      report.animationFrames=0;
      for(let i=0;i<40;i++){
        report.animationFrames+=await evaluate('window.fixture.advance(400)');
        await wait(10);
        if(await evaluate('Array.from(document.querySelectorAll(".photo-flow-card img")).some(i=>!!i.title&&Number(i.parentElement.style.opacity)>0.1)'))break;
      }
      assert.ok(report.animationFrames>=400);
      const loaded=await evaluate('Array.from(document.querySelectorAll(".photo-flow-card img")).map(i=>({loaded:i.complete&&i.naturalWidth>0,remote:!!i.title}))');
      assert.ok(loaded.every(i=>i.loaded));
      if(photos.length)assert.ok(loaded.some(i=>i.remote),'cached photos must enter the ribbon');
      report.renderer={loaded:loaded.length,cachedVisible:loaded.filter(i=>i.remote).length};
      fs.writeFileSync(path.join(scratch,'photos.png'),(await win.webContents.capturePage()).toPNG());
      await evaluate('document.documentElement.dataset.theme="dark"');
      await until('document.querySelector(".photo-flow")?.dataset.active==="false"');
      await evaluate('document.documentElement.dataset.theme="light"');
      await until('document.querySelector(".photo-flow")?.dataset.active==="true"');
      report.themeToggle=true;
      await evaluate('window.fixture.locale("en")');await evaluate('window.fixture.settings(true)');
      await until('!!document.querySelector("[aria-label="+JSON.stringify("Daytime photo flow")+"]")');
      report.english=true;
      assert.deepEqual(errors,[]);report.consoleErrors=errors;
      assert.equal(photos.length,12,'live acceptance requires a real batch, not bundled fallback');
      service.dispose();win.destroy();
      fs.writeFileSync(path.join(scratch,'report.json'),JSON.stringify(report,null,2));
      log({result:'passed',scratch,report});app.quit();
    }).catch(error=>{service?.dispose();log({result:'failed',scratch,error:String(error.stack||error),report});app.exit(1);});
    setTimeout(()=>{log({result:'timeout',scratch});app.exit(1);},180000).unref();
  ` },
  outfile: join(scratch, "main.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent",
});
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(scratch, "main.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on("exit", code => { process.exitCode = code ?? 1; });
