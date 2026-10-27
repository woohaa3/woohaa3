import test from 'node:test';
import assert from 'node:assert/strict';
import {CompositeAssetRegistry,diagnosticMediaSources,countFindComparisons,runLookupDiagnostic} from './lookup-diagnostic.mjs';
import {generateFixture} from './fixture.mjs';
test('current resolver avoids repeated linear searches for pure text',()=>{
 const canvas=generateFixture({nodes:100,visible:24}).canvas;const registry=new CompositeAssetRegistry();
 const result=countFindComparisons(registry,canvas);
 assert.equal(result.comparisons,0);assert.equal(result.legacyTriangularComparisons,5050);assert.deepEqual(result.output,[]);
 assert.equal(Object.hasOwn(canvas.document.nodes,'find'),false);
 assert.deepEqual(registry.mediaSources(canvas,null),[]);
});
test('diagnostic guard retains registered adapter filtering, generation identity and playback semantics',()=>{
 const registry=new CompositeAssetRegistry(),canvas=generateFixture({nodes:60,visible:24}).canvas;
 const id=canvas.document.nodes[7].id;canvas.document.nodes[7].type='composite-asset';canvas.nodeData[id].extensionId='fixture-adapter';
 const playback={fixture:'playback'};let calls=0;
 registry.register({extensionId:'fixture-adapter',owner:'fixture-adapter',executionKey:()=>'',prepare:()=>null,mediaSources:(nodeId,data,received)=>{calls++;assert.equal(received,playback);assert.equal(data,canvas.nodeData[id]);return [{nodeId,planeId:'p',assetId:'a',kind:'image',sourceIdentity:'source'},{nodeId:'wrong-owner',planeId:'p2',assetId:'b',kind:'video',sourceIdentity:'wrong'}];}});
 const baseline=registry.mediaSources(canvas,playback),candidate=diagnosticMediaSources(registry,canvas,playback);
 assert.deepEqual(candidate,baseline);assert.equal(calls,2);assert.equal(candidate.length,1);assert.match(candidate[0].sourceIdentity,/fixture-adapter:1:source$/);
 assert.deepEqual(diagnosticMediaSources(registry,null,null),[]);
 canvas.document.nodes[7].type='text';assert.deepEqual(diagnosticMediaSources(registry,canvas,playback),[]);
});

test('tiny diagnostic emits independent paired raw timing and explicit scope limitations',()=>{
 const output=runLookupDiagnostic({sizes:[100],pairs:2,warmups:1,seed:42});
 assert.equal(output.metadata.runtime,'native Node.js');assert.equal(output.diagnosticOnly,true);
 const cell=output.cells[0];assert.equal(cell.comparisonCount,0);assert.equal(cell.legacyTriangularComparisons,5050);assert.equal(cell.countingIncludedInTiming,false);assert.equal(cell.rawMs.length,2);
 for(const row of cell.rawMs){assert.deepEqual([...row.order].sort(),['baseline','candidate']);assert.ok(row.baseline>=0);assert.ok(row.candidate>=0);}
 assert.match(output.metadata.limitations.join(' '),/not Chrome/);
});
