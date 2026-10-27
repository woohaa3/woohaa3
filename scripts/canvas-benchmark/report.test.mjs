import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildReport} from './report.mjs';
const metadata={buildId:'known-build-1',fixtureHash:'hash',scenario:'canvas',gpu:'metal',browser:'chrome',viewport:[1024,768],devicePixelRatio:2,buildMode:'release',sampleDurationMs:10000,warmupMs:1000};
test('run-level aggregation excludes errors, separates locate visits and escapes artifacts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try {
  for(const [id,p95,status,label] of [['a',10,'completed','A'],['b',30,'completed','B'],['bad',999,'completed-with-errors','B']]) {
   await mkdir(join(root,id)); await writeFile(join(root,id,'run.json'),JSON.stringify({runId:'<'+id+',"',cell:{nodes:100,visible:20,kind:'shape',round:1},label,status,metadata,phases:[{name:'idle',quality:'valid',renderInterval:{p95,p99:99,count:20}}],locates:[{status:'completed',handlerMs:2,arrivedMs:4,interactiveMs:6},{status:'completed',handlerMs:3,arrivedMs:5,interactiveMs:7}]}));
  }
  const result=await buildReport(root);
  assert.equal(result.groups[0].metrics.renderP95.median,20);
  assert.equal(result.groups[0].metrics.renderP95.count,2);
  assert.equal(result.exclusions.length,1);
  assert.equal(result.groups[0].metrics.renderP99,null);
  assert.equal(result.locates.find(x=>x.visit==='first').metrics.interactiveMs.count,2);
  assert.equal(result.pairedAA[0].comparison.medianDifference,20);
  const html=await readFile(join(root,'report.html'),'utf8'); assert.ok(!html.includes('<a,"')); assert.ok(html.includes('&lt;a,&quot;'));
  assert.ok((await readFile(join(root,'runs.csv'),'utf8')).includes('"<a,"""'));
  const filtered=await buildReport(root,{label:'A'}); assert.equal(filtered.runs.length,1); assert.equal(filtered.pairedAA.length,0);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('missing metrics stay null and return events carry one vote per run',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try {
  for(const [id,warm] of [['one',[2,4,6]],['two',[100]]]){
   await mkdir(join(root,id));await writeFile(join(root,id,'run.json'),JSON.stringify({runId:id,label:'pilot',status:'completed',cell:{nodes:1,visible:1,kind:'text',round:1},phases:[{name:'pan',renderInterval:{p95:8,p99:9,count:1000}},{name:'drag',quality:'invalid',renderInterval:{p95:900}}],locates:[{interactiveMs:1},...warm.map(interactiveMs=>({interactiveMs}))]}));
  }
  await mkdir(join(root,'broken'));await writeFile(join(root,'broken','run.json'),'{');
  const s=await buildReport(root);
  assert.equal(s.groups.length,1);assert.equal(s.groups[0].metrics.handlerP95,null);assert.equal(s.groups[0].metrics.renderP99.median,9);
  assert.equal(s.locates.find(l=>l.visit==='return').metrics.interactiveMs.median,52);
  assert.equal(s.locates.find(l=>l.visit==='return').metrics.interactiveMs.count,2);
  assert.ok(s.locates.every(l=>l.cacheState==='unverified'));
  assert.equal(s.exclusions.length,3);assert.equal(s.pairedAA.length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('rejects invalid phase diagnostics and unverified comparisons, summarizes media and loads',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try {
  for(const [id,label,meta] of [['a','A',metadata],['b','B',{...metadata,gpu:'other'}],['c','A',undefined]]){
   await mkdir(join(root,id));await writeFile(join(root,id,'run.json'),JSON.stringify({runId:id,label,metadata:meta,status:'completed',cell:{nodes:1,visible:1,kind:'shape',round:id==='c'?2:1},loadToRuntimeMs:10,loadToReadyMs:20,phases:[{name:'idle',quality:'valid',renderInterval:{p95:2}},...['overflow','hidden','replay-invalid'].map(quality=>({name:quality,quality,renderInterval:{p95:999}})),{name:'failure',failure:'timeout',renderInterval:{p95:999}},{name:'dropped',dropped:1,renderInterval:{p95:999}}],locates:[{mediaReadyMs:10},{mediaReadyMs:30}]}));
  }
  const s=await buildReport(root);assert.equal(s.groups.length,3);assert.equal(s.pairedAA.length,0);assert.equal(s.exclusions.length,15);
  assert.equal(s.locates.length,6);assert.equal(s.loads.length,3);
  assert.ok(s.groups.some(g=>g.config.gpu==='other'));assert.ok(s.groups.some(g=>g.config.gpu===undefined));
  assert.equal(s.locates.find(l=>l.visit==='first').metrics.mediaReadyMs.median,10);assert.equal(s.locates.find(l=>l.visit==='return').metrics.mediaReadyMs.median,30);
  assert.equal(s.loads.reduce((n,g)=>n+g.metrics.loadToReadyMs.count,0),3);assert.equal(s.loads[0].metrics.loadToRuntimeMs.median,10);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('execution-only failures and skips stay in denominator without duplicating recorded runs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try {
  const cell={nodes:100,visible:10,kind:'shape',round:1};
  await mkdir(join(root,'recorded'));await writeFile(join(root,'recorded','run.json'),JSON.stringify({runId:'recorded',attemptKey:'match',status:'completed',label:'A',cell,phases:[]}));
  await writeFile(join(root,'execution.json'),JSON.stringify({planned:3,completed:[{key:'match',item:{label:'A',cell},exitCode:0},{key:'host-fail',item:{label:'A',cell},exitCode:null,error:'host readiness timeout'},{key:'skip',item:{label:'A',cell},status:'skipped-repeated-failure',reason:'prior failures'}]}));
  const s=await buildReport(root);assert.equal(s.runs.length,3);assert.equal(s.runs.filter(r=>r.included).length,1);assert.equal(s.exclusions.length,2);
  assert.equal(s.runs.find(r=>r.attemptKey==='host-fail').error,'host readiness timeout');assert.ok(s.runs.find(r=>r.attemptKey==='host-fail').logs.includes('host-fail-server.log'));
  assert.equal(s.runs.find(r=>r.attemptKey==='skip').status,'skipped-repeated-failure');assert.equal(s.groups.length,0);
  const html=await readFile(join(root,'report.html'),'utf8');assert.ok(html.includes('host-fail-server.log'));assert.ok(html.includes('execution.json'));
  const csvText=await readFile(join(root,'runs.csv'),'utf8');assert.ok(csvText.includes('host readiness timeout'));assert.ok(csvText.includes('skipped-repeated-failure'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('distinct topology, media and measurement configurations never pool',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try{
  const variants=[{edges:0,mediaCount:1},{edges:1,mediaCount:1},{edges:4,mediaCount:1},{edges:0,mediaCount:2},{edges:0,mediaCount:1,duration:30000},{edges:0,mediaCount:1,sampling:'off'}];
  for(const [i,v] of variants.entries()){
   const cell={nodes:100,visible:10,kind:'model-unique',edges:v.edges,mediaCount:v.mediaCount,round:1};
   await mkdir(join(root,String(i)));await writeFile(join(root,String(i),'run.json'),JSON.stringify({runId:String(i),label:'scale',status:'completed',cell,metadata:{...metadata,sampleDurationMs:v.duration??10000,sampling:v.sampling??'on'},phases:[{name:'idle',quality:'valid',renderInterval:{p95:i+1}}],locates:[{interactiveMs:i+1}],loadToReadyMs:i+1}));
  }
  const s=await buildReport(root);assert.equal(s.groups.length,6);assert.equal(s.locates.length,6);assert.equal(s.loads.length,6);
  assert.ok(s.groups.every(g=>g.runCount===1&&g.labels.includes('scale')));assert.equal(s.groups.find(g=>g.config.sampling==='off').cell.edges,0);
  assert.ok((await readFile(join(root,'report.html'),'utf8')).includes('mediaCount'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('reports observed input latency without presenting it as GPU latency',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try{
  await mkdir(join(root,'r'));await writeFile(join(root,'environment.json'),JSON.stringify({gpu:'Apple Metal'}));
  await writeFile(join(root,'r','run.json'),JSON.stringify({runId:'r',status:'completed',cell:{nodes:10,round:1},phases:[{name:'pan',quality:'valid',inputToObservedApplied:{p95:12,count:4},coalescedInputs:3,browserRafInterval:{p95:18},renderInterval:{max:55,count:42},handlersByType:{pointerup:{p95:70},pointermove:{p95:3}}}]}));
  const s=await buildReport(root);assert.equal(s.environment.gpu,'Apple Metal');assert.equal(s.groups[0].metrics.inputObservedP95.median,12);assert.equal(s.groups[0].metrics.coalescedInputs.median,3);
  for(const [key,value] of Object.entries({browserRafP95:18,renderMax:55,releaseHandlerMs:70,pointerMoveHandlerP95:3,sampleCount:42}))assert.equal(s.groups[0].metrics[key].median,value);
  assert.ok((await readFile(join(root,'report.html'),'utf8')).includes('非 GPU 呈现耗时'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('derived replay invalidity excludes only affected phases and retains raw diagnostic facts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try{
  await mkdir(join(root,'r'));await writeFile(join(root,'r','run.json'),JSON.stringify({runId:'r',status:'completed',cell:{nodes:10},loadToReadyMs:5,locates:[{interactiveMs:8}],phases:[
   {name:'idle',quality:'valid',renderInterval:{p95:1}},
   {name:'pan',quality:'valid',effect:{scheduledEvents:79,expectedEvents:100},schedule:{late:{p95:1}},renderInterval:{p95:2}},
   {name:'zoom',quality:'valid',effect:{scheduledEvents:100,expectedEvents:100},schedule:{late:{p95:7}},renderInterval:{p95:3}},
   {name:'drag',quality:'valid',effect:{scheduledEvents:80,expectedEvents:100},schedule:{late:{p95:6.4}},renderInterval:{p95:4}},
   {name:'after-locate',quality:'valid',effect:{scheduledEvents:100,expectedEvents:100,inputIntervalMs:50},schedule:{late:{p95:9}},renderInterval:{p95:5}}]}));
  const s=await buildReport(root);assert.deepEqual(s.groups.map(g=>g.phase),['idle','drag','after-locate']);assert.equal(s.loads.length,1);assert.equal(s.locates.length,1);assert.equal(s.runs[0].included,true);
  assert.equal(s.replayDiagnostics.length,4);const pan=s.replayDiagnostics.find(d=>d.phase==='pan');assert.equal(pan.quality,'replay-invalid');assert.equal(pan.deliveredFraction,.79);assert.equal(pan.scheduledEvents,79);assert.equal(s.exclusions.filter(e=>e.reason==='replay-invalid').length,2);
  assert.ok((await readFile(join(root,'report.html'),'utf8')).includes('不能声称受控轨迹'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('unwritten timers are unavailable and gauges retain before/after semantics',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try{
  await mkdir(join(root,'r'));await writeFile(join(root,'r','run.json'),JSON.stringify({status:'completed',cell:{nodes:10},phases:[{name:'idle',quality:'valid',delta:{sceneBuildMs:0,fingerprintMs:0,lastSceneJsonCodeUnits:-50,modelPrepareMaxMs:2,sceneBuilds:0},before:{counters:{lastSceneJsonCodeUnits:100,modelPrepareMaxMs:5}},after:{counters:{lastSceneJsonCodeUnits:50,modelPrepareMaxMs:7}}}]}));
  const s=await buildReport(root),m=s.groups[0].metrics;assert.equal(m['delta.sceneBuildMs'],null);assert.equal(m['delta.fingerprintMs'],null);assert.equal(s.groups[0].unavailable['delta.sceneBuildMs'],'no production timing writer in tested source');assert.equal(m['delta.lastSceneJsonCodeUnits'],undefined);assert.equal(m['delta.modelPrepareMaxMs'],undefined);assert.equal(m['gauge.before.lastSceneJsonCodeUnits'].median,100);assert.equal(m['gauge.after.lastSceneJsonCodeUnits'].median,50);assert.equal(m['gauge.after.modelPrepareMaxMs'].median,7);assert.equal(m['delta.sceneBuilds'].median,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('formal pairs require known build identities and distinguish A/A from A/B',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try{
  for(const [round,ids] of [[1,['same','same']],[2,['old','new']],[3,[undefined,'same']],[4,['unspecified','same']],[5,['unknown','same']]])for(const [i,label] of ['A','B'].entries()){
   const folder=`${round}-${label}`;await mkdir(join(root,folder));await writeFile(join(root,folder,'run.json'),JSON.stringify({status:'completed',label,metadata:{...metadata,buildId:ids[i]},cell:{nodes:1,round},phases:[{name:'idle',renderInterval:{p95:i+1}}]}));
  }
  const s=await buildReport(root);assert.equal(s.pairedAA.flatMap(g=>g.pairs).length,2);assert.deepEqual(s.pairedAA.map(g=>g.comparisonKind).sort(),['A/A','A/B']);assert.equal(s.excludedPairs.length,3);assert.ok(s.excludedPairs.every(p=>p.reason==='missing or unknown build identity'));assert.equal(s.groups[0].runCount,10);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('uses actual runtime work snapshots and rejects legacy merged zeros, missing and reset counters',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-report-'));
 try{
  await mkdir(join(root,'r'));await writeFile(join(root,'r','run.json'),JSON.stringify({status:'completed',cell:{nodes:10},phases:[{name:'idle',delta:{rustRenderPrepareMs:0,worldSnapshotBuilds:0,cardBlockBuilds:0},before:{work:{snapshotBuilds:3,cardBlockBuilds:313,meshBuilds:5,renderStages:{work:{prepareMs:342.2}}}},after:{work:{snapshotBuilds:9,cardBlockBuilds:313,meshBuilds:2,renderStages:{work:{prepareMs:467.2}}}}}]}));
  const s=await buildReport(root),g=s.groups[0];assert.equal(g.metrics['delta.rustRenderPrepareMs'],null);assert.equal(g.metrics['delta.worldSnapshotBuilds'],null);assert.equal(g.metrics['delta.cardBlockBuilds'],null);assert.equal(g.metrics['workDelta.snapshotBuilds'].median,6);assert.equal(g.metrics['workDelta.cardBlockBuilds'].median,0);assert.equal(g.metrics['workDelta.renderStages.work.prepareMs'].median,125);assert.equal(g.metrics['workDelta.meshBuilds'],null);assert.ok(g.unavailable['workDelta.meshBuilds'].includes('reset'));assert.equal(g.metrics['workDelta.models.geometryWork.buildMs'],null);assert.ok(g.unavailable['workDelta.models.geometryWork.buildMs'].includes('missing'));
 }finally{await rm(root,{recursive:true,force:true});}
});
