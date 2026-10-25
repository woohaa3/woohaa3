import { expect, it } from 'vitest';
import { createEmptyWoohaa3ServerCanvas } from './domain/index.js';
import { buildCanvasRenderScene, renderSceneFingerprint, stablePresentationStringify } from './render-scene/scene-builder.js';
import { prepareModelResource } from './prepared-model.js';

it('complete lightweight projection fingerprints group additions, updates, deletions and future fields', () => {
  const canvas = createEmptyWoohaa3ServerCanvas('fingerprint');
  canvas.document.nodes.push({ id: 'g', type: 'group', position: { x: 0, y: 0 }, width: 500, height: 400 });
  const scene = buildCanvasRenderScene({ canvas });
  const initial = renderSceneFingerprint(scene);
  scene.nodes[0].group!.runStatus = { label: '开始', state: 'running' };
  const running = renderSceneFingerprint(scene); expect(running).not.toBe(initial);
  scene.nodes[0].group!.runStatus!.label = '提交'; expect(renderSceneFingerprint(scene)).not.toBe(running);
  delete scene.nodes[0].group!.runStatus; expect(renderSceneFingerprint(scene)).toBe(initial);
  const extended = scene.nodes[0] as typeof scene.nodes[0] & { future?: { a: number; b?: number } };
  extended.future = { a: 1, b: 2 }; const future = renderSceneFingerprint(scene); expect(future).not.toBe(initial);
  extended.future = { b: 2, a: 1 }; expect(renderSceneFingerprint(scene)).toBe(future);
  expect(stablePresentationStringify({ a: undefined, b: { z: 1, a: 2 } })).toBe(stablePresentationStringify({ b: { a: 2, z: 1 } }));
});
it('large scene fingerprint only visits lightweight projections and records CPU work separately from GPU', () => {
  const canvas = createEmptyWoohaa3ServerCanvas('cpu');
  canvas.document.nodes = Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, type: 'model3d', position: { x: i * 260, y: 0 } }));
  const resource = prepareModelResource({ sceneVersion: 'woohaa-model-scene-ir-v2', ops: [] });
  Object.defineProperty(resource, 'ops', { get: () => { throw new Error('fingerprint must not read geometry'); } });
  Object.defineProperty(resource, 'payload', { get: () => { throw new Error('fingerprint must not read payload'); } });
  const scene = buildCanvasRenderScene({ canvas, modelResources: new Map(canvas.document.nodes.map(node => [node.id, resource])) });
  const start = performance.now();
  const first = renderSceneFingerprint(scene);
  for (let i = 0; i < 5; i++) expect(renderSceneFingerprint(scene)).toBe(first);
  const elapsed = performance.now() - start;
  console.info(JSON.stringify({ check: 'node-capability-fingerprint-cpu', nodes: 2000, iterations: 6, elapsedMs: elapsed }));
  expect(elapsed).toBeLessThan(10000);
  expect(scene.nodes[0].model?.resourceKey).toBe(resource.resourceKey);
});
