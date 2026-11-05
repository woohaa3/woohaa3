// Independent actual frontend remote/session/journal and real HTTP/WebSocket/SQLite/Yjs conversion probes; execute only on a fixed clean delivery.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as c from '../contracts/src/index.ts';
import { worldToCanvasPoint } from '../contracts/src/canvas/model-focus/canvas-projection.ts';
import { worldToRendererPosition } from '../contracts/src/canvas/shared-world.ts';
import { YJS_SYNC_PROTOCOL_VERSION } from '../contracts/src/canvas/yjs/index.ts';
import { createCanvasService } from '../services/canvas-service/src/composition.ts';
import { SqliteCanvasRepository, SqliteYjsRepository } from '../services/canvas-service/src/storage/sqlite/index.ts';
import { IDBFactory } from '../frontend/node_modules/fake-indexeddb/build/esm/index.js';
import WebSocket from '../services/canvas-service/node_modules/ws/wrapper.mjs';
import { createCanvasRemote } from '../frontend/src/cordis/services/canvas-remote.ts';
import { createCanvasSession } from '../frontend/src/cordis/services/canvas-session.ts';
import { createCanvasEditService } from '../frontend/src/cordis/services/canvas-state/store/canvas-edit-service.ts';
import { woohaa3CanvasStore } from '../frontend/src/cordis/services/canvas-state/index.ts';
const TOKEN='main-durable-conversion',SOURCE='scene.box({id:"body",size:[3,4,2]});';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function fixture(){
 const canvas=c.createEmptyWoohaa3ServerCanvas('main-durable-conversion');
 canvas.document.nodes=['a','b','c'].map((id,index)=>({id,type:'model3d',position:{x:120+index*430,y:-220},width:260,height:195}));
 for(const id of ['a','b','c'])canvas.nodeData[id]={...c.defaultSelfContained3DNodeData('model3d'),modelScript:SOURCE,modelScriptVersion:'woohaa-model-js-v2',modelPlacement:{scale:1.7,yaw:35,offset:{x:2,y:-1,z:999}}};
 for(const id of ['a','b','c'])canvas.nodeData[id].modelContentVersion=c.deriveModelContentVersion({modelScript:SOURCE,modelScriptLanguage:'javascript',modelScriptVersion:'woohaa-model-js-v2',placement:canvas.nodeData[id].modelPlacement as any,revision:1});
 return canvas;
}
// Public HTTP and receipt adapters remain provisional until b3 has a fixed commit.
const commitSuffix='world-conversion-commit';
function makeIntent(prepared:any,operationId='main-convert'){
 return {operationId,sourceVersion:prepared.sourceVersion,targets:prepared.nodes.map((node:any)=>({nodeId:node.nodeId,nodeVersion:node.nodeVersion,instanceId:'instance-'+node.nodeId}))};
}
function convert(page:any,ids=['a'],operationId='main-front-convert'){return page.edit.convertWorld({remote:page.remote,canvasId:page.canonical().id,operationId,targets:ids.map(nodeId=>({nodeId,instanceId:'instance-'+nodeId}))});}
function gate(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});return {entered,wait,enter,release};}
function receipt(body:any){return body.receipt;}
function frozen(body:any){const {duplicate,...value}=body;return value;}
function content(canvas:any){return {nodes:canvas.document.nodes,edges:canvas.document.edges,nodeData:canvas.nodeData,assets:canvas.assets,jobs:canvas.jobs};}
function reverseKeys(value:any):any{return Array.isArray(value)?value.map(reverseKeys):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverseKeys(item)])):value;}
async function start(canvas=fixture()){
 const dir=mkdtempSync(path.join(tmpdir(),'woohaa-main-durable-')),file=path.join(dir,'canvas.sqlite');
 let repository:SqliteCanvasRepository,yjs:SqliteYjsRepository,service:Awaited<ReturnType<typeof createCanvasService>>,server:http.Server,port=0,closed=true,seeded=false,fail=false;
 const close=async()=>{if(closed)return;closed=true;await service.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));repository.close();yjs.close();};
 const open=async()=>{
  repository=new SqliteCanvasRepository({path:file});yjs=new SqliteYjsRepository({path:file,failWrites:()=>fail});
  if(!seeded){await repository.createCanvas(canvas);seeded=true;}
  service=await createCanvasService({env:{WOOHAA3_CANVAS_STORAGE_BACKEND:'sqlite',WOOHAA3_CANVAS_STORAGE_SQLITE_PATH:file,WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN:TOKEN},repository,yjsRepository:yjs,mediaClient:{async verify(){throw Error('Unexpected media lookup in asset-free conversion');}}});
  expect(service.worldConversion).toBeTruthy();
  server=http.createServer((req,res)=>{void service.handle(req,res).then(ok=>{if(!ok){res.statusCode=404;res.end();}}).catch(error=>{res.statusCode=500;res.end(String(error));});});
  server.on('upgrade',(req,socket,head)=>{if(!service.sync?.handle(req,socket,head))socket.destroy();});
  await new Promise<void>(resolve=>server.listen(port,'127.0.0.1',resolve));port=(server.address() as any).port;closed=false;
 };
 await open();cleanup.push(async()=>{await close();rmSync(dir,{recursive:true,force:true});});
 const room=()=>service.sync!.registry.resolve(canvas.id);
 const published=async()=>{const result=(await room()).exportCanvas();if(!result.ok)throw Error(result.message);return result.canvas;};
 const post=async(suffix:string,body:unknown,token=TOKEN)=>{const response=await fetch('http://127.0.0.1:'+port+'/api/canvases/'+canvas.id+'/'+suffix,{method:'POST',headers:{'content-type':'application/json','x-woohaa3-service-token':token},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};};
 let command=0;
 const submit=async(commands:any[])=>{const current=await published();return (await room()).submit({protocolVersion:YJS_SYNC_PROTOCOL_VERSION,canvasId:canvas.id,commandId:'main-probe-'+(++command),actorId:'main-review',baseRevision:current.revision,commands});};
 const page=async(options:any={})=>{
  const {beforeFetch,afterFetch,token,...sessionOptions}=options;
  const requests:Array<{url:string;body:any}>=[];
  Object.defineProperty(globalThis,'indexedDB',{value:new IDBFactory(),configurable:true,writable:true});
  class AuthenticatedWebSocket extends WebSocket{constructor(url:string){super(url,{headers:{'x-woohaa3-service-token':TOKEN}});}}
  const remote=createCanvasRemote({canvasId:canvas.id,location:{protocol:'http:',host:'127.0.0.1:'+port},webSocketImpl:AuthenticatedWebSocket as any,fetchImpl:async(input:any,init?:RequestInit)=>{
   const url=String(input);requests.push({url,body:typeof init?.body==='string'?JSON.parse(init.body):null});
   const headers=new Headers(init?.headers);headers.set('x-woohaa3-service-token',token?.(url) ?? TOKEN);
   await beforeFetch?.(url,init);
   const response=await fetch(url.startsWith('/')?'http://127.0.0.1:'+port+url:url,{...init,headers});
   await afterFetch?.(url,response.clone());return response;
  }});
  const session=await createCanvasSession({canvasId:canvas.id,remote,...sessionOptions});
  await expect.poll(()=>session.getStatus().remote.phase,{timeout:8000,interval:20}).toBe('synced');
  const edit=createCanvasEditService({session,getCanvas:()=>woohaa3CanvasStore.getState().canvas});
  cleanup.push(async()=>{edit.clear();session.shutdown();remote.closeCanvasSession();});
  return {remote,session,edit,requests,canonical:()=>woohaa3CanvasStore.getState().canvas};
 };
 return {room,published,post,submit,page,prepare:async(ids=['a'])=>{const result=await post('world-conversion-prepare',{nodeIds:ids});expect(result.status,JSON.stringify(result.body)).toBe(200);return result.body;},commit:(body:unknown)=>post(commitSuffix,body),restart:async()=>{await close();await open();},setWriteFailure:(value:boolean)=>{fail=value;}};
}
describe('independent real frontend transport and edit journal',()=>{
 it('preserves the measured ground projection through HTTP commit and SQLite restart',async()=>{
  const canvas=fixture(),source='scene.box({id:"body",size:[2,3,4],position:[0,1.5,0]});';
  canvas.document.nodes[0]={id:'a',type:'model3d',position:{x:100,y:200},width:240,height:160};
  const placement={scale:2,yaw:90,offset:{x:1,y:2,z:999}};
  canvas.nodeData.a={...canvas.nodeData.a,modelScript:source,modelPlacement:placement,modelContentVersion:c.deriveModelContentVersion({modelScript:source,modelScriptLanguage:'javascript',modelScriptVersion:'woohaa-model-js-v2',placement,revision:1})};
  const f=await start(canvas),prepared=await f.prepare(['a']),node=prepared.nodes[0];
  expect(node.bounds).toEqual({min:[-1,0,-2],max:[1,3,2]});
  const projected=worldToCanvasPoint([...worldToRendererPosition(node.transform.position)]);
  expect(projected.x).toBeCloseTo(284,9);expect(projected.y).toBeCloseTo(272+128*(3*Math.SQRT1_2/2+3*Math.sqrt(3)/2),9);
  expect(node.transform.position.h).toBe(0);expect(node.transform.scale).toBe(2);
  const committed=await f.commit(makeIntent(prepared,'ground-projection'));expect(committed.status).toBe(200);expect(committed.body.receipt.targets[0].transform).toEqual(node.transform);
  await f.restart();expect((await f.published()).nodeData.a.sharedWorldInstance).toMatchObject({transform:node.transform});
 });
 it('connects the production frontend session over real WebSocket and persists a guarded journal undo/redo through SQLite/Yjs',async()=>{
  const f=await start(),page=await f.page(),before=await f.published();expect(page.session.isWritable()).toBe(true);
  const moved=await page.edit.record([{type:'node.update',nodeId:'a',position:{x:222,y:333}}],'main transport move');expect(moved.ok,JSON.stringify(moved)).toBe(true);
  const after=await f.published();expect(after.revision).toBe(before.revision+1);expect(page.canonical()).toEqual(after);expect(page.edit.getSnapshot()).toMatchObject({size:1,canUndo:true,canRedo:false});
  expect((await page.edit.undo()).ok).toBe(true);expect(content(await f.published())).toEqual(content(before));expect(content(page.canonical())).toEqual(content(before));
  await f.restart();await expect.poll(()=>page.session.isWritable(),{timeout:8000,interval:20}).toBe(true);
  expect((await page.edit.redo()).ok).toBe(true);expect(content(await f.published())).toEqual(content(after));expect(content(page.canonical())).toEqual(content(after));
 });
 it('converts via the actual frontend action once, adopts one journal record without replaying forward, and undoes/redoes across real restart',async()=>{
  const f=await start(),page=await f.page(),before=await f.published(),result=await convert(page,['a','b']);expect(result.ok,JSON.stringify(result)).toBe(true);
  const converted=await f.published();expect(converted.revision).toBe(before.revision+1);expect(converted.nodeData.c).toEqual(before.nodeData.c);expect(converted.document.nodes).toEqual(before.document.nodes);expect(page.canonical()).toEqual(converted);
  expect(page.requests.filter((r:any)=>r.url.endsWith('world-conversion-prepare'))).toHaveLength(1);expect(page.requests.filter((r:any)=>r.url.endsWith('world-conversion-commit'))).toHaveLength(1);expect(page.edit.getSnapshot()).toMatchObject({size:1,canUndo:true,canRedo:false,busy:false});
  expect((await page.edit.undo()).ok).toBe(true);expect(content(await f.published())).toEqual(content(before));
  await f.restart();await expect.poll(()=>page.session.isWritable(),{timeout:8000,interval:20}).toBe(true);expect(content(await f.published())).toEqual(content(before));
  expect((await page.edit.redo()).ok).toBe(true);expect(content(await f.published())).toEqual(content(converted));expect(page.edit.getSnapshot()).toMatchObject({size:1,canUndo:true,canRedo:false});
  await f.restart();await expect.poll(()=>page.session.isWritable(),{timeout:8000,interval:20}).toBe(true);expect(content(await f.published())).toEqual(content(converted));expect(content(page.canonical())).toEqual(content(converted));
 });
 it('retries the original intent after server restart and reversed target order without a second journal entry or canonical edit',async()=>{
  const f=await start(),page=await f.page(),first=await convert(page,['a','b'],'same-intent');expect(first.ok,JSON.stringify(first)).toBe(true);const after=await f.published();
  await f.restart();await expect.poll(()=>page.session.isWritable(),{timeout:8000,interval:20}).toBe(true);const retry=await convert(page,['b','a'],'same-intent');expect(retry.ok,JSON.stringify(retry)).toBe(true);expect(await f.published()).toEqual(after);expect(page.edit.getSnapshot().size).toBe(1);
  const prepares=page.requests.filter((r:any)=>r.url.endsWith('world-conversion-prepare')),commits=page.requests.filter((r:any)=>r.url.endsWith('world-conversion-commit'));expect(prepares).toHaveLength(1);expect(commits.length).toBeGreaterThanOrEqual(1);for(const r of commits)expect(r.body).toEqual(commits[0].body);
 });
 it('rejects reuse of an operation identity for different targets without another network request',async()=>{
  const f=await start(),page=await f.page(),first=await convert(page,['a'],'identity-collision');expect(first.ok,JSON.stringify(first)).toBe(true);const before=await f.published(),count=page.requests.length;
  const rejected=await convert(page,['b'],'identity-collision');expect(rejected.ok).toBe(false);expect(page.requests).toHaveLength(count);expect(page.edit.getSnapshot().size).toBe(1);expect(await f.published()).toEqual(before);
 });
 it('keeps the frozen target collection through undo/redo while later unrelated models and scripts change',async()=>{
  const f=await start(),page=await f.page(),first=await convert(page,['a','b']);expect(first.ok,JSON.stringify(first)).toBe(true);const converted=await f.published();
  expect((await f.submit([{type:'node.add',node:{id:'later',type:'model3d',position:{x:40,y:60}},nodeData:{...c.defaultSelfContained3DNodeData('model3d'),modelScript:SOURCE,modelScriptVersion:'woohaa-model-js-v2'}},{type:'nodeData.patch',nodeId:'c',value:{modelScript:'scene.box({id:"changed",size:[6,7,8]});'}}])).ok).toBe(true);
  const unrelated=await f.published();await expect.poll(()=>page.canonical()?.revision).toBe(unrelated.revision);
  expect((await page.edit.undo()).ok).toBe(true);const undone=await f.published();expect(undone.nodeData.a.sharedWorldInstance).toBeUndefined();expect(undone.nodeData.b.sharedWorldInstance).toBeUndefined();expect(undone.nodeData.c).toEqual(unrelated.nodeData.c);expect(undone.nodeData.later).toEqual(unrelated.nodeData.later);
  expect((await page.edit.redo()).ok).toBe(true);const redone=await f.published();expect(redone.nodeData.a).toEqual(converted.nodeData.a);expect(redone.nodeData.b).toEqual(converted.nodeData.b);expect(redone.nodeData.later).toEqual(unrelated.nodeData.later);expect(redone.nodeData.c).toEqual(unrelated.nodeData.c);expect(page.requests.filter((r:any)=>r.url.endsWith('world-conversion-prepare'))).toHaveLength(1);
 });
 it('rejects an entire multi-target journal undo after a real world transform conflict',async()=>{
  const f=await start(),page=await f.page(),result=await convert(page,['a','b']);expect(result.ok,JSON.stringify(result)).toBe(true);const current=await f.published(),instance=structuredClone(current.nodeData.b.sharedWorldInstance) as any;instance.transform.position.h+=3;
  expect((await f.submit([{type:'nodeData.patch',nodeId:'b',value:{sharedWorldInstance:instance}}])).ok).toBe(true);const changed=await f.published();await expect.poll(()=>page.canonical()?.revision).toBe(changed.revision);
  expect((await page.edit.undo()).ok).toBe(false);expect(await f.published()).toEqual(changed);expect(page.edit.getSnapshot().size).toBe(1);
 });
 for(const [name,patch] of [['script',{modelScript:'scene.box({id:"changed",size:[7,8,9]});'}],['placement',{modelPlacement:{scale:2,yaw:90,offset:{x:4,y:5,z:1}}}]] as const)for(const direction of ['undo','redo'] as const)it('rejects multi-target '+direction+' after selected '+name+' changes across SQLite restart',async()=>{
  const f=await start(),page=await f.page(),result=await convert(page,['a','b']);expect(result.ok,JSON.stringify(result)).toBe(true);
  if(direction==='redo')expect((await page.edit.undo()).ok).toBe(true);
  await f.restart();await expect.poll(()=>page.session.isWritable(),{timeout:8000,interval:20}).toBe(true);
  expect((await f.submit([{type:'nodeData.patch',nodeId:'b',value:patch}])).ok).toBe(true);
  const changed=await f.published();await expect.poll(()=>page.canonical()?.revision).toBe(changed.revision);
  expect((await page.edit[direction]()).ok).toBe(false);expect(await f.published()).toEqual(changed);
  expect(page.edit.getSnapshot().size).toBe(1);
  expect(page.requests.filter((r:any)=>r.url.endsWith('world-conversion-prepare'))).toHaveLength(1);
 });
 for(const [name,patch] of [['script',{modelScript:'scene.box({id:"changed",size:[7,8,9]});'}],['placement',{modelPlacement:{scale:2,yaw:90,offset:{x:4,y:5,z:1}}}]] as const)it('reports a real '+name+' source conflict between frontend prepare and commit without adopting history',async()=>{
  const f=await start();let changed=false;const page=await f.page({beforeFetch:async(url:string)=>{if(url.endsWith('world-conversion-commit')&&!changed){changed=true;expect((await f.submit([{type:'nodeData.patch',nodeId:'b',value:patch}])).ok).toBe(true);}}});
  const result=await convert(page,['a','b']);expect(result.ok).toBe(false);expect(page.edit.getSnapshot()).toMatchObject({size:0,busy:false});const after=await f.published();expect(after.nodeData.a.sharedWorldInstance).toBeUndefined();expect(after.nodeData.b.sharedWorldInstance).toBeUndefined();expect(changed).toBe(true);
 });
 it('keeps prior redo after a genuine SQLite failure and can then adopt a successful retry once',async()=>{
  const f=await start(),page=await f.page();expect((await page.edit.record([{type:'node.update',nodeId:'c',position:{x:888,y:777}}],'earlier card move')).ok).toBe(true);expect((await page.edit.undo()).ok).toBe(true);expect(page.edit.getSnapshot()).toMatchObject({size:1,canRedo:true});
  const before=await f.published();f.setWriteFailure(true);const rejected=await convert(page,['a','b'],'storage-retry');expect(rejected.ok).toBe(false);expect(await f.published()).toEqual(before);expect(page.edit.getSnapshot()).toMatchObject({size:1,canRedo:true,busy:false});
  f.setWriteFailure(false);const accepted=await convert(page,['a','b'],'storage-retry');expect(accepted.ok,JSON.stringify(accepted)).toBe(true);expect((await f.published()).revision).toBe(before.revision+1);expect(page.edit.getSnapshot()).toMatchObject({size:1,canRedo:false,canUndo:true});
 });
 it('rejects conversion in a genuinely readonly frontend session before prepare/commit and leaves history empty',async()=>{
  const f=await start(),page=await f.page({access:{canRead:true,canWrite:false}}),before=await f.published(),count=page.requests.length;expect(page.session.isWritable()).toBe(false);
  const result=await convert(page);expect(result.ok).toBe(false);expect(page.requests).toHaveLength(count);expect(page.edit.getSnapshot().size).toBe(0);expect(await f.published()).toEqual(before);
 });
 it('keeps busy ownership when other edit actions are refused during a real conversion response',async()=>{
  const f=await start(),pause=gate(),page=await f.page({afterFetch:async(url:string)=>{if(url.endsWith('world-conversion-commit')){pause.enter();await pause.wait;}}});cleanup.push(async()=>{pause.release();});
  let applied:unknown; page.edit.recordParameter({label:'parameter',nodeId:'c',modelKey:'model',before:{value:1},after:{value:2},apply:(value:unknown)=>{applied=value;}});
  const converting=convert(page,['a'],'busy-operation');await pause.entered;expect(page.edit.getSnapshot().busy).toBe(true);const count=page.requests.length;
  expect((await convert(page,['b'],'blocked-convert')).ok).toBe(false);expect((await page.edit.undo()).ok).toBe(false);expect((await page.edit.record([{type:'node.update',nodeId:'c',position:{x:100,y:200}}],'blocked record')).ok).toBe(false);
  page.edit.recordParameter({label:'blocked',nodeId:'c',modelKey:'model',before:{value:2},after:{value:3},apply:()=>{throw Error('busy applier installed');}});
  expect(page.requests).toHaveLength(count);expect(page.edit.getSnapshot().busy).toBe(true);pause.release();const result=await converting;expect(result.ok,JSON.stringify(result)).toBe(true);expect(page.edit.getSnapshot()).toMatchObject({size:2,busy:false});
  expect((await page.edit.undo()).ok).toBe(true);expect((await page.edit.undo()).ok).toBe(true);expect(applied).toEqual({value:1});
 });
 for(const stage of ['prepare','commit'])it('clears the page during actual '+stage+' response without adopting a stale journal record',async()=>{
  const f=await start(),pause=gate(),page=await f.page({afterFetch:async(url:string)=>{if(url.endsWith('world-conversion-'+stage)){pause.enter();await pause.wait;}}});cleanup.push(async()=>{pause.release();});
  const converting=convert(page,['a','b'],'clear-'+stage);await pause.entered;page.edit.clear();pause.release();expect((await converting).ok).toBe(false);expect(page.edit.getSnapshot()).toMatchObject({size:0,busy:false});
  if(stage==='prepare'){expect(page.requests.filter((r:any)=>r.url.endsWith('world-conversion-commit'))).toHaveLength(0);expect((await f.published()).nodeData.a.sharedWorldInstance).toBeUndefined();}
 });
 it('ignores an old conversion response after a real replacement canvas session has synchronized',async()=>{
  const f=await start(),pause=gate(),page=await f.page({afterFetch:async(url:string)=>{if(url.endsWith('world-conversion-commit')){pause.enter();await pause.wait;}}});cleanup.push(async()=>{pause.release();});
  const converting=convert(page,['a'],'old-page');await pause.entered;page.edit.clear();page.session.shutdown();const next=fixture();next.id='different-real-canvas';const other=await start(next),replacement=await other.page(),before=await other.published();
  pause.release();expect((await converting).ok).toBe(false);expect(page.edit.getSnapshot().size).toBe(0);expect(replacement.edit.getSnapshot().size).toBe(0);expect(replacement.canonical()).toEqual(before);expect(await other.published()).toEqual(before);
 });
 it('recovers a genuinely persisted conversion after an injected lost HTTP response without running prepare or forward twice',async()=>{
  const f=await start();let lost=false,deny=false,deniedStatus=0;const page=await f.page({token:(url:string)=>deny&&url.endsWith('world-conversion-commit')?'invalid-token':TOKEN,afterFetch:async(url:string,response:Response)=>{if(url.endsWith('world-conversion-commit')&&deny)deniedStatus=response.status;if(url.endsWith('world-conversion-commit')&&!lost){lost=true;throw Error('main probe injected response loss after actual durable HTTP success');}}});
  const first=await convert(page,['a','b'],'lost-response');expect(first.ok).toBe(false);const persisted=await f.published();expect(persisted.nodeData.a.sharedWorldInstance).toBeTruthy();expect(page.edit.getSnapshot().size).toBe(0);await expect.poll(()=>page.canonical()?.revision).toBe(persisted.revision);
  deny=true;expect((await convert(page,['a','b'],'lost-response')).ok).toBe(false);deny=false;expect(deniedStatus).toBe(401);
  const retry=await convert(page,['a','b'],'lost-response');expect(retry.ok,JSON.stringify(retry)).toBe(true);expect(await f.published()).toEqual(persisted);expect(page.edit.getSnapshot().size).toBe(1);expect(page.requests.filter((r:any)=>r.url.endsWith('world-conversion-prepare'))).toHaveLength(1);
  const commits=page.requests.filter((r:any)=>r.url.endsWith('world-conversion-commit'));expect(commits).toHaveLength(3);expect(commits[1].body).toEqual(commits[0].body);expect(commits[2].body).toEqual(commits[0].body);
 });
 it('does not adopt a receipt after the actual canonical instance has already changed',async()=>{
  const f=await start();let changed=false;const page=await f.page({afterFetch:async(url:string)=>{if(url.endsWith('world-conversion-commit')&&!changed){changed=true;const current=await f.published(),instance=structuredClone(current.nodeData.a.sharedWorldInstance) as any;instance.transform.position.h+=10;expect((await f.submit([{type:'nodeData.patch',nodeId:'a',value:{sharedWorldInstance:instance}}])).ok).toBe(true);const after=await f.published();await expect.poll(()=>page.canonical()?.revision).toBe(after.revision);}}});
  const result=await convert(page,['a'],'changed-before-adopt');expect(result.ok).toBe(false);expect(page.edit.getSnapshot()).toMatchObject({size:0,busy:false});expect(changed).toBe(true);expect((await f.published()).nodeData.a.sharedWorldInstance).toMatchObject({transform:{position:{h:10}}});
 });

});
