// Real Electron DOM and real React components with a synthetic room/IPC boundary.
// No peer connection, model invocation, or messages leave this isolated fixture.
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite"))("esbuild");
const scratch = mkdtempSync(join(tmpdir(), "room-chat-acceptance-"));
const sampleMarkdown = "已经整理好本次调整：\n\n- 消息字号、留白与单聊保持一致\n- 保留成员身份和引用回复\n\n下一步检查窄窗口下的展示效果。";

await build({
  stdin: { resolveDir: desktop, loader: "tsx", contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {RoomStage} from './src/components/RoomStage';
    import {Composer} from './src/components/Composer';
    import {MessageList} from './src/components/MessageList';
    import {saveSettings} from './src/state/store';
    import {selectRoom,bindRoomEvents,getRoomState} from './src/state/room-store';
    const room={roomId:'demo',name:'产品设计协作',status:'open',localUserId:'me',hostLabel:'Johnny',port:0,inviteHost:'',
      memberCount:2,onlineCount:2,requireMods:false,modChecksum:'',autoApprove:false,hasPassword:false,encrypt:true,tasks:[],
      members:[{userId:'me',name:'Johnny',role:'host',online:true},{userId:'anna',name:'Anna',role:'member',online:true}],
      seats:[
        {id:'me-seat',kind:'human',name:'Johnny',occupantUserId:'me',sessionId:null,running:false},
        {id:'anna-seat',kind:'human',name:'Anna',occupantUserId:'anna',sessionId:null,running:false},
        {id:'design',kind:'agent',name:'设计助手',occupantUserId:null,sessionId:null,running:false},
        {id:'review',kind:'agent',name:'审核助手',occupantUserId:null,sessionId:null,running:false},
      ],
      items:[
        {id:'u1',kind:'user',seatId:'me-seat',authorUserId:'me',authorLabel:'Johnny',at:1,text:'我们把群聊消息和输入框统一一下。保留成员姓名和头像，让讨论更容易阅读。'},
        {id:'a1',kind:'assistant',seatId:'design',authorLabel:'设计助手',at:2,text:${JSON.stringify(sampleMarkdown)}},
        {id:'u2',kind:'user',seatId:'anna-seat',authorUserId:'anna',authorLabel:'Anna',at:3,text:'引用条可以再紧凑一些，文件直接从左下角的加号添加就好。'},
        {id:'a2',kind:'assistant',seatId:'review',authorLabel:'审核助手',at:4,text:'我会检查深色主题、长消息和附件是否都能正常显示。'},
        {id:'u3',kind:'user',seatId:'me-seat',authorUserId:'me',authorLabel:'Johnny',at:5,text:'就按这个方向继续。',quote:{id:'u2',authorLabel:'Anna',text:'引用条可以再紧凑一些，文件直接从左下角的加号添加就好。'}},
      ]};
    const sent=[]; const callbacks=new Map(); let fileClicks=0;
    const originalClick=HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click=function(){if(this.type==='file'){fileClicks++;return;}originalClick.call(this);};
    let settings={theme:'light',locale:'zh',models:[],defaultModel:'',permissionMode:'default',cpaPort:8317,projects:[],mcpServers:{}};
    window.desktop={
      setSettings:async patch=>Object.assign(settings,patch),getModelCatalog:async()=>[],getRoom:async()=>({room}),
      on:(channel,callback)=>{callbacks.set(channel,callback);return()=>callbacks.delete(channel);},
      getPathForFile:file=>'D:/fixture/'+file.name,
      readAttachment:async path=>({path,name:path.split('/').pop(),size:12,mimeType:'application/pdf',kind:'binary'}),
      sendRoomMessage:async(...args)=>{sent.push(args);return {ok:true};},
    };
    const root=createRoot(document.getElementById('root'));
    const probe=createRoot(document.getElementById('single-probe'));
    window.fixture={
      room,sent,get fileClicks(){return fileClicks;},
      async start(){document.documentElement.style.setProperty('--ui-font-size','13px');await saveSettings({});bindRoomEvents();selectRoom('demo');await new Promise(r=>setTimeout(r,0));
        flushSync(()=>root.render(<RoomStage/>));
        flushSync(()=>probe.render(<><Composer/><MessageList items={[{kind:'text',id:'pu',role:'user',text:'single user'},{kind:'text',id:'pa',role:'assistant',text:${JSON.stringify(sampleMarkdown)}}]}/></>));
      },
      input(value){const input=document.querySelector('.room-input');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,value);input.setSelectionRange(value.length,value.length);input.dispatchEvent(new Event('input',{bubbles:true}));},
      addFile(){const input=document.querySelector('.room-composer input[type=file]');Object.defineProperty(input,'files',{configurable:true,value:[new File(['fixture'],'设计说明.pdf',{type:'application/pdf'})]});input.dispatchEvent(new Event('change',{bubbles:true}));},
      publish(){callbacks.get('room:event')?.({roomId:room.roomId,room,silent:true});},
    };
  ` },
  outfile: join(scratch, "fixture.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
});
writeFileSync(join(scratch, "fixture.html"), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>
${readFileSync(join(desktop, "src/styles.css"), "utf8")}
${readFileSync(join(scratch, "fixture.css"), "utf8")}
html,body,#root{height:100%;margin:0}#single-probe{position:fixed;left:-3000px;top:0;width:760px;pointer-events:none}
</style></head><body><div id="root"></div><div id="single-probe"></div><script src="fixture.js"></script></body></html>`);

writeFileSync(join(scratch, "main.cjs"), `
  const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
  const scratch=${JSON.stringify(scratch)};app.setPath('userData',path.join(scratch,'profile'));app.disableHardwareAcceleration();
  let win;const report={};const errors=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const until=async source=>{for(let i=0;i<100;i++){if(await evaluate(source))return;await wait(30);}throw new Error('UI timeout: '+source);};
  const shot=async name=>fs.writeFileSync(path.join(scratch,name+'.png'),(await win.webContents.capturePage()).toPNG());
  app.whenReady().then(async()=>{
    win=new BrowserWindow({show:false,width:1200,height:880,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
    await win.loadFile(path.join(scratch,'fixture.html'));await evaluate('window.fixture.start()');await wait(150);
    const compare=async()=>evaluate('(()=>{const styles=(selector,keys)=>{const s=getComputedStyle(document.querySelector(selector));return Object.fromEntries(keys.map(k=>[k,s[k]]));};const composerKeys=["backgroundColor","borderRadius","borderColor","padding","gap","boxShadow","backdropFilter"];const textKeys=["fontSize","lineHeight","padding","minHeight","maxHeight"];const bubbleKeys=["fontSize","lineHeight","padding","borderRadius","backgroundColor","boxShadow"];return {composer:[styles("#root .composer",composerKeys),styles("#single-probe .composer",composerKeys)],input:[styles("#root .composer-input",textKeys),styles("#single-probe .composer-input",textKeys)],bubble:[styles("#root .is-me .bubble-user",bubbleKeys),styles("#single-probe .bubble-user",bubbleKeys)],markdown:[styles("#root .room-agent-prose .md-body",["fontSize","lineHeight"]),styles("#single-probe .bubble-assistant .md-body",["fontSize","lineHeight"])]};})()');
    for(const theme of ['light','dark']){
      await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await wait(50);
      const compared=await compare();for(const [key,values]of Object.entries(compared))assert.deepEqual(values[0],values[1],theme+' '+key);
      report[theme+'StyleParity']=true;await shot('group-'+theme);
    }
    await evaluate('document.documentElement.dataset.theme="light"');
    await evaluate('document.querySelector(".room-msg.kind-assistant").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:300,clientY:200}))');
    await until('!!document.querySelector("[role=menuitem]")');
    await evaluate('Array.from(document.querySelectorAll("[role=menuitem]")).find(b=>b.textContent.trim()==="引用").click()');
    await until('!!document.querySelector(".room-quote-bar")');
    await evaluate('window.fixture.input("@设")');await until('!!document.querySelector(".at-menu [role=option]")');
    await evaluate('document.querySelector(".at-menu [role=option]").click()');await wait(50);
    await evaluate('document.querySelector("[aria-label=添加附件]").click();window.fixture.addFile()');
    await until('!!document.querySelector("#root .composer-attachment")');
    assert.equal(await evaluate('window.fixture.fileClicks'),1);
    await wait(100);await shot('group-quote');
    await evaluate('document.querySelector("#root [aria-label=发送]").click()');
    await until('window.fixture.sent.length===1');
    const sent=await evaluate('window.fixture.sent[0]');
    assert.equal(sent[0],'demo');assert.equal(sent[1],'me-seat');assert.equal(sent[3].id,'a1');
    assert.equal(sent[4][0].name,'设计说明.pdf');assert.equal(sent[5][0].seatId,'design');
    report.quoteMentionAttachmentSend=true;
    await until('document.querySelector(".room-input").value===""&&!document.querySelector(".room-quote-bar")');
    for(const width of [780,420]){
      win.setContentSize(width,760);await wait(150);
      await evaluate('window.fixture.input(Array(20).fill("多行输入仍然保留发送按钮").join(String.fromCharCode(10)))');await wait(60);
      const layout=await evaluate('(()=>{const box=document.querySelector(".room-composer-box").getBoundingClientRect();const input=document.querySelector(".room-input");const send=document.querySelector("#root [aria-label=发送]").getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,boxLeft:box.left,boxRight:box.right,inputHeight:input.getBoundingClientRect().height,sendBottom:send.bottom,windowHeight:innerHeight,windowWidth:innerWidth};})()');
      assert.equal(layout.overflow,false);assert.ok(layout.boxLeft>=0&&layout.boxRight<=width);
      assert.ok(layout.inputHeight<=180&&layout.inputHeight>100);assert.ok(layout.sendBottom<=layout.windowHeight);
      report['width'+width]=layout;await shot('group-'+width);
    }
    assert.deepEqual(errors,[]);report.consoleErrors=errors;fs.writeFileSync(path.join(scratch,'report.json'),JSON.stringify(report,null,2));
    process.stdout.write(JSON.stringify({result:'passed',scratch,report})+'\\n');win.destroy();app.quit();
  }).catch(error=>{process.stdout.write(JSON.stringify({result:'failed',scratch,error:String(error.stack||error),errors,report})+'\\n');app.exit(1);});
  setTimeout(()=>app.exit(2),60000).unref();
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(scratch, "main.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on("exit", code => { process.exitCode = code ?? 1; });
