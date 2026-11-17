import { expect, it, vi } from 'vitest';
import { installInteractionController } from './interaction-controller.js';
import { woohaa3CanvasStore } from '../../services/canvas-state/index.js';
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from './test-support/controller-harness.js';

installSharedSession();

it('opens the canvas scope before texture sync and closes its handle on dispose', () => {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{id:'n1',x:0,y:0}]));
  const dom = harness();
  const {runtime} = runtimeCapturing();
  const events: string[] = [];
  const handle = Object.freeze({canvasId:'c1',token:'1',sequence:1});
  runtime.openCanvasScope = vi.fn(() => {events.push('open'); return handle;});
  runtime.closeCanvasScope = vi.fn(() => {events.push('close'); return true;});
  const textureSync = {sync: () => events.push('texture'), textureNodeIds: () => new Set<string>(), dispose: () => {}};
  const controller = installInteractionController({canvas:dom.canvas,getRuntime:()=>runtime,getSession:()=>getSession() as never,target:dom.target as never,textureSync});
  controller.flush();
  expect(events.indexOf('open')).toBeGreaterThanOrEqual(0);
  expect(events.indexOf('texture')).toBeGreaterThan(events.indexOf('open'));
  expect(runtime.openCanvasScope).toHaveBeenCalledWith('c1');
  controller.dispose();
  expect(runtime.closeCanvasScope).toHaveBeenCalledWith(handle);
});

it('scope opening failure prevents texture sync and scene submission', () => {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{id:'n1',x:0,y:0}]));
  const dom = harness();
  const {runtime,scenes} = runtimeCapturing();
  runtime.openCanvasScope = vi.fn(() => { throw new Error('scope failed'); });
  const sync = vi.fn();
  const textureSync = {sync,textureNodeIds:()=>new Set<string>(),dispose:()=>{}};
  const controller = installInteractionController({canvas:dom.canvas,getRuntime:()=>runtime,getSession:()=>getSession() as never,target:dom.target as never,textureSync});
  controller.flush();
  expect(runtime.openCanvasScope).toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
  expect(scenes).toHaveLength(0);
  controller.dispose();
});

it('switches visits without letting stale cleanup end the new scope', () => {
  woohaa3CanvasStore.getState().applyRemoteCanvas({...canvasWith([{id:'n1',x:0,y:0}]),id:'a'});
  const dom = harness();
  const {runtime} = runtimeCapturing();
  let current: {canvasId:string;token:string;sequence:number} | null = null;
  let counter = 0;
  const closed: string[] = [];
  runtime.openCanvasScope = vi.fn((id: string) => {
    if (current?.canvasId === id) return current;
    current = Object.freeze({canvasId:id,token:String(++counter),sequence:counter});
    return current;
  });
  runtime.closeCanvasScope = vi.fn(handle => {
    if (current !== handle) return false;
    closed.push(handle.token); current = null; return true;
  });
  const controller = installInteractionController({canvas:dom.canvas,getRuntime:()=>runtime,getSession:()=>getSession() as never,target:dom.target as never});
  controller.flush();
  const a = current!;
  woohaa3CanvasStore.getState().applyRemoteCanvas({...canvasWith([{id:'n1',x:0,y:0}]),id:'b'});
  controller.flush();
  const b = current!;
  expect(b.canvasId).toBe('b');
  expect(b).not.toBe(a);
  expect(closed).toEqual([]);
  woohaa3CanvasStore.getState().applyRemoteCanvas({...canvasWith([{id:'n1',x:0,y:0}]),id:'a'});
  controller.flush();
  const again = current!;
  expect(again.canvasId).toBe('a');
  expect(again).not.toBe(a);
  expect(closed).toEqual([]);
  controller.dispose();
  expect(closed).toEqual([again.token]);
});
