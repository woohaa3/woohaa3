import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { startDesktopServer } from './lib/desktop-host-runtime.mjs';
test('ready follows backend readiness and uses actual allocated port; shutdown drains sockets and closes backend',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-runtime-'));let ready=false,closed=false;
 try{fs.writeFileSync(path.join(dir,'index.html'),'<html>desktop</html>');
 const runtime=await startDesktopServer({frontendDir:dir,instance:'test',backend:{readiness:async()=>{ready=true;return {ready:true};},handle:async(req,res)=>{if(req.url==='/api/test'){res.end('ok');return true;}return false;},close:async()=>{closed=true;}}});
 assert.ok(ready);assert.match(runtime.ready.origin,/^http:\/\/127.0.0.1:\d+$/);assert.equal(await(await fetch(runtime.ready.origin+'/api/test')).text(),'ok');
 assert.equal((await fetch(runtime.ready.origin+'/api/test',{headers:{Origin:'https://evil.test'}})).status,403);
 await runtime.close();assert.ok(closed);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('unready backend cannot publish ready',async()=>{await assert.rejects(()=>startDesktopServer({frontendDir:'/',instance:'test',backend:{readiness:async()=>({ready:false,reason:'broken'}),close:async()=>{}}}),/broken/);});
test('desktop startup needs durable canvas readiness, not configured generation credentials',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-empty-'));try{fs.writeFileSync(path.join(dir,'index.html'),'empty');const runtime=await startDesktopServer({frontendDir:dir,instance:'empty',backend:{modules:()=>({canvas:{readiness:async()=>({ready:true})}}),readiness:async()=>({ready:false,reason:'没有可用的生成 Provider'}),handle:async()=>false,close:async()=>{}}});assert.equal((await fetch(runtime.ready.origin)).status,200);await runtime.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('application exit cancels persisted unfinished tasks before closing database',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-cancel-'));const events=[];let tasks=[{taskKey:'one'},{taskKey:'two'}];try{fs.writeFileSync(path.join(dir,'index.html'),'empty');const runtime=await startDesktopServer({frontendDir:dir,instance:'cancel',backend:{modules:()=>({canvas:{readiness:async()=>({ready:true})},task:{history:()=>({listUnsettled:()=>tasks}),port:()=>({cancel:async key=>{events.push(key);tasks=tasks.filter(t=>t.taskKey!==key);}})}}),handle:async()=>false,close:async()=>events.push('closed')}});await runtime.close();assert.deepEqual(events,['one','two','closed']);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('development origin normalizes the Vite URL trailing slash',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-vite-'));try{fs.writeFileSync(path.join(dir,'index.html'),'dev');const runtime=await startDesktopServer({frontendDir:dir,instance:'dev',devOrigin:'http://127.0.0.1:5174/',backend:{readiness:async()=>({ready:true}),handle:async(req,res)=>{res.end('ok');return true;},close:async()=>{}}});assert.equal((await fetch(runtime.ready.origin,{headers:{Origin:'http://127.0.0.1:5174'}})).status,200);await runtime.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('bound loopback port is published as PORT and BACKEND_PORT',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-port-'));
 const previous={PORT:process.env.PORT,BACKEND_PORT:process.env.BACKEND_PORT};
 const env={PORT:'5180',BACKEND_PORT:'5180'};
 try{
  fs.writeFileSync(path.join(dir,'index.html'),'port');
  const runtime=await startDesktopServer({frontendDir:dir,instance:'port',env,backend:{readiness:async()=>({ready:true}),handle:async()=>false,close:async()=>{}}});
  const port=new URL(runtime.ready.origin).port;
  assert.match(port,/^[1-9]\d*$/);
  assert.equal(env.PORT,port);
  assert.equal(env.BACKEND_PORT,port);
  assert.equal(process.env.PORT,port);
  assert.equal(process.env.BACKEND_PORT,port);
  await runtime.close();
 }finally{
  restoreEnv('PORT',previous.PORT);restoreEnv('BACKEND_PORT',previous.BACKEND_PORT);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
function restoreEnv(key,value){if(value===undefined)delete process.env[key];else process.env[key]=value;}
