import {expect,it} from 'vitest';
import {CanvasRuntimeHost} from './host.js';
import type {CanvasScope} from './canvas-scope.js';

it('rejects old focus writes and null clears after an A B A visit', () => {
  const a = Object.freeze({canvasId:'a',token:'1',sequence:1});
  const b = Object.freeze({canvasId:'b',token:'2',sequence:2});
  const again = Object.freeze({canvasId:'a',token:'3',sequence:3});
  let current: CanvasScope | null = a;
  const host = new CanvasRuntimeHost({} as never);
  const internals = host as unknown as {
    runtimeInstance: unknown;
    imageFocusStore: {getTexture(): {scope?:CanvasScope}|null;getDetails(): {scope?:CanvasScope}|null};
    videoFocusStore: {getTexture(): {scope?:CanvasScope}|null};
  };
  internals.runtimeInstance = {canvasScopeMode:()=> 'scoped', currentCanvasScope:()=>current};
  const texture = {nodeId:'n',width:1,height:1,pixels:new Uint8Array(4)};
  const details = {nodeId:'n',width:1,height:1,tiles:[{x:0,y:0,width:1,height:1,pixels:new Uint8Array(4)}]};
  host.setImageFocusTexture(texture,a);
  current = b;
  host.setImageFocusTexture(texture,b);
  host.setImageFocusDetails(details,b);
  host.setVideoFocusTexture(texture,b);
  host.setImageFocusTexture(null,a);
  host.setImageFocusDetails(null,a);
  host.setVideoFocusTexture(null,a);
  expect(internals.imageFocusStore.getTexture()?.scope).toBe(b);
  expect(internals.imageFocusStore.getDetails()?.scope).toBe(b);
  expect(internals.videoFocusStore.getTexture()?.scope).toBe(b);
  current = again;
  host.setImageFocusTexture(texture,again);
  host.setImageFocusTexture(null,a);
  expect(internals.imageFocusStore.getTexture()?.scope).toBe(again);
  host.setImageFocusTexture(null,again);
  expect(internals.imageFocusStore.getTexture()).toBeNull();
});

it('rejects old projection and pending callbacks', () => {
  const a = Object.freeze({canvasId:'a',token:'1',sequence:1});
  const b = Object.freeze({canvasId:'b',token:'2',sequence:2});
  let current: CanvasScope = a;
  const host = new CanvasRuntimeHost({} as never);
  const internals = host as unknown as {runtimeInstance:unknown;imageFocusStore:{setTargetId(id:string):void;isPending():boolean}};
  internals.runtimeInstance = {canvasScopeMode:()=> 'scoped', currentCanvasScope:()=>current};
  internals.imageFocusStore.setTargetId('n');
  const image = {nodeId:'n'} as never;
  const video = {nodeId:'n'} as never;
  host.setImageFocus(image,a);
  current = b;
  host.setImageFocus(image,b);
  host.setVideoFocus(video,b);
  host.setImageFocusPending(true,b);
  host.setImageFocus(null,a);
  host.setVideoFocus(null,a);
  host.setImageFocusPending(false,a);
  expect(host.imageFocusProjection()).toBe(image);
  expect(host.videoFocusProjection()).toBe(video);
  expect(internals.imageFocusStore.isPending()).toBe(true);
});
