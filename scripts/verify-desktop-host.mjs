#!/usr/bin/env node
/** Real isolated bundle smoke. No source imports, no system Node in child PATH. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {createInterface} from 'node:readline';import assert from 'node:assert/strict';
import {systemTarExec,installedHostLayout,isolatedHostEnvironment} from './lib/desktop-platform-commands.mjs';
const app=path.resolve(process.argv.slice(2).filter(arg=>arg!=='--')[0]??(process.platform==='win32'?'desktop/target/release':'desktop/target/debug/bundle/macos/WooHaa3.app'));
const work=fs.mkdtempSync(path.join(os.tmpdir(),'woohaa-bundle-smoke-'));const root=path.join(work,'runtime'),data=path.join(work,'data');fs.mkdirSync(root);fs.mkdirSync(data);
const {node,archive}=installedHostLayout(app);
systemTarExec(['-xzf',archive,'-C',root],{windowsHide:true});
const log=fs.openSync(path.join(work,'host.log'),'a');const env=isolatedHostEnvironment(work);
for(const name of ['TEMP','APPDATA','LOCALAPPDATA'])if(env[name])fs.mkdirSync(env[name],{recursive:true});
const sqliteProbe=execFileSync(node,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');db.exec('create table smoke (id integer)');db.close();console.log(process.versions.node)"],{env,cwd:work,encoding:'utf8',windowsHide:true});assert.equal(Number(sqliteProbe.trim().split('.')[0]),24,'bundled host requires Node 24');
let child;
async function start(){
 child=spawn(node,[path.join(root,'desktop-host.mjs'),'--resource-root',root,'--data-dir',data,'--instance','smoke'],{cwd:work,env,windowsHide:true,stdio:['pipe','pipe',log]});
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('ready timeout')),60_000);const input=createInterface({input:child.stdout});input.on('line',line=>{const message=JSON.parse(line);if(message.type==='ready'){clearTimeout(timer);resolve(message.origin);}else if(message.type==='error'){clearTimeout(timer);reject(new Error(message.message));}});child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error(`host exit ${code}`));});});
}
async function stop(){const process=child;child=null;if(!process||process.exitCode!==null)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{process.kill();reject(new Error('stop timeout'));},60_000);process.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`stop exit ${code}`));});process.stdin.end('{"type":"shutdown"}\n');});}
async function request(origin,url,options){const response=await fetch(origin+url,options);const body=await response.text();assert.ok(response.ok,`${response.status} ${body}`);return JSON.parse(body);}
try{
 let origin=await start();assert.equal((await fetch(origin)).status,200);assert.equal((await fetch(origin+'/health/ready')).status,200);
 const canvasId='bundle-smoke';const created=await request(origin,'/api/canvases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({canvasId,title:'独立安装包验收'})});assert.equal(created.revision,1);
 const settings=await request(origin,'/api/settings');assert.ok(settings);
 await new Promise((resolve,reject)=>{const socket=new WebSocket(origin.replace('http:','ws:')+`/api/canvases/${canvasId}/sync?sessionProtocolVersion=1`);const timer=setTimeout(()=>{socket.close();reject(new Error('WS timeout'));},10_000);socket.addEventListener('open',()=>{clearTimeout(timer);socket.close();resolve();});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('WS failed'));});});
 await stop();origin=await start();const persisted=await request(origin,`/api/canvases/${canvasId}`);assert.ok(JSON.stringify(persisted).includes('独立安装包验收'));await stop();
 const handoff=path.join(work,'handoff.woohaa');execFileSync(node,[path.join(root,'desktop-host.mjs'),'--resource-root',root,'--data-dir',data,'--export',handoff],{env,cwd:work,windowsHide:true,stdio:['ignore','pipe',log]});
 const imported=path.join(work,'imported');execFileSync(node,[path.join(root,'desktop-host.mjs'),'--resource-root',root,'--data-dir',imported,'--import',handoff],{env,cwd:work,windowsHide:true,stdio:['ignore','pipe',log]});
 assert.ok(fs.existsSync(path.join(imported,'stores/canvas.sqlite')));
 // Open restored SQLite through the actual host, then restart it once more.
 fs.renameSync(data,path.join(work,'original-data'));fs.renameSync(imported,data);
 origin=await start();assert.ok(JSON.stringify(await request(origin,`/api/canvases/${canvasId}`)).includes('独立安装包验收'));await stop();
 console.log(JSON.stringify({ok:true,app,work,checks:['node24-sqlite','isolated-node','frontend','health','canvas-create','websocket','settings','restart-persistence','graceful-exit','export-import']},null,2));
}finally{try{await stop();}finally{fs.closeSync(log);}}
