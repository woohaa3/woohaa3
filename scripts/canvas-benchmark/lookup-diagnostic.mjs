#!/usr/bin/env node
/** Causal algorithm probe only. Never a production implementation or FPS estimate. */
import {CompositeAssetRegistry} from '../../web/frontend/src/extension-api/composite-assets.ts';
import {generateFixture} from './fixture.mjs';
import {summarize,comparePairs} from './statistics.mjs';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export {CompositeAssetRegistry};

/** Build the index anew on EVERY call; all composite nodes delegate the actual resolver. */
export function diagnosticMediaSources(registry,canvas,playback=null) {
  const byId=new Map((canvas?.document.nodes??[]).map(node=>[node.id,node]));
  const diagnostic=Object.create(registry);
  diagnostic.resolve=(source,id)=>byId.get(id)?.type==='composite-asset'?registry.resolve(source,id):null;
  // Keep the actual mediaSources adapter invocation, owner filtering and identity mapping.
  return CompositeAssetRegistry.prototype.mediaSources.call(diagnostic,canvas,playback);
}

/** Count separately from timing. Restoration also happens when an adapter throws. */
export function countFindComparisons(registry,canvas,playback=null) {
  const nodes=canvas.document.nodes,descriptor=Object.getOwnPropertyDescriptor(nodes,'find'),original=nodes.find;
  let comparisons=0;
  Object.defineProperty(nodes,'find',{configurable:true,writable:true,value:function(predicate,thisArg){
    return original.call(this,(node,index,array)=>{comparisons++;return predicate.call(thisArg,node,index,array);});
  }});
  try {
    const output=registry.mediaSources(canvas,playback);
    return {comparisons,output,legacyTriangularComparisons:nodes.length*(nodes.length+1)/2};
  } finally {if(descriptor)Object.defineProperty(nodes,'find',descriptor);else delete nodes.find;}
}

/** Explicit opt-in CLI execution only. Native Node/V8 times are not browser end-to-end times. */
export function runLookupDiagnostic({sizes=[100,1000,3000,5000,10000,20000],pairs=7,warmups=2,seed=42}={}) {
  if(!Array.isArray(sizes)||sizes.some(n=>!Number.isSafeInteger(n)||n<48||n>50000)||!sizes.length)throw new RangeError('sizes must be integers from 48 to 50000');
  if(!Number.isSafeInteger(pairs)||pairs<1||!Number.isSafeInteger(warmups)||warmups<1||!Number.isSafeInteger(seed))throw new RangeError('pairs/warmups must be positive integers; seed must be an integer');
  let state=seed>>>0,sink=0;
  const random=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};
  const cells=[];
  for(const nodes of sizes){
    const fixture=generateFixture({nodes,visible:24,seed:42}),registry=new CompositeAssetRegistry();
    const counted=countFindComparisons(registry,fixture.canvas);
    // Counting wrapper has been removed before all warmup/timed calls.
    const operations={baseline:()=>registry.mediaSources(fixture.canvas,null),candidate:()=>diagnosticMediaSources(registry,fixture.canvas,null)};
    const warmupRows=[];
    for(let round=0;round<warmups;round++){
      const order=random()<.5?['baseline','candidate']:['candidate','baseline'];
      for(const name of order){sink+=operations[name]().length;}warmupRows.push({round,order});
    }
    const raw=[];
    for(let pair=0;pair<pairs;pair++){
      const order=random()<.5?['baseline','candidate']:['candidate','baseline'],row={pair,order};
      for(const name of order){const start=performance.now();const output=operations[name]();row[name]=performance.now()-start;sink+=output.length;}
      raw.push(row);
    }
    cells.push({nodes,fixtureHash:fixture.manifest.hash,comparisonCount:counted.comparisons,legacyTriangularComparisons:counted.legacyTriangularComparisons,countingIncludedInTiming:false,warmups:warmupRows,rawMs:raw,baselineMs:summarize(raw.map(row=>row.baseline)),candidateMs:summarize(raw.map(row=>row.candidate)),pairedDifference:comparePairs(raw,{seed,iterations:10000})});
  }
  const sourceHash=path=>createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex');
  return {version:1,diagnosticOnly:true,metadata:{runtime:'native Node.js',node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,registrySourceSha256:sourceHash('../../web/frontend/src/extension-api/composite-assets.ts'),diagnosticSourceSha256:sourceHash('./lookup-diagnostic.mjs'),seed,pairs,warmups,fixtureKind:'pure text',candidate:'diagnostic-only fresh byId type guard; composite resolution delegates actual registry',limitations:['Node/V8 microbenchmark is not Chrome, browser end-to-end latency, GPU performance or FPS.','Pure-text case isolates mediaSources/resolve lookup work only; no scene pipeline, rendering, interaction or residency.','Instrumented predicate counts are collected separately and never used as timing samples.','Fresh index allocation is included in every candidate timing; GC/JIT/order effects remain possible.','Semantic equivalence tests cover a small registered adapter, not arbitrary stateful adapter behavior.']},cells,sink};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const index=process.argv.indexOf('--out');const output=JSON.stringify(runLookupDiagnostic(),null,2)+'\n';
  if(index!==-1){if(!process.argv[index+1])throw new Error('--out requires a path');writeFileSync(process.argv[index+1],output);}else process.stdout.write(output);
}
