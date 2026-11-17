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
/**
 * 实例登记：宿主监听成功后必须把真实 origin 交给 backend.publishOrigin。
 *
 * 桌面宿主用的是 `listen(0)` 随机端口，外部工具不可能靠扫段找到它（Windows 动态端口段
 * 49152–65535，常规扫描够不着）。所以「登记」不是可选项：不登记 = 那个实例在同机工具眼里
 * 根本不存在。这里钉住两件事：登记发生在监听之后、登记的是真实端口。
 */
test('listening origin is published for instance discovery',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-register-'));
 const published=[];
 try{
  fs.writeFileSync(path.join(dir,'index.html'),'register');
  const runtime=await startDesktopServer({frontendDir:dir,instance:'reg',backend:{readiness:async()=>({ready:true}),handle:async()=>false,close:async()=>{},publishOrigin:origin=>published.push(origin)}});
  assert.equal(published.length,1);
  // 登记的必须是**真实监听地址**：ready 里的 origin 就是它。
  assert.equal(published[0],runtime.ready.origin);
  assert.equal(new URL(published[0]).port, new URL(runtime.ready.origin).port);
  await runtime.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('registration failure does not abort startup',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-register-fail-'));
 try{
  fs.writeFileSync(path.join(dir,'index.html'),'register-fail');
  // 登记只是「让别人找到我」，坏了不该让宿主起不来——画布本身仍可用。
  const runtime=await startDesktopServer({frontendDir:dir,instance:'reg-fail',backend:{readiness:async()=>({ready:true}),handle:async()=>false,close:async()=>{},publishOrigin:()=>{throw new Error('registry down')}}});
  assert.match(runtime.ready.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
  await runtime.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
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
