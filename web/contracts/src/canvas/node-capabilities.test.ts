import { expect, it } from 'vitest';
import { createEmptyWoohaa3ServerCanvas } from './domain/index.js';
import { buildCanvasRenderScene, renderSceneFingerprint, stablePresentationStringify } from './render-scene/scene-builder.js';
import { prepareModelResource } from './prepared-model.js';
import { newWorldInstance } from './creation-scopes-ui.js';

it('lightweight projection fingerprints node additions and future fields', () => {
  const canvas = createEmptyWoohaa3ServerCanvas('fingerprint');
  canvas.document.nodes.push({ id: 'n1', type: 'text', position: { x: 0, y: 0 }, width: 500, height: 400 });
  const scene = buildCanvasRenderScene({ canvas });
  const initial = renderSceneFingerprint(scene);
  scene.nodes[0]!.title = '更新标题';
  const updated = renderSceneFingerprint(scene);
  expect(updated).not.toBe(initial);
  scene.nodes[0]!.title = '新节点';
  expect(renderSceneFingerprint(scene)).not.toBe(updated);
  const extended = scene.nodes[0] as typeof scene.nodes[0] & { future?: { a: number; b?: number } };
  extended.future = { a: 1, b: 2 }; const future = renderSceneFingerprint(scene); expect(future).not.toBe(initial);
  extended.future = { b: 2, a: 1 }; expect(renderSceneFingerprint(scene)).toBe(future);
  expect(stablePresentationStringify({ a: undefined, b: { z: 1, a: 2 } })).toBe(stablePresentationStringify({ b: { a: 2, z: 1 } }));
});
it('large scene fingerprint only visits lightweight projections and records CPU work separately from GPU', () => {
  const canvas = createEmptyWoohaa3ServerCanvas('cpu');
  canvas.document.nodes = Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, type: 'model3d' }));
  canvas.nodeData = Object.fromEntries(canvas.document.nodes.map((node, i) => [node.id, {
    sharedWorldInstance: newWorldInstance(`instance-${i}`, { x: i * 260, y: 0 })
  }]));
  const resource = prepareModelResource({ sceneVersion: 'woohaa-model-scene-ir-v2', ops: [] });
  const scene = buildCanvasRenderScene({ canvas, modelResources: new Map(canvas.document.nodes.map(node => [node.id, resource])) });
  // 场景装配可以读一次资源（世界地面锚点）；fingerprint 必须只看轻量投影。
  Object.defineProperty(resource, 'ops', { get: () => { throw new Error('fingerprint must not read geometry'); } });
  Object.defineProperty(resource, 'payload', { get: () => { throw new Error('fingerprint must not read payload'); } });
  const start = performance.now();
  const first = renderSceneFingerprint(scene);
  for (let i = 0; i < 5; i++) expect(renderSceneFingerprint(scene)).toBe(first);
  const elapsed = performance.now() - start;
  console.info(JSON.stringify({ check: 'node-capability-fingerprint-cpu', nodes: 2000, iterations: 6, elapsedMs: elapsed }));
  expect(elapsed).toBeLessThan(10000);
  expect(scene.nodes[0].model?.resourceKey).toBe(resource.resourceKey);
});
