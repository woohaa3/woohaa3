import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDenseReport} from './dense-report.mjs';
test('中文报告按独立有效运行聚合，保留回放缺失和截图证据',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dense-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cell={nodes:1000,visible:300,edges:4,kind:'text',round:0},phase=value=>({name:'drag',quality:'valid',renderInterval:{p95:value},completedFps:40,handlersByType:{pointerup:{p95:3}},verification:{status:'observed',releaseToObservedMs:80},after:{visibleCount:300}});
 const records=[{folder:'good',included:true,status:'completed',cell,metadata:{scenario:'dense'},phases:[phase(10)],locates:[{status:'ok',interactiveMs:20},{status:'ok',interactiveMs:40}]},{folder:'invalid',included:true,status:'completed',cell,metadata:{scenario:'dense'},phases:[phase(1000)]},{folder:'failed',included:false,status:'failed',cell,metadata:{scenario:'dense'},phases:[phase(9999)]}];
 for(const r of records){await mkdir(join(root,r.folder));await writeFile(join(root,r.folder,'run.json'),JSON.stringify(r));await writeFile(join(root,r.folder,'overview.png'),'tiny');await writeFile(join(root,r.folder,'manifest.json'),JSON.stringify({N:1000,V:300,edgesPerNode:4}));}
 const summary={runs:records,groups:[{phase:'drag',cell,config:{scenario:'dense'},provenance:['good']}],replayDiagnostics:[{folder:'invalid',phase:'drag',quality:'replay-invalid',scheduledEvents:10,expectedEvents:100,missingFraction:.9,lateP95Ms:2}],exclusions:[{folder:'invalid',phase:'drag',reason:'replay-invalid'},{folder:'failed',reason:'status=failed'}]};
 await writeFile(join(root,'summary.json'),JSON.stringify(summary));const result=await buildDenseReport(root);
 assert.equal(result.phases[0].metrics.renderP95.median,10);assert.equal(result.phases[0].validRuns,1);assert.equal(result.phases[0].attempts,3);
 assert.equal(result.locates.find(x=>x.visit==='first').interactive.median,20);assert.equal(result.locates.find(x=>x.visit==='return').interactive.median,40);
 const html=await readFile(join(root,'dense-conclusions.html'),'utf8');const md=await readFile(join(root,'dense-conclusions.md'),'utf8');
 assert.match(html,/good\/overview.png/);assert.match(md,/90\.00/);assert.match(md,/调度完成频率/);assert.match(md,/缓存.*未验证/);assert.match(md,/内容 LOD/);assert.match(md,/字体栅格分辨率 LOD/);assert.match(md,/1\/2\/4\/8\/12/);assert.match(md,/迟滞/);assert.match(md,/各独立运行 p95 的中位数/);assert.doesNotMatch(md,/GPU FPS/);
});
test('历史结果独立展示，不混合元数据不同的当前运行，也不改写原始数据',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dense-report-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cell={nodes:1000,visible:200,edges:4,kind:'text'},runs=[];
 for(const [folder,browser,value] of [['a','Chrome1',10],['b','Chrome2',30]]){
  const raw={folder,included:true,status:'completed',cell,metadata:{scenario:'same',browser},phases:[{name:'idle',quality:'valid',renderInterval:{p95:value}}]};runs.push(raw);await mkdir(join(root,folder));await writeFile(join(root,folder,'run.json'),JSON.stringify(raw));
 }
 const summary=JSON.stringify({runs,groups:[{phase:'idle',provenance:['a','b']}],exclusions:[]});await writeFile(join(root,'summary.json'),summary);
 const history=join(root,'history');await mkdir(history);await writeFile(join(history,'summary.json'),JSON.stringify({runs:[{status:'completed'}],groups:[{cell:{nodes:1000,visible:24},phase:'idle',runCount:1,metrics:{renderP95:{median:999,min:999,max:999,count:1}}}]}));
 const result=await buildDenseReport(root,{historyRoot:history});assert.equal(result.phases.length,2);assert.deepEqual(result.phases.map(p=>p.metrics.renderP95.median),[10,30]);assert.equal(result.history.runCount,1);
 assert.equal(await readFile(join(root,'summary.json'),'utf8'),summary);assert.match(await readFile(join(root,'dense-conclusions.md'),'utf8'),/历史对照：旧纯节点批次/);
});
