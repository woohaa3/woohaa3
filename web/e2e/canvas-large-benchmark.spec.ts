// Real-app, hardware-only benchmark. Raw attempts remain even when assertions fail.
import { chromium, type Page } from "@playwright/test";
import { openReviewBrowser, test, expect } from "./review-browser.js";
import { reviewBaseHost } from "./review-target.js";
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createPng,attachImageAssets} from '../../scripts/canvas-benchmark/media.mjs';
import {generateFixture} from '../../scripts/canvas-benchmark/fixture.mjs';
import {summarize} from '../../scripts/canvas-benchmark/statistics.mjs';
import {seedYjsCanvas,waitForCanvasSession} from './helpers.js';
import {createModel3DNodeData, model3DNodeDataFields} from '@woohaa3/contracts';
const exec=promisify(execFile);
const OUT=resolve(process.env.BENCH_OUT??'../artifacts/canvas-benchmark');
const CELLS=JSON.parse(process.env.BENCH_CELLS??'[{"nodes":1000,"visible":24,"round":0,"kind":"text"}]');
const SAMPLING=process.env.BENCH_SAMPLING!=='off';
const DURATION=Number(process.env.BENCH_PHASE_MS??10_000);
const WARMUP=Number(process.env.BENCH_WARMUP_MS??10_000);
const LABEL=process.env.BENCH_LABEL??'baseline';
const HARNESS_VERSION='canonical-observed-v2';
const INPUT_MS=Number(process.env.BENCH_INPUT_MS??32);
const ZOOM_INPUT_MS=Number(process.env.BENCH_ZOOM_INPUT_MS??INPUT_MS);
const ONLY_PHASE=process.env.BENCH_ONLY_PHASE;
if(!Number.isFinite(INPUT_MS)||INPUT_MS<16)throw new Error('BENCH_INPUT_MS must be finite and at least 16');
if(!Number.isFinite(ZOOM_INPUT_MS)||ZOOM_INPUT_MS<16)throw new Error('BENCH_ZOOM_INPUT_MS must be finite and at least 16');
if(ONLY_PHASE!==undefined&&ONLY_PHASE!=='zoom')throw new Error('BENCH_ONLY_PHASE supports zoom only');
const SCENARIO_SUFFIX=(INPUT_MS===32&&!ONLY_PHASE?'':`-input${INPUT_MS}ms-phase${ONLY_PHASE??'all'}`)+(ZOOM_INPUT_MS===INPUT_MS?'':`-zoomInput${ZOOM_INPUT_MS}ms`);
const json=(file:string,value:unknown)=>writeFileSync(file,JSON.stringify(value,null,2));
const jsonl=(file:string,values:unknown[])=>writeFileSync(file,values.map(v=>JSON.stringify(v)).join('\n')+'\n');

async function instrument(page:Page){
 await page.addInitScript(()=>{
  const w=window as any;
  w.__bench={byEvent:new WeakMap(),events:[],longtasks:[],raf:[],active:false,visibility:[]};
  document.addEventListener('visibilitychange',()=>{if(w.__bench.active) w.__bench.visibility.push({at:performance.now(),state:document.visibilityState});});
  const original=EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener=function(type:string,listener:any,options:any){
   if(listener && (this as Element).id==='bevy-canvas' && ['pointerdown','pointermove','pointerup','wheel'].includes(type)){
    const wrapped=(event:Event)=>{const start=performance.now();try{typeof listener==='function'?listener.call(this,event):listener.handleEvent(event);}finally{
     if(w.__bench.active){const ms=performance.now()-start;const old=w.__bench.byEvent.get(event);if(old){old.handlerMs+=ms;old.end=performance.now();old.viewport=w.__canvasViewport?.();}else{const entry={type,start,end:performance.now(),handlerMs:ms,viewport:w.__canvasViewport?.()};w.__bench.byEvent.set(event,entry);w.__bench.events.push(entry);}}}};
    return original.call(this,type,wrapped,options);
   }
   return original.call(this,type,listener,options);
  } as any;
  try{new PerformanceObserver(list=>{if(w.__bench.active)for(const e of list.getEntries())w.__bench.longtasks.push({at:e.startTime,duration:e.duration});}).observe({entryTypes:['longtask']});}catch{}
  const tick=(at:number)=>{if(w.__bench.active){w.__bench.raf.push(at);const raw=w.__bevyRuntime?.rawHealth?.();if(raw)w.__bench.observations.push({at:performance.now(),health:JSON.parse(raw),viewport:w.__bevyRuntime.lastScene()?.viewport,generation:w.__bevyRuntime.interactionGeneration()});}requestAnimationFrame(tick);}; requestAnimationFrame(tick);
 });
}
async function snapshot(page:Page){return page.evaluate(()=>{
 const w=window as any;const scene=w.__bevyRuntime?.lastScene?.(),v=scene?.viewport,rect=document.querySelector('#bevy-canvas')?.getBoundingClientRect();
 const visible=new Set<string>(),fullyVisible=new Set<string>();
 if(scene&&v&&rect)for(const n of scene.nodes){const left=n.x*v.zoom+v.x,top=n.y*v.zoom+v.y,right=left+n.width*v.zoom,bottom=top+n.height*v.zoom;if(left<rect.width&&right>0&&top<rect.height&&bottom>0)visible.add(n.id);if(left>=0&&right<=rect.width&&top>=0&&bottom<=rect.height)fullyVisible.add(n.id);}
 const edges=scene?.edges??[];
 return {visibleCount:scene?visible.size:null,fullyVisibleCount:scene?fullyVisible.size:null,partiallyVisibleCount:scene?visible.size-fullyVisible.size:null,canonicalNodeTotal:w.__canvasCanonical?.document?.nodes?.length??null,canonicalEdgeTotal:w.__canvasCanonical?.document?.edges?.length??null,edgeTotal:edges.length,edgesBothEndpointsVisible:edges.filter((e:any)=>visible.has(e.source)&&visible.has(e.target)).length,edgesAtLeastOneEndpointVisible:edges.filter((e:any)=>visible.has(e.source)||visible.has(e.target)).length,edgeVisibilityDefinition:'accepted scene endpoint node rectangle intersections; not Bezier pixel culling',acceptedViewport:v,interactionGeneration:w.__bevyRuntime?.interactionGeneration?.(),at:performance.now(),counters:w.__canvasSceneDiagnostics?.snapshot(),health:JSON.parse(w.__bevyRuntime?.rawHealth?.()??'null'),residency:w.__canvasResidency?.snapshot(),work:w.__bevyRuntime?.getWorkDiagnostics?.(),
  viewport:w.__canvasViewport?.(),heap:(performance as any).memory?{used:(performance as any).memory.usedJSHeapSize,total:(performance as any).memory.totalJSHeapSize}:null,
  renderError:w.__canvasRenderError?.(),issues:w.__bevyRuntime?.runtimeIssues?.()};
});}
async function phase(page:Page,name:string,action:()=>Promise<unknown>,dir:string,verify?:(effect:any)=>Promise<any>){
 const before=await snapshot(page);
 await page.evaluate((enabled)=>{const w=window as any;w.__bench.byEvent=new WeakMap();w.__bench.events=[];w.__bench.longtasks=[];w.__bench.raf=[];w.__bench.observations=[];w.__bench.visibility=[];w.__bench.schedule=[];w.__bevyRuntime.benchmarkFrames(enabled);w.__bevyRuntime.benchmarkMedia(true);w.__bench.active=true;},SAMPLING);
 const begin=Date.now();let failure:string|null=null;
 let effect:unknown=null;try{effect=await action();}catch(e){failure=String(e);}
 const raw=await page.evaluate(()=>{const w=window as any;w.__bench.active=false;const frames=JSON.parse(w.__bevyRuntime.benchmarkFrames());w.__bevyRuntime.benchmarkFrames(false);w.__bevyRuntime.benchmarkMedia(false);return {...w.__bench,frames};});
 const after=await snapshot(page);
 const sampledElapsedMs=Date.now()-begin;
 let verification:any=null;
 if(verify&&effect){try{verification=await verify(effect);if(verification.failure)failure=failure??verification.failure;}catch(error){failure=failure??String(error);verification={status:'verification-error',failure:String(error)};}}
 jsonl(resolve(dir,`${name}-frames.jsonl`),raw.frames.frames);jsonl(resolve(dir,`${name}-events.jsonl`),raw.events);
 json(resolve(dir,`${name}-raw.json`),{...raw,frames:undefined,before,after,effect,verification});
 const intervals=raw.frames.frames.slice(1).map((f:any,i:number)=>f.atMs-raw.frames.frames[i].atMs);
 const delta:Record<string,number>={};for(const key of Object.keys(before.counters??{})){if(typeof before.counters[key]==='number'&&typeof after.counters?.[key]==='number')delta[key]=after.counters[key]-before.counters[key];}
 const elapsedMs=sampledElapsedMs;
 const observedLatencies:number[]=[];let coalesced=0;
 if(['pan','zoom','after-locate'].includes(name))for(const event of raw.events){
  if(!event.viewport||!['wheel','pointermove'].includes(event.type))continue;
  const v=event.viewport;
  const match=raw.observations.find((o:any)=>o.at>=event.end&&o.viewport&&Math.abs(o.viewport.x-v.x)<.01&&Math.abs(o.viewport.y-v.y)<.01&&Math.abs(o.viewport.zoom-v.zoom)<.00001&&o.health.appliedGeneration>=o.generation);
  if(match)observedLatencies.push(match.at-event.start);else coalesced++;
 }
 const result={name,elapsedMs,failure,effect,verification,inputToObservedApplied:summarize(observedLatencies),coalescedInputs:coalesced,inputLatencyDefinition:'input to first browser RAF observation of matching accepted viewport and Bevy applied generation; upper-bound observation, not presentation',quality:raw.frames.dropped?'overflow':raw.visibility.length?'hidden':failure?'failed':SAMPLING&&raw.frames.frames.length<2?'no-frames':'valid',dropped:raw.frames.dropped,
  browserRafInterval:summarize(raw.raf.slice(1).map((at:number,i:number)=>at-raw.raf[i])),sampling:SAMPLING,renderInterval:summarize(intervals),renderFrames:raw.frames.frames.length,
  completedFps:intervals.length?1000*intervals.length/(raw.frames.frames.at(-1).atMs-raw.frames.frames[0].atMs):null,
  over33:intervals.length?intervals.filter((v:number)=>v>33.333).length/intervals.length:null,
  handler:summarize(raw.events.map((e:any)=>e.handlerMs)),handlersByType:Object.fromEntries(['pointerdown','pointermove','pointerup','wheel'].map(type=>[type,summarize(raw.events.filter((e:any)=>e.type===type).map((e:any)=>e.handlerMs))])),schedule:{events:raw.schedule?.length??0,late:summarize((raw.schedule??[]).map((s:any)=>s.lateMs))},longtaskCount:raw.longtasks.length,longtaskMs:raw.longtasks.reduce((s:number,e:any)=>s+e.duration,0),delta,before,after};
 json(resolve(dir,`${name}-summary.json`),result);return result;
}
async function resetViewport(page:Page){await page.evaluate(()=>{const w=window as any;w.__canvasSetSelection([]);w.__canvasPanTo(w.__benchInitialViewport??{x:0,y:0,zoom:1},0);});await page.waitForTimeout(1000);}
async function motion(page:Page,kind:string,ms:number){
 const cadence=kind==='zoom'?ZOOM_INPUT_MS:INPUT_MS;
 const initial=await page.evaluate(()=>{const w=window as any;const node=w.__canvasCanonical.document.nodes[0],state=w.__canvasStoreState?.();return {viewport:w.__canvasViewport(),targetId:node.id,node,working:(state?.working??state?.canvas)?.document.nodes.find((n:any)=>n.id===node.id),canonicalRevision:w.__canvasCanonical.revision};});
 const box=(await page.locator('#bevy-canvas').boundingBox())!;
 const cx=box.x+box.width*.5,cy=box.y+box.height*.5;
 let x=cx,y=cy;
 if(kind==='drag'){
  const pt=await page.evaluate(()=>{const w=window as any;const n=w.__bevyRuntime.lastScene().nodes.find((n:any)=>n.id===w.__canvasCanonical.document.nodes[0].id),v=w.__canvasViewport();const r=document.querySelector('#bevy-canvas')!.getBoundingClientRect();return {x:r.left+n.x*v.zoom+v.x+Math.min(50,n.width*v.zoom/2),y:r.top+n.y*v.zoom+v.y+Math.min(20,n.height*v.zoom/2)};}); x=pt.x;y=pt.y;
 }
 await page.mouse.move(x,y);
 if(kind==='pan') await page.mouse.down({button:'middle'});
 if(kind==='drag') await page.mouse.down();
 const start=Date.now();const schedule=[];
 for(let i=0;Date.now()-start<ms;i++){
  const due=start+i*cadence;const delay=due-Date.now();if(delay>0)await page.waitForTimeout(delay);
  const actual=Date.now();schedule.push({due:due-start,actual:actual-start,lateMs:Math.max(0,actual-due)});
  // Wall-clock phase: never catch up by compressing the queued events.
  if(kind==='zoom')await page.mouse.wheel(0,i%2?-25:25);
  else await page.mouse.move(x+Math.sin((actual-start)/600)*80,y+Math.sin((actual-start)/900)*35);
  if(Date.now()-start>i*cadence+2*cadence) { // skip missed slots; preserve actual schedule
   i=Math.floor((Date.now()-start)/cadence);
  }
 }
 if(kind==='pan')await page.mouse.up({button:'middle'});if(kind==='drag')await page.mouse.up();
 const releasedAt=Date.now();
 await page.evaluate(schedule=>{(window as any).__bench.schedule=schedule;},schedule);
 if(kind!=='drag')await page.waitForTimeout(150);
 const final=await page.evaluate(()=>{const w=window as any;const v=w.__bench.events.map((e:any)=>e.viewport).filter(Boolean),node=w.__canvasCanonical.document.nodes[0],state=w.__canvasStoreState?.();return {viewport:w.__canvasViewport(),node,working:(state?.working??state?.canvas)?.document.nodes.find((n:any)=>n.id===node.id),canonicalRevision:w.__canvasCanonical.revision,selection:w.__canvasSelection?.(),zooms:v.map((p:any)=>p.zoom),events:w.__bench.events.length};});
 expect(final.events,'gesture reached canvas listeners').toBeGreaterThan(0);
 if(kind==='pan')expect(Math.hypot(final.viewport.x-initial.viewport.x,final.viewport.y-initial.viewport.y),'pan changed viewport').toBeGreaterThan(1);
 if(kind==='zoom')expect(Math.max(...final.zooms)-Math.min(...final.zooms),'wheel changed zoom').toBeGreaterThan(.001);
 // Canonical acknowledgement is verified after phase sampling has stopped.
 return {initial,final:{...final,zooms:undefined},releasedAt,inputIntervalMs:cadence,scheduledEvents:schedule.length,expectedEvents:Math.floor(ms/cadence),late:summarize(schedule.map(s=>s.lateMs))};
}
async function verifyDragCanonical(page:Page,effect:any){
 const started=Date.now();
 const evidence=await page.evaluate(async({id,position})=>{
  const w=window as any,start=performance.now();const observations:any[]=[];
  const read=()=>{const state=w.__canvasStoreState?.();const canonical=w.__canvasCanonical?.document.nodes.find((n:any)=>n.id===id),working=(state?.working??state?.canvas)?.document.nodes.find((n:any)=>n.id===id);return {atMs:performance.now()-start,canonicalPosition:canonical?.position??null,workingPosition:working?.position??null,canonicalRevision:w.__canvasCanonical?.revision,selection:w.__canvasSelection?.(),session:w.__canvasSessionStatus};};
  let current=read();observations.push(current);
  const changed=()=>current.canonicalPosition&&Math.hypot(current.canonicalPosition.x-position.x,current.canonicalPosition.y-position.y)>1;
  while(!changed()&&performance.now()-start<10000){await new Promise(r=>setTimeout(r,100));current=read();observations.push(current);}
  return {targetId:id,status:changed()?'observed':'timeout',initialPosition:position,observations,final:current,failure:changed()?null:'drag target canonical position was not observed to change within 10000ms'};
 },{id:effect.initial.targetId,position:effect.initial.node.position});
 return {...evidence,verificationWaitMs:Date.now()-started,releaseToObservedMs:Date.now()-effect.releasedAt,timingDefinition:'canonical acknowledgement wait after continuous-input sampling stopped; excluded from phase FPS'};
}

async function locate(page:Page,id:string){
 return page.evaluate(async(id)=>{
  const w=window as any;const start=performance.now();const result=w.__canvasLocate([id]);const handlerMs=performance.now()-start;
  if(!result.ok)return {id,result,handlerMs,status:'rejected'};
  let arrivedAt:number|null=null,interactiveAt:number|null=null,mediaAt:number|null=null,finishGeneration:number|null=null;
  const until=performance.now()+10000;
  while(performance.now()<until){
   await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
   const scene=w.__bevyRuntime.lastScene();const node=scene?.nodes.find((n:any)=>n.id===id);if(!node)continue;
   const v=w.__canvasViewport();const surface=document.querySelector('#bevy-canvas')!.getBoundingClientRect();
   const x=node.x*v.zoom+v.x+node.width*v.zoom/2,y=node.y*v.zoom+v.y+node.height*v.zoom/2;
   const accepted=scene.viewport;
   if(x<0||x>surface.width||y<0||y>surface.height)continue;
   // Require animation and accepted viewport to reach their final center.
   if(Math.abs(x-surface.width/2)>3||Math.abs(y-surface.height/2)>3)continue;
   if(Math.abs(accepted.x-v.x)>0.1||Math.abs(accepted.y-v.y)>0.1)continue;
   const generation=w.__bevyRuntime.interactionGeneration();const h=JSON.parse(w.__bevyRuntime.rawHealth());
   if(h.renderedGeneration<generation)continue;
   if(arrivedAt===null){arrivedAt=performance.now()-start;finishGeneration=generation;}
   const hit=w.__bevyRuntime.queryPoint({x:node.x+node.width/2,y:node.y+Math.min(20,node.height/2),zoom:v.zoom});
   if(JSON.stringify(hit).includes(id)&&interactiveAt===null)interactiveAt=performance.now()-start;
   const canonical=w.__canvasCanonical.document.nodes.find((n:any)=>n.id===id);
   const isModel=canonical?.type==='model3d',isImage=canonical?.type==='image';
   const mediaReady=isModel?JSON.parse(w.__bevyRuntime.benchmarkMedia()??'{}').readyModels?.includes(id):isImage?node.texture&&!node.mediaLoading:true;
   if(interactiveAt!==null&&mediaReady){mediaAt=performance.now()-start;break;}
  }
  return {id,result,handlerMs,arrivedMs:arrivedAt,interactiveMs:interactiveAt,mediaReadyMs:mediaAt,generation:finishGeneration,status:interactiveAt===null?'timeout':mediaAt===null?'media-timeout':'ok'};
 },id);
}

for(const cell of CELLS){test(`N${cell.nodes}-V${cell.visible}-${cell.kind??'text'}-r${cell.round}`,async({},info)=>{
 if(cell.quick)test.setTimeout(85_000);else if(cell.visualProbe)test.setTimeout(360_000);
 const browser=await openReviewBrowser(chromium,{headless:false,args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,baseURL:`http://${reviewBaseHost}:${process.env.BENCH_PORT??4397}`});
 const page=await context.newPage();
 let profileSession:any=null,profileTimer:any=null,profileData:any=null;
 if(process.env.BENCH_PROFILE==='1'){
  profileSession=await context.newCDPSession(page);await profileSession.send('Profiler.enable');if(!cell.quick)await profileSession.send('Profiler.start');
  if(!cell.quick)profileTimer=setTimeout(()=>{void profileSession.send('Profiler.stop').then((data:any)=>{profileData=data;json(resolve(dir,'startup.cpuprofile'),data.profile);}).catch(()=>{});},15000);
 }
 const runId=`${LABEL}-n${cell.nodes}-v${cell.visible}-${cell.kind??'text'}-r${cell.round}-${Date.now()}`;
 const dir=resolve(OUT,runId);mkdirSync(dir,{recursive:true});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
 const systemSamples:any[]=[];
 const sampleSystem=async()=>{try{const [vm,swap,ps]=await Promise.all([exec('/usr/bin/vm_stat',[],{timeout:2000}),exec('/usr/sbin/sysctl',['vm.swapusage'],{timeout:2000}),exec('/bin/ps',['-axo','pid,ppid,pcpu,rss,comm'],{timeout:2000})]);systemSamples.push({at:new Date().toISOString(),load:os.loadavg(),freeMemory:os.freemem(),cpus:os.cpus().map(c=>c.times),vm:vm.stdout,swap:swap.stdout,processes:ps.stdout.split('\n').filter(l=>/Chrome for Testing|node|WindowServer/.test(l))});}catch(error){systemSamples.push({at:new Date().toISOString(),unavailable:String(error)});}};
 await sampleSystem();let sampling=false;const systemTimer=setInterval(()=>{if(!sampling){sampling=true;void sampleSystem().finally(()=>sampling=false);}},5000);
 let result:any={runId,attemptKey:process.env.BENCH_ATTEMPT_KEY??null,cell,label:LABEL,status:'partial',started:new Date().toISOString(),phases:[],errors};
 try{
  let fixture=generateFixture({nodes:cell.nodes,visible:cell.visible,seed:42,edgesPerNode:cell.edges??0,layout:cell.layout});
  if(cell.kind?.startsWith('image')){
   const shared=cell.kind==='image-shared';const uploads=[];
   for(let i=0;i<(shared?1:2*cell.visible);i++){
    const bytes=createPng({size:cell.imageSize??1024,seed:42+i});
    const upload=await page.request.post('/api/media',{data:bytes,headers:{'content-type':'image/png'}});
    expect(upload.status(),await upload.text()).toBe(201);const body=await upload.json();
    uploads.push({storageKey:body.storageKey,url:body.url,bytes,width:cell.imageSize??1024,height:cell.imageSize??1024});
   }
   fixture=attachImageAssets(fixture,uploads,{shared});
  }
  if(cell.kind?.startsWith('model'))for(const n of fixture.canvas.document.nodes.slice(0,2*cell.visible).filter((_:unknown,i:number)=>i%cell.visible<(cell.mediaCount??cell.visible))){n.type='model3d';fixture.canvas.nodeData[n.id]=model3DNodeDataFields(createModel3DNodeData({title:n.id,model:{modelScript:`scene.box({id:"body",size:[1,2,.5],color:"${cell.kind==='model-unique'?'#'+(0x2080aa+fixture.canvas.document.nodes.indexOf(n)*137).toString(16).padStart(6,'0'):'#2888dd'}"});scene.sphere({id:"top",position:[0,1.5,0],radius:.5,color:"#ffaa33"});`,modelScriptVersion:"woohaa-model-js-v2"}}));}
  fixture.manifest.kind=cell.kind??'text';fixture.manifest.hash=createHash('sha256').update(JSON.stringify(fixture.canvas)).digest('hex');
  json(resolve(dir,'manifest.json'),fixture.manifest);
  await instrument(page);await page.addInitScript(viewport=>{(window as any).__benchInitialViewport=viewport;},fixture.manifest.initialViewport??{x:0,y:0,zoom:1});await seedYjsCanvas(page,'woohaa3-default-canvas',[],{canvas:fixture.canvas});
  const start=Date.now();await page.goto('/');await waitForCanvasSession(page);
  await page.waitForFunction(()=> (window as any).__bevyRuntime?.isReady?.() && (window as any).__canvasLocate,null,{timeout:90000});
  const cdp=await browser.newBrowserCDPSession();const sys=await cdp.send('SystemInfo.getInfo');await cdp.detach();
  const gpu=await page.evaluate(async()=>{const adapter=await (navigator as any).gpu?.requestAdapter();return adapter?{info:{vendor:adapter.info?.vendor,architecture:adapter.info?.architecture,device:adapter.info?.device,description:adapter.info?.description},fallback:adapter.info?.isFallbackAdapter??adapter.isFallbackAdapter}:null;});
  json(resolve(dir,'gpu.json'),{sys,gpu,browser:browser.version()});
  result.metadata={harnessVersion:HARNESS_VERSION,fixtureHash:fixture.manifest.hash,scenario:`${cell.quick?'quick-profile-':''}${cell.kind??'text'}-n${cell.nodes}-v${cell.visible}-e${cell.edges??0}-layout${cell.layout??'legacy'}-initialzoom${fixture.manifest.initialViewport?.zoom??1}-visualProbe${Boolean(cell.visualProbe)}-harness${HARNESS_VERSION}${SCENARIO_SUFFIX}`,layout:cell.layout??null,initialViewport:fixture.manifest.initialViewport??{x:0,y:0,zoom:1},visualProbe:Boolean(cell.visualProbe),visualProbeDefinition:'screenshots plus viewport/generation checks; readability and LOD require visual assessment',inputIntervalMs:INPUT_MS,zoomInputIntervalMs:ZOOM_INPUT_MS,onlyPhase:ONLY_PHASE??null,gpu:sys.gpu.devices,browser:browser.version(),viewport:{width:1440,height:900},devicePixelRatio:1,buildMode:'performance',buildId:process.env.BENCH_BUILD_ID??'unspecified',sampleDurationMs:DURATION,warmupMs:WARMUP,sampling:SAMPLING};
  expect(JSON.stringify(sys.gpu.devices)).not.toMatch(/swiftshader|llvmpipe|lavapipe/i);expect(gpu).not.toBeNull();expect(gpu?.fallback).not.toBe(true);
  result.frameMetric='Bevy RenderSystems::PostCleanup schedule completion; not GPU presentation';
  result.loadToRuntimeMs=Date.now()-start;
  for(let i=0;i<3;i++){await page.keyboard.press('Escape');await page.waitForTimeout(150);}
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await resetViewport(page);
  await page.waitForFunction((n)=>{const w=window as any;return w.__bevyRuntime.lastScene()?.nodes.length===n && JSON.parse(w.__bevyRuntime.rawHealth()).renderedGeneration>=w.__bevyRuntime.interactionGeneration();},cell.nodes,{timeout:90000});
  await page.waitForTimeout(WARMUP);
  if(!cell.quick)await page.waitForFunction(()=>{const w=window as any;const r=w.__canvasResidency?.snapshot();return (!r||r.channels.every((c:any)=>!(c.inFlight||c.pending||c.draining))) && !w.__canvasRenderError?.();},null,{timeout:60000});
  result.ready=await snapshot(page);
  expect(result.ready.visibleCount,'initial intersecting node count').toBe(cell.visible);
  if(cell.layout==='fit-grid')expect(result.ready.fullyVisibleCount,'initial fully visible node count').toBe(cell.visible);
  expect(result.ready.canonicalEdgeTotal,'canonical import preserves fixture edges').toBe(fixture.canvas.document.edges.length);
  expect(result.ready.edgeTotal,'accepted scene contains canonical edges').toBe(fixture.canvas.document.edges.length);
  result.loadToReadyMs=Date.now()-start;
  if(profileSession&&profileData){await profileSession.send('Profiler.start');profileTimer=setTimeout(()=>{void profileSession.send('Profiler.stop').then((data:any)=>json(resolve(dir,'steady.cpuprofile'),data.profile)).catch(()=>{});},15000);}
  await page.screenshot({path:resolve(dir,'origin.png')});
  if(cell.visualProbe)await page.screenshot({path:resolve(dir,'overview.png')});
  if(cell.nodes>0){const point=await page.evaluate(()=>{const w=window as any;const n=w.__bevyRuntime.lastScene().nodes[0],v=w.__canvasViewport(),r=document.querySelector('#bevy-canvas')!.getBoundingClientRect();return {id:n.id,x:r.left+n.x*v.zoom+v.x+Math.min(50,n.width*v.zoom/2),y:r.top+n.y*v.zoom+v.y+Math.min(20,n.height*v.zoom/2)};});
  await page.mouse.click(point.x,point.y);
  await expect.poll(()=>page.evaluate(()=> (window as any).__canvasSelection().nodeIds)).toContain(point.id);}
  await resetViewport(page);
  for(const name of (cell.quick?['idle','pan','drag','hover']:ONLY_PHASE?[ONLY_PHASE]:cell.nodes?['idle','pan','zoom','drag','hover']:['idle','pan','zoom','hover'])){
   await resetViewport(page);
   if(cell.quick&&profileSession)await profileSession.send('Profiler.start');
   result.phases.push(await phase(page,name,()=>name==='idle'?page.waitForTimeout(DURATION):motion(page,name,DURATION),dir,name==='drag'?(effect)=>verifyDragCanonical(page,effect):undefined));
   if(cell.quick&&profileSession){const data=await profileSession.send('Profiler.stop');json(resolve(dir,`${name}.cpuprofile`),data.profile);}
   if(name==='drag'){
    const dragPhase=result.phases.at(-1);
    const targetId=dragPhase.effect?.initial.targetId;
    if(!targetId)throw new Error('drag target missing; refusing to restore an unverified target');
    const original=fixture.canvas.document.nodes.find((n:any)=>n.id===targetId)!;
    await page.evaluate(({id,position})=>{const w=window as any;const result=w.__canvasSubmitCommands([{type:'node.update',nodeId:id,position}]);if(!result.ok)throw new Error('restore failed: '+result.reason);},{id:original.id,position:original.position});
    await expect.poll(()=>page.evaluate(id=>(window as any).__canvasCanonical.document.nodes.find((n:any)=>n.id===id).position,original.id)).toEqual(original.position);
    await page.waitForTimeout(1000);
   }
   json(resolve(dir,'run.json'),result);
  }
  if(cell.visualProbe&&cell.nodes>0&&!ONLY_PHASE){
   await resetViewport(page);
   const overview=fixture.manifest.initialViewport??{x:0,y:0,zoom:1};
   const anchor=await page.evaluate(index=>{const w=window as any,n=w.__bevyRuntime.lastScene().nodes[index],v=w.__canvasViewport(),r=document.querySelector('#bevy-canvas')!.getBoundingClientRect();return {nodeId:n.id,x:r.left+(n.x+n.width/2)*v.zoom+v.x,y:r.top+(n.y+n.height/2)*v.zoom+v.y,canvas:{left:r.left,top:r.top,width:r.width,height:r.height}};},Math.min(cell.nodes-1,Math.floor(Math.ceil(cell.visible/20)/2)*20+10));
   expect(anchor.x).toBeGreaterThan(anchor.canvas.left+40);expect(anchor.x).toBeLessThan(anchor.canvas.left+anchor.canvas.width-40);
   expect(anchor.y).toBeGreaterThan(anchor.canvas.top+40);expect(anchor.y).toBeLessThan(anchor.canvas.top+anchor.canvas.height-40);
   const ticks=Math.round(Math.log(1/overview.zoom)/Math.log(1.1));
   expect(ticks,'overview must need zoom-in wheel ticks').toBeGreaterThan(0);
   const detailZoom=overview.zoom*1.1**ticks;
   expect(Math.abs(detailZoom-1),'real wheel detail zoom near 1').toBeLessThan(.02);
   const wheelTransition=async(target:'details'|'overview',cycle:number)=>{
    const transitionStart=Date.now(),schedule:any[]=[];let previousDispatch:number|null=null;
    await page.mouse.move(anchor.x,anchor.y);
    const start=Date.now(); // Positioning is setup, not lateness of every wheel tick.
    for(let i=0;i<ticks;i++){
     const planned=start+i*64,due=Math.max(planned,previousDispatch===null?planned:previousDispatch+64);
     const delay=due-Date.now();if(delay>0)await new Promise<void>(done=>setTimeout(done,delay));
     const dispatch=Date.now();previousDispatch=dispatch;
     const row={cycle,target,tick:i,due:planned-start,actual:dispatch-start,lateMs:Math.max(0,dispatch-planned),inputIntervalMs:64};schedule.push(row);
     // Preserve dispatch evidence even if a later input or settling assertion fails.
     try{await page.mouse.wheel(0,target==='details'?-100:100);}finally{await page.evaluate(row=>{(window as any).__bench.schedule.push(row);},row);}
    }
    const dispatchElapsedMs=Date.now()-start,expectedZoom=target==='details'?detailZoom:overview.zoom;
    await page.waitForFunction(zoom=>{const w=window as any,s=w.__bevyRuntime.lastScene(),v=w.__canvasViewport(),h=JSON.parse(w.__bevyRuntime.rawHealth());return s&&Math.abs(v.zoom-zoom)<.0001&&Math.abs(s.viewport.zoom-v.zoom)<.00001&&Math.abs(s.viewport.x-v.x)<.01&&Math.abs(s.viewport.y-v.y)<.01&&h.renderedGeneration>=w.__bevyRuntime.interactionGeneration();},expectedZoom,{timeout:30000});
    const after=await snapshot(page);
    expect(after.viewport.zoom).toBeCloseTo(expectedZoom,4);
    return {cycle,target,anchor,expectedZoom,inputIntervalMs:64,expectedEvents:ticks,scheduledEvents:schedule.length,schedule,pointerPositionMs:start-transitionStart,dispatchElapsedMs,eventFlowAndRenderedSettleMs:Date.now()-transitionStart,timingDefinition:'wall-clock pointer positioning and real wheel dispatch through matching accepted viewport and rendered generation; dispatch lateness starts after pointer positioning; not GPU presentation or isolated input latency',snapshot:after};
   };
   result.phases.push(await phase(page,'details-zoom',async()=>{const observation=await wheelTransition('details',0);await page.screenshot({path:resolve(dir,'details.png')});return observation;},dir));
   result.phases.push(await phase(page,'details-idle',()=>page.waitForTimeout(DURATION),dir));
   result.phases.push(await phase(page,'overview-detail-roundtrip',async()=>{const observations=[];observations.push(await wheelTransition('overview',-1));for(let i=0;i<3;i++){observations.push(await wheelTransition('details',i));observations.push(await wheelTransition('overview',i));}return {method:'real mouse wheel ±100, fixed screen anchor, 1.1 zoom steps',observations,inputIntervalMs:64,expectedEvents:ticks*7,scheduledEvents:observations.reduce((sum,o)=>sum+o.scheduledEvents,0)};},dir));
   // Verify the actual final wheel return before any exact/programmatic reset.
   result.roundtripWheelOverview=await snapshot(page);
   await page.screenshot({path:resolve(dir,'roundtrip-overview.png')});
   expect(result.roundtripWheelOverview.viewport.zoom).toBeCloseTo(overview.zoom,4);
   expect(Math.abs(result.roundtripWheelOverview.acceptedViewport.x-overview.x),'wheel return x drift').toBeLessThanOrEqual(.2);
   expect(Math.abs(result.roundtripWheelOverview.acceptedViewport.y-overview.y),'wheel return y drift').toBeLessThanOrEqual(.2);
   expect(result.roundtripWheelOverview.visibleCount).toBe(cell.visible);
   if(cell.layout==='fit-grid')expect(result.roundtripWheelOverview.fullyVisibleCount).toBe(cell.visible);
   expect(result.roundtripWheelOverview.edgeTotal).toBe(fixture.canvas.document.edges.length);
   expect(result.roundtripWheelOverview.edgesBothEndpointsVisible).toBe(result.ready.edgesBothEndpointsVisible);
   const roundtripHit=await page.evaluate(id=>{const w=window as any,n=w.__bevyRuntime.lastScene().nodes.find((n:any)=>n.id===id),v=w.__canvasViewport(),r=document.querySelector('#bevy-canvas')!.getBoundingClientRect();const world={x:n.x+n.width/2,y:n.y+Math.min(20,n.height/2),zoom:v.zoom};return {id,world,hit:w.__bevyRuntime.queryPoint(world),x:r.left+world.x*v.zoom+v.x,y:r.top+world.y*v.zoom+v.y};},anchor.nodeId);
   result.roundtripHit=roundtripHit;
   expect(JSON.stringify(roundtripHit.hit),'Rust hit after real wheel roundtrip').toContain(anchor.nodeId);
   await page.mouse.click(roundtripHit.x,roundtripHit.y);
   await expect.poll(()=>page.evaluate(()=> (window as any).__canvasSelection().nodeIds)).toContain(anchor.nodeId);
   result.roundtripSelection=await page.evaluate(()=> (window as any).__canvasSelection());
   json(resolve(dir,'run.json'),result);
  }
  if(cell.nodes>0&&!ONLY_PHASE&&!cell.quick){await resetViewport(page);
  const ids=[fixture.targets.distant[0],fixture.targets.origin[0],fixture.targets.distant[0],fixture.targets.origin[0],fixture.targets.distant[0],fixture.targets.origin[0]];
  const locates:any[]=[];
  result.phases.push(await phase(page,'locate',async()=>{for(const id of ids){locates.push(await locate(page,id));await page.waitForTimeout(500);}},dir));
  json(resolve(dir,'locates.json'),locates);result.locates=locates;
  await page.screenshot({path:resolve(dir,'located.png')});
  result.phases.push(await phase(page,'after-locate',()=>motion(page,'pan',5000),dir));
  const rapid=await page.evaluate(async(ids)=>{const w=window as any;const rows=[];for(const id of ids){const start=performance.now();rows.push({id,result:w.__canvasLocate([id]),handlerMs:performance.now()-start});await new Promise(r=>setTimeout(r,200));}return rows;},[fixture.targets.distant[0],fixture.targets.origin[0],fixture.targets.distant[0]]);
  await page.waitForTimeout(1500);json(resolve(dir,'rapid-locates.json'),{rapid,final:await snapshot(page)});
  result.locateOk=locates.every(l=>l.status==='ok');}
  result.status=(result.locateOk??true)&&!errors.length&&result.phases.every((p:any)=>p.quality==='valid')?'completed':'completed-with-errors';
  expect(result.status,JSON.stringify({errors,phases:result.phases.map((p:any)=>({name:p.name,quality:p.quality,failure:p.failure})),locates:result.locates})).toBe('completed');
 }catch(e){result.status='failed';result.failure=String(e);throw e;}finally{
  clearInterval(systemTimer);clearTimeout(profileTimer);if(profileData)json(resolve(dir,'startup.cpuprofile'),profileData.profile);await sampleSystem();json(resolve(dir,'system.json'),systemSamples);
  result.ended=new Date().toISOString();result.errors=errors;try{json(resolve(dir,'run.json'),result);}finally{await browser.close();}
 }
});}
