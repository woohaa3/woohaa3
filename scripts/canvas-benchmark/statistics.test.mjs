import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize,comparePairs,checkCompatibility } from './statistics.mjs';
test('nearest rank summaries retain insufficient p99 and empty unavailability',()=>{
 assert.equal(summarize([]),null);
 const s=summarize(Array.from({length:100},(_,i)=>i+1));
 assert.equal(s.p50,50);assert.equal(s.p95,95);assert.equal(s.p99,99);assert.equal(s.p99Sufficient,false);
 assert.equal(summarize(Array(1000).fill(7)).p99Sufficient,true);
 assert.throws(()=>summarize([NaN]));assert.throws(()=>summarize([Infinity]));
});
test('paired bootstrap is reproducible and estimates differences per pair',()=>{
 const pairs=[{baseline:10,candidate:8},{baseline:100,candidate:98},{baseline:1000,candidate:998}];
 const s=comparePairs(pairs,{seed:5,iterations:500});
 assert.deepEqual(s,comparePairs(pairs,{seed:5,iterations:500}));
 assert.equal(s.medianDifference,-2);assert.deepEqual(s.confidenceInterval,[-2,-2]);
 assert.equal(s.medianRelativeDifference,-0.02);
 assert.equal(comparePairs([{baseline:0,candidate:1}]).medianRelativeDifference,null);
 assert.equal(comparePairs([]),null);
 assert.throws(()=>comparePairs(pairs,{iterations:0}));
});
test('comparison compatibility requires explicit matching metadata',()=>{
 assert.deepEqual(checkCompatibility({gpu:'M4'},{gpu:'M4'},['gpu']),{compatible:true,mismatches:[]});
 assert.deepEqual(checkCompatibility({gpu:'M4'},{gpu:'M3'},['gpu']),{compatible:false,mismatches:['gpu']});
 assert.equal(checkCompatibility({}, {}, ['gpu']).compatible,false);
});
