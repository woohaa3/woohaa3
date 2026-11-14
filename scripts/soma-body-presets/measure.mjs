// Run after contracts build: node --expose-gc scripts/soma-body-presets/measure.mjs
import { performance } from 'node:perf_hooks';
import { SOMA_BODY_PRESETS, directorCharacterScript, executeModelScriptVersioned } from '../../web/contracts/dist/index.js';
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed; };
const before = heap(), scenes = [], milliseconds = [];
for (const p of SOMA_BODY_PRESETS) {
  const started = performance.now();
  const result = executeModelScriptVersioned(directorCharacterScript('humanoid', p.id), 'woohaa-model-js-v2');
  if (!result.ok) throw new Error(JSON.stringify(result));
  milliseconds.push(performance.now() - started); scenes.push(result.scene);
}
const after = heap();
const again = executeModelScriptVersioned(directorCharacterScript('humanoid', SOMA_BODY_PRESETS[0].id), 'woohaa-model-js-v2');
const skin = scene => scene.ops.find(op => op.t === 'mesh').skin;
console.log(JSON.stringify({
  platform: `${process.platform}/${process.arch}`, node: process.version,
  catalogCount: scenes.length, compileMilliseconds: milliseconds,
  totalCompileMilliseconds: milliseconds.reduce((a,b)=>a+b,0),
  retainedHeapBytesAboveImportedBaseline: after-before,
  duplicateBodySharesImmutableSkinArrays: again.ok && skin(scenes[0]).indices === skin(again.scene).indices && skin(scenes[0]).weights === skin(again.scene).weights,
  float32PositionAndNormalBytesPerRendererInstance: 18056*3*4*2,
  note: 'Heap includes lazily decoded source data and all catalog Scene IRs; excludes renderer/GPU allocation. No rendering or FPS conclusion.'
}, null, 2));
