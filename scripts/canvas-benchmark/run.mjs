#!/usr/bin/env node
// Each attempt owns a fresh host and browser; no user data or services are stopped.
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectBuildIdentity} from './metadata.mjs';
const client=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const root=resolve(process.argv[2]??resolve(client,'artifacts/canvas-benchmark/official'));
const planPath=resolve(process.argv[3]??resolve(client,'artifacts/canvas-benchmark/plan.json'));
const plan=JSON.parse(readFileSync(planPath,'utf8'));
const build=collectBuildIdentity({clientRoot:client});
const buildId=build.buildId;
mkdirSync(root,{recursive:true});
writeFileSync(resolve(root,'build-identity.json'),JSON.stringify(build,null,2));
const port=Number(process.env.BENCH_PORT??4398);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let interrupted=false,active=[];
const killGroup=(child,signal)=>{try{process.kill(-child.pid,signal);}catch{child.kill(signal);}};
process.on('SIGTERM',()=>{interrupted=true;for(const p of active)killGroup(p,'SIGTERM');});
process.on('SIGINT',()=>{interrupted=true;for(const p of active)killGroup(p,'SIGTERM');});
const completed=[];
for(let index=0;index<plan.length&&!interrupted;index++){
 const item=plan[index];
 if(item.supplement&&!['distance','selection','groups','residency','cache-state'].includes(item.supplement))throw new Error('Invalid supplemental probe');
 const key=`${String(index).padStart(3,'0')}-${item.label}-${item.supplement??'main'}-n${item.cell.nodes}-v${item.cell.visible}-${item.cell.kind}-r${item.cell.round}`;
 const env={...process.env,BENCH_PORT:String(port),BENCH_BUILD_ID:buildId,BENCH_OUT:root,BENCH_LABEL:item.label,BENCH_CELLS:JSON.stringify([item.cell]),BENCH_PHASE_MS:String(item.duration??10000),BENCH_WARMUP_MS:String(item.warmup??10000),BENCH_REUSE_SERVER:'1',BENCH_SAMPLING:item.sampling??'on',E2E_QUIET:'1',E2E_BENCHMARK:'1',BENCH_PROFILE:item.profile?'1':'0',BENCH_ATTEMPT_KEY:key};
 if(item.supplement){env.BENCH_SUPPLEMENT=item.supplement;env.BENCH_ROUND=String(item.cell.round);}
 if(item.inputIntervalMs!==undefined){if(!Number.isFinite(item.inputIntervalMs)||item.inputIntervalMs<16)throw new Error('Invalid input interval');env.BENCH_INPUT_MS=String(item.inputIntervalMs);}
 if(item.zoomInputIntervalMs!==undefined){if(!Number.isFinite(item.zoomInputIntervalMs)||item.zoomInputIntervalMs<16)throw new Error('Invalid zoom input interval');env.BENCH_ZOOM_INPUT_MS=String(item.zoomInputIntervalMs);}
 if(item.onlyPhase!==undefined){if(item.onlyPhase!=='zoom')throw new Error('Only zoom is supported for phase calibration');env.BENCH_ONLY_PHASE=item.onlyPhase;}
 env.HOST='127.0.0.1';
 const serverLogPath=resolve(root,`${key}-server.log`);
 const serverLog=openSync(serverLogPath,'w');
 const testLog=openSync(resolve(root,`${key}-test.log`),'w');
 const started=new Date().toISOString();
 const signature=cell=>JSON.stringify(Object.fromEntries(Object.entries(cell).filter(([key])=>key!=='round').sort()));
 const sameCell=completed.filter(r=>r.item.supplement===item.supplement&&(r.item.sampling??'on')===(item.sampling??'on')&&(r.item.inputIntervalMs??32)===(item.inputIntervalMs??32)&&(r.item.zoomInputIntervalMs??r.item.inputIntervalMs??32)===(item.zoomInputIntervalMs??item.inputIntervalMs??32)&&r.item.onlyPhase===item.onlyPhase&&signature(r.item.cell)===signature(item.cell)&&r.status!=='skipped-repeated-failure');
 if(sameCell.length>=3&&sameCell.slice(-3).every(r=>r.exitCode!==0)){
  completed.push({index,item,key,started,status:'skipped-repeated-failure',reason:'three verified prior failures of identical cell'});
  writeFileSync(resolve(root,'execution.json'),JSON.stringify({planPath,planned:plan.length,completed,interrupted},null,2));closeSync(serverLog);closeSync(testLog);continue;
 }
 console.log(`[${index+1}/${plan.length}] ${key} ${started}`);
 const server=spawn(process.execPath,['e2e/server.mjs','--port',String(port),'--dist','frontend/dist-benchmark'],{cwd:resolve(client,'web'),env,detached:true,stdio:['ignore',serverLog,serverLog]});
 active=[server];let outcome={index,item,key,started,exitCode:null,error:null};
 try{
  let ready=false;for(let wait=0;wait<120&&!interrupted;wait++){
   if(server.exitCode!==null)throw new Error(`host exited ${server.exitCode}`);
   // A successful response alone could belong to an unrelated process on this
   // port. Require the owned host's post-listen marker before probing it.
   if(!readFileSync(serverLogPath,'utf8').includes(`[e2e-server] http://127.0.0.1:${port}`)){await delay(500);continue;}
   try{const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}
   await delay(500);
  }
  if(!ready)throw new Error('host readiness timeout');
  const cli=resolve(client,'web/node_modules/@playwright/test/cli.js');
  const test=spawn(process.execPath,[cli,'test','-c',item.supplement?'playwright.canvas-supplement.config.ts':'playwright.large-canvas.config.ts'],{cwd:resolve(client,'web'),env,detached:true,stdio:['ignore',testLog,testLog]});
  active.push(test);
  outcome.exitCode=await new Promise(r=>{let force;const timeout=setTimeout(()=>{killGroup(test,'SIGTERM');force=setTimeout(()=>killGroup(test,'SIGKILL'),5000);},item.cell.quick?90000:item.supplement?660000:item.cell.visualProbe?420000:300000);test.once('exit',(code,signal)=>{clearTimeout(timeout);clearTimeout(force);r(code??signal);});});
 }catch(error){outcome.error=String(error);}finally{
  killGroup(server,'SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),delay(5000)]);
  if(server.exitCode===null&&server.signalCode===null)killGroup(server,'SIGKILL');
  closeSync(serverLog);closeSync(testLog);active=[];
 }
 outcome.ended=new Date().toISOString();completed.push(outcome);
 writeFileSync(resolve(root,'execution.json'),JSON.stringify({planPath,planned:plan.length,completed,interrupted},null,2));
 console.log(`  -> exit=${outcome.exitCode} ${outcome.error??''}`);
 await delay(3000);
}
console.log('Batch finished; all attempts retained.');
