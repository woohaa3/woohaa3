import { describe, expect, it } from 'vitest';
import { createScenePackageClient, decodeReceipt, SceneFrameWindow, numericTree } from './scene-experience.js';

describe('scene package experience', () => {
  it('validates receipt identity and view membership before enabling experience', () => {
    expect(decodeReceipt({canvasId:'c',operationId:'o',packageHash:'a',manifest:{format:'other',version:1}},'c')).toBeNull();
    expect(decodeReceipt({canvasId:'other'},'c')).toBeNull();
  });
  it('keeps a stable id across retries and never sends a local filename', async () => {
    const calls: RequestInit[] = [];
    const api = createScenePackageClient(async (_url, init) => {
      calls.push(init!); return new Response(JSON.stringify({job:{phase:'ready',canvasId:'c'}}));
    });
    await api.importFile(new Blob(['scene']), 'stable');
    await api.importFile(new Blob(['scene']), 'stable');
    expect(calls.map(c => new Headers(c.headers).get('X-Woohaa-Import-Id'))).toEqual(['stable','stable']);
    expect(new Headers(calls[0].headers).get('Content-Disposition')).toBeNull();
  });
  it('bounds frame samples by time and capacity, reports intervals rather than GPU FPS', () => {
    const frames = new SceneFrameWindow();
    for(let i=0;i<20000;i++) frames.push(i);
    expect(frames.snapshot(20000).intervalsMs.length).toBeLessThanOrEqual(16384);
    expect(frames.snapshot(60000).intervalsMs).toEqual([]);
  });
  it('drops strings and nested content from diagnostics exports', () => {
    expect(numericTree({renders:4,url:'secret',body:'content',nested:{bytes:5,source:'/Users/a'}})).toEqual({renders:4,nested:{bytes:5}});
  });
});

it('uses asynchronous native diagnostics and makes missing diagnostics explicit', async () => {
  const { readSceneWorkDiagnostics } = await import('../canvas-runtime/diagnostics-reader.js');
  let syncCalls=0;
  expect(await readSceneWorkDiagnostics({async_canvas_work_diagnostics:async()=>'{"renders":4}',canvas_work_diagnostics:()=>{syncCalls++;return '{}';}})).toEqual({value:{renders:4},reason:null});
  expect(syncCalls).toBe(0);
  expect(await readSceneWorkDiagnostics({})).toEqual({value:null,reason:'unsupported'});
});

it('exports only safe package metadata, numeric counters and enum feedback', async () => {
  const { makeExperienceReport } = await import('./report.js');
  const report=makeExperienceReport({receipt:{canvasId:'c',operationId:'o',packageHash:'abc',manifest:{datasetId:'test',contentHash:'abc',recipeVersion:1,kind:'text',title:'SECRET',views:{overview200:[],overview300:[],distant:[]}}} as never,frames:new SceneFrameWindow(),samples:[],view:'overview200',scene:null,surface:null,backend:'native',feedback:'stutter',build:'abc'});
  expect(JSON.stringify(report)).not.toContain('SECRET');
  expect(report.gpuPresent).toEqual({value:null,reason:'unsupported'});
  expect(report.feedback).toBe('stutter');
});

it('prevents an older deferred initial view from overriding newer navigation', async () => {
  const { SceneNavigationIntent }=await import('./navigation-intent.js');
  const intent=new SceneNavigationIntent(); const initial=intent.begin(); const distant=intent.begin();
  expect(intent.current(initial)).toBe(false); expect(intent.current(distant)).toBe(true);
  intent.cancel();expect(intent.current(distant)).toBe(false);
});

it('does not export arbitrary feedback strings, node payloads, URLs or local paths', async()=>{
  const {makeExperienceReport}=await import('./report.js');
  const report=makeExperienceReport({receipt:{packageHash:'../../secret',manifest:{datasetId:'https://private',contentHash:'safe',recipeVersion:1,kind:'text'}} as never,frames:new SceneFrameWindow(),samples:[],view:'overview200',scene:{nodes:[{body:'private',title:'private',x:0,y:0,width:1,height:1}],edges:[],viewport:{x:0,y:0,zoom:1}} as never,surface:{width:100,height:100,pixelRatio:1},backend:'native',feedback:'https://private token=secret' as never,build:'abc'});
  expect(report.feedback).toBeNull();expect(report.packageHash).toBeNull();expect(report.datasetId).toBeNull();expect(JSON.stringify(report)).not.toContain('private');
});

it('distinguishes fully visible nodes from nodes intersecting the viewport',async()=>{
  const {makeExperienceReport}=await import('./report.js');
  const report=makeExperienceReport({receipt:{packageHash:'a',manifest:{datasetId:'a',contentHash:'a',recipeVersion:1,kind:'text'}} as never,frames:new SceneFrameWindow(),samples:[],view:'overview200',scene:{nodes:[{x:0,y:0,width:40,height:40},{x:90,y:90,width:40,height:40},{x:110,y:110,width:10,height:10}],edges:[],viewport:{x:0,y:0,zoom:1}} as never,surface:{width:100,height:100,pixelRatio:1},backend:'native',feedback:'',build:'a'});
  expect(report.visibleCount).toBe(1);expect(report.intersectingCount).toBe(2);
});

it('reports owned capacity drops and explicit interpretation metadata',async()=>{
  const {makeExperienceReport}=await import('./report.js');const frames=new SceneFrameWindow();for(let i=0;i<20000;i++)frames.push(performance.now()+i/1000);
  const report=makeExperienceReport({receipt:{packageHash:'a',manifest:{datasetId:'a',contentHash:'a',recipeVersion:1,kind:'text'}} as never,frames,samples:[{at:performance.now(),work:null,reason:'unsupported',health:{phase:'recovering',health:{renders:3}},resources:null,loading:1,ready:0,revision:1,resourceReady:false}],view:'overview200',safeArea:{left:10,top:10,right:10,bottom:10},scene:null,surface:null,backend:'native',feedback:'',build:'a',entryOrigin:'reset'});
  expect(report.entryOrigin).toBe('reset');expect(report.cacheState.value).toBeNull();expect(report.collectionPhase.value).toBe('loading');expect(report.runtimePhase).toBe('recovering');expect(report.qualityDropped.frontendRafCapacity).toBeGreaterThan(0);expect(report.counterUnits).toBeDefined();
});

it('does not count ordinary 30 second expiry as dropped capacity',()=>{
  const frames=new SceneFrameWindow();for(let i=0;i<=16384;i++)frames.push(i);
  frames.push(60000);expect(frames.snapshot(60000).capacityDropped).toBe(0);
});
