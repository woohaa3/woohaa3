import http from 'node:http';
import {afterEach,expect,it} from 'vitest';
import {MediaObjectNotFoundError,type MediaObject,type MediaStorageScope} from '@woohaa3/contracts';
import {createMediaInternalHandler} from './internal-handler.js';
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const f of cleanup.splice(0))await f();});
it('HTTP scope 拒绝；内容寻址存储可幂等读写，错误没有存储副作用',async()=>{
 const objects=new Map<string,MediaObject>();
 const handler=createMediaInternalHandler({identities:{tokens:{'application-service':'app','canvas-service':'canvas'}},storage:{put:async(k,bytes,contentType)=>{objects.set(k,{bytes,contentType});},exists:async k=>objects.has(k),get:async k=>{const value=objects.get(k);if(!value)throw new MediaObjectNotFoundError(k);return value;}}});
 const server=http.createServer((req,res)=>void handler(req,res).then(ok=>{if(!ok)res.end();}));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
 const call=async(action:string,body:unknown,token='app')=>{const res=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/internal/v1/media/${action}`,{method:'POST',headers:{'content-type':'application/json','x-woohaa3-protocol-version':'1','x-woohaa3-service-token':token},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 const body={extensionId:'http-container',bytesBase64:Buffer.from('<html>小游戏</html>').toString('base64'),contentType:'text/html'};
 expect((await call('extension-write',body,'')).status).toBe(401);expect((await call('extension-write',body,'canvas')).status).toBe(403);expect(objects.size).toBe(0);
 const saved=await call('extension-write',body);expect(saved.status).toBe(200);expect((await call('extension-write',body)).body.storageKey).toBe(saved.body.storageKey);expect(objects.size).toBe(1);
 const read=await call('extension-read',{extensionId:'http-container',storageKey:saved.body.storageKey});expect(read.body.bytesBase64).toBe(body.bytesBase64);
 expect((await call('extension-write',{...body,bytesBase64:'!!'})).status).toBe(400);expect(objects.size).toBe(1);
});
it('body.canvasId 变成存储作用域；省略无作用域；非法 id 400 且不写存储',async()=>{
 const objects=new Map<string,MediaObject>();
 const writes:Array<{key:string;scope?:MediaStorageScope}>=[],reads:Array<{key:string;scope?:MediaStorageScope}>=[];let existsCalls=0;
 const handler=createMediaInternalHandler({identities:{tokens:{'application-service':'app','canvas-service':'canvas'}},storage:{
  put:async(k,bytes,contentType,scope)=>{writes.push({key:k,scope});objects.set(k,{bytes,contentType});},
  exists:async(k)=>{existsCalls+=1;return objects.has(k);},
  get:async(k,scope)=>{reads.push({key:k,scope});const value=objects.get(k);if(!value)throw new MediaObjectNotFoundError(k);return value;}}});
 const server=http.createServer((req,res)=>void handler(req,res).then(ok=>{if(!ok)res.end();}));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
 const call=async(action:string,requestBody:unknown)=>{const res=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/internal/v1/media/${action}`,{method:'POST',headers:{'content-type':'application/json','x-woohaa3-protocol-version':'1','x-woohaa3-service-token':'app'},body:JSON.stringify(requestBody)});return {status:res.status,body:await res.json() as Record<string,unknown>};};
 const scoped={extensionId:'http-container',bytesBase64:Buffer.from('<html>画布</html>').toString('base64'),contentType:'text/html',canvasId:'canvas-42'};
 const saved=await call('extension-write',scoped);expect(saved.status).toBe(200);
 expect(writes.at(-1)).toEqual({key:saved.body.storageKey,scope:{canvasId:'canvas-42'}});
 const read=await call('extension-read',{extensionId:'http-container',storageKey:saved.body.storageKey,canvasId:'canvas-42'});
 expect(read.status).toBe(200);expect(reads.at(-1)).toEqual({key:saved.body.storageKey,scope:{canvasId:'canvas-42'}});
 // 省略 canvasId：扩展素材/独立页没有画布作用域，保持旧行为。
 await call('extension-read',{extensionId:'http-container',storageKey:saved.body.storageKey});
 expect(reads.at(-1)?.scope).toBeUndefined();
 // 非法 id 与 verify 同口径：400 malformed-request，且在副作用之前拒绝。
 const before={writes:writes.length,reads:reads.length,exists:existsCalls};
 const rejected=await call('extension-write',{...scoped,canvasId:'../escape'});
 expect(rejected.status).toBe(400);expect(rejected.body.code).toBe('malformed-request');
 expect({writes:writes.length,reads:reads.length,exists:existsCalls}).toEqual(before);
});
