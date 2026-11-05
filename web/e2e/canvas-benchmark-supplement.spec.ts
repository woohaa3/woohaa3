// Supplemental probes use the real app and hardware runtime. No online generation.
import { chromium, type Browser, type Page } from "@playwright/test";
import { openReviewBrowser, test, expect } from "./review-browser.js";
import { reviewBaseHost } from "./review-target.js";
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {generateFixture} from '../../scripts/canvas-benchmark/fixture.mjs';
import {summarize} from '../../scripts/canvas-benchmark/statistics.mjs';
import {createModel3DNodeData,model3DNodeDataFields,computeCenteredViewport,nodeWorldRect,unionRects} from '@woohaa3/contracts';
import {seedYjsCanvas,waitForCanvasSession} from './helpers.js';

const CASE=process.env.BENCH_SUPPLEMENT;
if(!CASE||!['distance','selection','residency','cache-state'].includes(CASE)) throw new Error('BENCH_SUPPLEMENT must be distance|selection|residency|cache-state');
const json=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2));
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot(page:Page){return page.evaluate(()=>{
 const w=window as any;const parse=(x:any)=>typeof x==='string'?JSON.parse(x):x;
 return {at:performance.now(),viewport:w.__canvasViewport?.(),health:parse(w.__bevyRuntime?.rawHealth?.()),generation:w.__bevyRuntime?.interactionGeneration?.(),media:parse(w.__bevyRuntime?.benchmarkMedia?.()),residency:w.__canvasResidency?.snapshot(),scene:w.__canvasSceneDiagnostics?.snapshot(),work:parse(w.__bevyRuntime?.getWorkDiagnostics?.()),heap:(performance as any).memory?{used:(performance as any).memory.usedJSHeapSize,total:(performance as any).memory.totalJSHeapSize}:null,renderError:w.__canvasRenderError?.(),visibility:document.visibilityState};
});}
async function settle(page:Page){await page.waitForFunction(()=>{const w=window as any;return JSON.parse(w.__bevyRuntime.rawHealth()).renderedGeneration>=w.__bevyRuntime.interactionGeneration();},null,{timeout:30000});}
async function reset(page:Page){await page.evaluate(()=>{const w=window as any;w.__canvasSetSelection([]);w.__canvasPanTo({x:0,y:0,zoom:1},0);});await page.waitForTimeout(500);await settle(page);}
async function submit(page:Page,commands:any[]){
 const started=Date.now();const receipt=await page.evaluate(async commands=>{
  const w=window as any,start=performance.now(),result=w.__canvasSubmitCommands(commands),handlerMs=performance.now()-start;
  if(!result.ok)return {result,handlerMs,applicationObservedMs:null};
  for(let frame=0;performance.now()-start<30000;frame++){
   await new Promise<void>(r=>requestAnimationFrame(()=>r()));
   const canvas=w.__canvasCanonical;
   const reflected=commands.every(c=>{
    if(c.type==='node.update'){const n=canvas.document.nodes.find((n:any)=>n.id===c.nodeId);return n&&(!c.position||(n.position.x===c.position.x&&n.position.y===c.position.y));}
    if(c.type==='nodeData.patch')return Object.entries(c.value).every(([key,value])=>canvas.nodeData[c.nodeId]?.[key]===value);
    return false;
   });
   const health=JSON.parse(w.__bevyRuntime.rawHealth());
   if(frame>=2&&reflected&&health.renderedGeneration>=w.__bevyRuntime.interactionGeneration())return {result,handlerMs,applicationObservedMs:performance.now()-start};
  }
  throw new Error('Command canonical/render application observation timed out');
 },commands);
 expect(receipt.result.ok,JSON.stringify(receipt.result)).toBe(true);return {...receipt,renderObservedMs:Date.now()-started};
}
/** Browser RAF observation of a stable accepted viewport and rendered generation, never GPU presentation. */
async function locate(page:Page,ids:string[],models:string[]=[],expectedSelection?:string){
 // Compute the destination before timing; this is an independent geometry check,
 // not an acknowledgement that any partially visible node is an arrived target.
 const state=await page.evaluate(()=>{const w=window as any,r=document.querySelector('#bevy-canvas')!.getBoundingClientRect();return {canvas:w.__canvasCanonical,viewport:w.__canvasViewport(),size:{width:r.width,height:r.height}};});
 const byId=new Map<string,any>(state.canvas.document.nodes.map((n:any)=>[n.id,n]));
 const targets=ids.map(id=>byId.get(id));
 const bounds=targets.every(Boolean)?unionRects(targets.map(n=>nodeWorldRect(n,byId))):null;
 const expectedViewport=bounds?computeCenteredViewport({bounds,hostSize:state.size,zoom:state.viewport.zoom}):null;
 return page.evaluate(async({ids,models,expectedSelection,expectedViewport})=>{
  const w=window as any,start=performance.now(),result=w.__canvasLocate(ids),handlerMs=performance.now()-start;
  if(!result.ok)return {ids,result,handlerMs,status:'rejected'};
  let arrivedMs:number|null=null,readyMs:number|null=null,stable=0,previous='';let health:any=null,ready:string[]=[];
  while(performance.now()-start<30000){
   await new Promise<void>(r=>requestAnimationFrame(()=>r()));
   const runtime=w.__bevyRuntime,v=w.__canvasViewport(),scene=runtime.lastScene(),rect=document.querySelector('#bevy-canvas')!.getBoundingClientRect();
   health=JSON.parse(runtime.rawHealth());ready=JSON.parse(runtime.benchmarkMedia()??'{}').readyModels??[];
   const visibleIds=expectedSelection?[expectedSelection]:ids;
   const visible=visibleIds.every(id=>{const n=scene?.nodes.find((n:any)=>n.id===id);if(!n)return false;const x=n.x*v.zoom+v.x,y=n.y*v.zoom+v.y;return x+n.width*v.zoom>0&&x<rect.width&&y+n.height*v.zoom>0&&y<rect.height;});
   const key=JSON.stringify(v);stable=key===previous?stable+1:0;previous=key;
   const applied=scene&&Math.abs(scene.viewport.x-v.x)<.1&&Math.abs(scene.viewport.y-v.y)<.1&&health.renderedGeneration>=runtime.interactionGeneration();
   const centered=expectedViewport&&Math.abs(v.x-expectedViewport.x)<1&&Math.abs(v.y-expectedViewport.y)<1&&Math.abs(v.zoom-expectedViewport.zoom)<.001;
   if(performance.now()-start>100&&visible&&applied&&centered&&stable>=3){
    if(arrivedMs===null)arrivedMs=performance.now()-start;
    if(models.every(id=>ready.includes(id))){readyMs=performance.now()-start;break;}
   }
  }
  return {ids,result,handlerMs,arrivedMs,modelReadyMs:readyMs,status:readyMs===null?'timeout':'ok',readyModels:ready,health,expectedViewport,finalViewport:w.__canvasViewport(),selection:w.__canvasSelection().nodeIds};
 },{ids,models,expectedSelection,expectedViewport});
}

for(const kind of ['distance','selection','residency','cache-state'])test(`supplement-${kind}`,async()=>{
 test.skip(CASE!==kind,'Select exactly one probe with BENCH_SUPPLEMENT');
 const round=Number(process.env.BENCH_ROUND??0),runId=`supplement-${kind}-r${round}-${Date.now()}`;
 const dir=resolve(process.env.BENCH_OUT??'../artifacts/canvas-benchmark',runId);mkdirSync(dir,{recursive:true});
 const result:any={runId,attemptKey:process.env.BENCH_ATTEMPT_KEY??null,label:process.env.BENCH_LABEL??'supplement',cell:{kind,round,nodes:1000,visible:kind==='selection'?100:24},status:'partial',started:new Date().toISOString(),env:{port:process.env.BENCH_PORT??4398,buildId:process.env.BENCH_BUILD_ID??null},phases:[],locates:[],raw:[],errors:[],latencyDefinition:'browser RAF stable accepted viewport and rendered-generation acknowledgement; not GPU presentation'};
 let browser:Browser|null=null,page:Page|null=null;
 async function checkpoint(){json(resolve(dir,'run.json'),result);}
 async function phase(name:string,action:()=>Promise<unknown>){
  const before=await snapshot(page!),started=Date.now();let effect:unknown=null,failure:string|null=null;
  try{effect=await action();}catch(error){failure=String(error);throw error;}finally{result.phases.push({name,before,after:await snapshot(page!).catch(()=>null),elapsedMs:Date.now()-started,effect,failure});await checkpoint();}
 }
 try{
  const fixture:any=generateFixture({nodes:1000,visible:kind==='selection'?100:24});
  const nodes=fixture.canvas.document.nodes;
  if(kind==='distance')for(let i=0;i<3;i++)nodes[24+i].position={x:[1,10,100][i]*1440+100,y:140};
  const regions:string[][]=[];const modelRegions:string[][]=[];
  if(kind==='residency')for(let region=0;region<3;region++){
   const ids:string[]=[],models:string[]=[];
   for(let local=0;local<24;local++){
    const i=region*24+local,n=nodes[i];n.position={x:100+region*20000+(local%6)*200,y:140+Math.floor(local/6)*150};ids.push(n.id);
    if(local<12){models.push(n.id);n.type='model3d';const color='#'+(0x2070a0+i*1937).toString(16).padStart(6,'0');fixture.canvas.nodeData[n.id]=model3DNodeDataFields(createModel3DNodeData({title:n.id,model:{modelScript:`scene.box({id:"body-${i}",size:[1,2,.5],color:"${color}"});scene.sphere({id:"top-${i}",position:[0,1.5,0],radius:.5,color:"#ffaa33"});`,modelScriptVersion:'woohaa-model-js-v2'}}));}
   }
   regions.push(ids);modelRegions.push(models);
  }
  if(kind==='cache-state')for(const i of [0,24]){
   const n=nodes[i];n.type='model3d';
   fixture.canvas.nodeData[n.id]=model3DNodeDataFields(createModel3DNodeData({title:n.id,model:{modelScript:`scene.box({id:"cache-body-${i}",size:[1,2,.5],color:"${i===0?'#2877cc':'#cc7728'}"});scene.sphere({id:"cache-top-${i}",position:[0,1.5,0],radius:.5,color:"#ffaa33"});`,modelScriptVersion:'woohaa-model-js-v2'}}));
  }
  if(kind==='cache-state')fixture.manifest.modelCount=2;
  fixture.manifest.kind=`supplement-${kind}`;fixture.manifest.hash=digest(fixture.canvas);result.manifest=fixture.manifest;json(resolve(dir,'manifest.json'),fixture.manifest);
  browser=await openReviewBrowser(chromium,{headless:false,args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,baseURL:`http://${reviewBaseHost}:${process.env.BENCH_PORT??4398}`});page=await context.newPage();
  page.on('pageerror',error=>result.errors.push(String(error)));
  await seedYjsCanvas(page,'woohaa3-default-canvas',[],{canvas:fixture.canvas});await page.goto('/');await waitForCanvasSession(page);
  await page.waitForFunction(()=>{const w=window as any;return w.__bevyRuntime?.isReady?.()&&w.__canvasLocate&&w.__canvasSubmitCommands;},null,{timeout:90000});
  for(let i=0;i<3;i++){await page.keyboard.press('Escape');await page.waitForTimeout(150);}await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await page.evaluate(()=>{(window as any).__bevyRuntime.benchmarkMedia(true);});await reset(page);
  const cdp=await browser.newBrowserCDPSession();const system=await cdp.send('SystemInfo.getInfo');await cdp.detach();
  result.env={...result.env,browser:browser.version(),gpu:system.gpu.devices,viewport:{width:1440,height:900},devicePixelRatio:1};
  expect(JSON.stringify(system.gpu.devices)).not.toMatch(/swiftshader|llvmpipe|lavapipe/i);
  const gpu=await page.evaluate(async()=>{const a=await(navigator as any).gpu?.requestAdapter();return a?{fallback:a.info?.isFallbackAdapter??a.isFallbackAdapter}:null;});expect(gpu).not.toBeNull();expect(gpu?.fallback).not.toBe(true);
  await page.waitForTimeout(2500);
  if(kind==='distance'){
   // Distances are exact surface widths, set after discovering the actual canvas surface.
   const width=await page.locator('#bevy-canvas').evaluate(el=>el.getBoundingClientRect().width);
   await submit(page,[1,10,100].map((distance,i)=>({type:'node.update',nodeId:nodes[24+i].id,position:{x:100+distance*width,y:140}})));
   result.cell.surfaceWidth=width;
   for(let visit=0;visit<2;visit++)for(let i=0;i<3;i++)await phase(`locate-${[1,10,100][i]}-widths-${visit?'warm':'first'}`,async()=>{
    await reset(page!);const row=await locate(page!,[nodes[24+i].id]);result.locates.push({...row,distanceWidths:[1,10,100][i],visit:visit?'warm':'first'});expect(row.status).toBe('ok');return row;
   });
  }
  if(kind==='selection'){
   const ids=nodes.slice(0,100).map((n:any)=>n.id);
   await page.evaluate(()=>{const w=window as any;w.__canvasSetSelection([]);w.__canvasPanTo({x:20,y:0,zoom:.85},0);});await page.waitForTimeout(500);
   const surface=(await page.locator('#bevy-canvas').boundingBox())!;
   await phase('box-select-100',async()=>{
    const start=Date.now();await page!.mouse.move(surface.x+20+50*.85,surface.y+100*.85);await page!.mouse.down();await page!.mouse.move(surface.x+20+1400*.85,surface.y+850*.85,{steps:30});await page!.mouse.up();
    await expect.poll(()=>page!.evaluate(()=>(window as any).__canvasSelection().nodeIds.slice().sort())).toEqual([...ids].sort());return {elapsedMs:Date.now()-start,selected:100};
   });
   await phase('drag-100',async()=>{
    const before=await page!.evaluate(ids=>Object.fromEntries((window as any).__canvasCanonical.document.nodes.filter((n:any)=>ids.includes(n.id)).map((n:any)=>[n.id,{...n.position}])),ids);
    const x=surface.x+20+150*.85,y=surface.y+160*.85;await page!.mouse.move(x,y);await page!.mouse.down();await page!.mouse.move(x+45,y+25,{steps:30});await page!.mouse.up();
    await expect.poll(()=>page!.evaluate(({ids,before})=>ids.every(id=>{const p=(window as any).__canvasCanonical.document.nodes.find((n:any)=>n.id===id).position;return Math.hypot(p.x-before[id].x,p.y-before[id].y)>1;}),{ids,before})).toBe(true);
    const after=await page!.evaluate(ids=>Object.fromEntries((window as any).__canvasCanonical.document.nodes.filter((n:any)=>ids.includes(n.id)).map((n:any)=>[n.id,n.position])),ids);
    await submit(page!,ids.map((id:string)=>({type:'node.update',nodeId:id,position:before[id]})));
    await expect.poll(()=>page!.evaluate(({ids,before})=>ids.every(id=>{const p=(window as any).__canvasCanonical.document.nodes.find((n:any)=>n.id===id).position;return p.x===before[id].x&&p.y===before[id].y;}),{ids,before})).toBe(true);return {before,after,allMoved:true,allReset:true};
   });
   await phase('bulk-update-one-percent',async()=>{
    const updates=nodes.slice(200,210).map((n:any)=>({type:'node.update',nodeId:n.id,position:{x:n.position.x+17,y:n.position.y+11}}));
    const timing=await submit(page!,updates);
    await expect.poll(()=>page!.evaluate(updates=>updates.every(u=>{const p=(window as any).__canvasCanonical.document.nodes.find((n:any)=>n.id===u.nodeId).position;return p.x===u.position.x&&p.y===u.position.y;}),updates)).toBe(true);
    await submit(page!,nodes.slice(200,210).map((n:any)=>({type:'node.update',nodeId:n.id,position:n.position})));return {count:10,fraction:.01,...timing};
   });
  }
  if(kind==='cache-state'){
   const a=nodes[0].id,b=nodes[24].id;result.cacheEvidence=[];
   const ready=async(id:string,label:string)=>{const row=await locate(page!,[id],[id]);result.locates.push({...row,label});expect(row.status,JSON.stringify(row)).toBe('ok');return row;};
   await phase('cache-prime-A',()=>ready(a,'prime-A'));
   await phase('cache-prime-B',()=>ready(b,'prime-B'));
   await phase('warm-resident-return',async()=>{
    const before=await snapshot(page!);const verified=before.work?.previews?.retained===2&&before.media?.readyModels?.includes(b);
    const evidence={name:'warm-resident-return',classification:verified?'verified-warm-preview-resident':'unverified-warm-preview-state',verified,before,proof:'Exactly two possible model previews; total retained=2 while B ready implies A preview retained. This does not establish heavy model payload residency.'};
    result.cacheEvidence.push(evidence);const row=await ready(a,evidence.classification);return {...evidence,row};
   });
   await ready(b,'leave-A-before-eviction');
   await phase('confirmed-preview-evicted-return',async()=>{
    const until=Date.now()+20000;let before:any=null,verified=false;
    do{
     before=await snapshot(page!);const readyIds=before.media?.readyModels??[];
     verified=before.work?.previews?.retained===1&&readyIds.includes(b)&&!readyIds.includes(a);
     if(verified||Date.now()>=until)break;await page!.waitForTimeout(250);
    }while(Date.now()<until);
    const evidence={name:'confirmed-preview-evicted-return',classification:verified?'confirmed-preview-evicted':'preview-eviction-unverified',verified,before,proof:'Exactly two possible models; retained=1 and B ready with A absent proves A preview camera/texture reclaimed. Heavy IR/model payload eviction is not established.',globalHeavyPayloadEvictions:before.scene?.modelPayloadEvictions};
    result.cacheEvidence.push(evidence);const row=await ready(a,evidence.classification);return {...evidence,row};
   });
  }
  if(kind==='residency')await phase('five-minute-three-region-return-trend',async()=>{
   const started=Date.now(),deadline=started+300000;const visits:any[]=[],evictionEvidence:any[]=[];result.residencyEvictionEvidence=evictionEvidence;
   let sampling:Promise<void>|null=null;
   const sample=()=>{if(!sampling)sampling=(async()=>{result.raw.push({elapsedMs:Date.now()-started,...await snapshot(page!)});await checkpoint();})().finally(()=>{sampling=null;});};
   sample();const timer=setInterval(sample,5000);
   try{
    for(let visit=0;Date.now()<deadline;visit++){
     const region=visit%3,before=await snapshot(page!);
     const row=await locate(page!,regions[region],modelRegions[region]);visits.push({...row,visit,region,before});result.locates=visits;expect(row.status,JSON.stringify(row)).toBe('ok');
     const oldRegion=(region+2)%3,until=Math.min(deadline,Date.now()+20000);let evidence:any=null;
     // All 24 region ids are located as one union, making all 12 current models visible.
     // A total retained count of 12 plus all current 12 ready proves old previews are gone.
     do{
      const observed=await snapshot(page!);const retained=observed.work?.previews?.retained;
      const ready=observed.media?.readyModels??[];const currentReady=modelRegions[region].filter(id=>ready.includes(id));
      const previousReady=modelRegions[oldRegion].filter(id=>ready.includes(id));
      const verified=visit>0&&retained===modelRegions[region].length&&currentReady.length===modelRegions[region].length&&previousReady.length===0;
      evidence={visit,region,oldRegion,verified,status:verified?'preview-eviction-verified':'preview-eviction-unverified',retained,textureBytes:observed.work?.previews?.textureBytes,currentReady,previousReady,health:observed.health,globalHeavyPayloadEvictions:observed.scene?.modelPayloadEvictions,observedAt:Date.now()-started};
      if(verified||visit===0||Date.now()>=until)break;
      await page!.waitForTimeout(250);
     }while(Date.now()<until);
     evictionEvidence.push(evidence);await checkpoint();
     // Minimum dwell is independent from whether eviction was verified.
     const dwell=Date.now();while(Date.now()-dwell<2500)await page!.waitForTimeout(250);
    }
   }finally{clearInterval(timer);if(sampling)await sampling;result.raw.push({elapsedMs:Date.now()-started,...await snapshot(page!)});}
   return {elapsedMs:Date.now()-started,visits:visits.length,modelReady:summarize(visits.map(v=>v.modelReadyMs).filter((v:any)=>v!==null)),evictionEvidence,interpretation:'Only rows marked preview-eviction-verified prove previous-region camera/texture reclamation: all current models ready and retained count equals current model count. Unverified rows make no eviction claim. Heavy model payload eviction is a separate global counter and cannot establish target-specific payload eviction. Five-minute trend probe does not prove absence of leaks.'};
  });
  result.status='completed';expect(result.errors).toEqual([]);
 }catch(error){result.status='failed';result.failure=String(error);throw error;}
 finally{
  if(page){result.final=await snapshot(page).catch(()=>null);try{await page.screenshot({path:resolve(dir,'final.png')});result.screenshot='final.png';}catch(error){result.screenshotError=String(error);}}
  result.ended=new Date().toISOString();try{await checkpoint();}finally{await browser?.close();}
 }
});
