// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ camera: undefined as unknown, controls: undefined as unknown }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  return { ...actual, WebGLRenderer: class { setPixelRatio() {} setClearColor() {} setSize() {} dispose() {} render(_scene: unknown, camera: unknown) { state.camera = camera; } } };
});
vi.mock('three/examples/jsm/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('three');
  return { OrbitControls: class { target = new Vector3(); constructor() { state.controls = this; } update() {} addEventListener() {} dispose() {} } };
});
vi.mock('@woohaa3/contracts', () => ({ sampleSomaMotion: (_motion: unknown, t: number) => ({ positions:new Float32Array([0,0,0,1,0,0,0,1,0]), jointPositions:new Float32Array([t*2,t*3,t*-4]) }) }));
import { Vector3, type PerspectiveCamera } from 'three';
import type { PreparedSomaMotion } from '@woohaa3/contracts';
import { createSomaRenderer } from './renderer.js';
afterEach(() => vi.unstubAllGlobals());
it('跟随水平位移，保留用户观察角度与跳跃高度，停止回到原位', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const canvas = document.createElement('canvas');
  const view = createSomaRenderer(canvas, { bindVertices:new Float32Array(9), faces:new Uint32Array([0,1,2]) } as PreparedSomaMotion);
  const camera = state.camera as PerspectiveCamera;
  const controls = state.controls as {target:Vector3};
  // User orbit changes should persist through following and reset.
  camera.position.add(new Vector3(1,2,3));
  const original = camera.position.clone(), target = controls.target.clone();
  view.sample(1);
  expect(camera.position.clone().sub(original).toArray()).toEqual([2,0,-4]);
  expect(controls.target.clone().sub(target).toArray()).toEqual([2,0,-4]);
  expect(camera.position.toArray().every(Number.isFinite)).toBe(true);
  view.sample(0);
  expect(camera.position.toArray()).toEqual(original.toArray());
  expect(controls.target.toArray()).toEqual(target.toArray());
  view.dispose();
});
