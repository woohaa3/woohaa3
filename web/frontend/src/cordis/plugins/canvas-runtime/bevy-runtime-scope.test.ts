import {it, expect, vi} from 'vitest';
import {prepareModelResource} from '@woohaa3/contracts';
import {loadBevyRuntime} from './bevy-runtime.js';
import {mockModule, sceneWith, v2Ops} from './test-support/runtime-harness.js';

it('setScene requires the matching canvas scope', async () => {
  const m = mockModule([]);
  Object.assign(m, {
    begin_canvas_scope: vi.fn(() => '42'),
    end_canvas_scope: vi.fn(),
    set_scene_scoped: vi.fn(() => 7),
    set_texture_scoped: vi.fn(),
    set_model_media_texture_scoped: vi.fn(),
    set_image_focus_details_scoped: vi.fn(),
    poll_texture_receipts_scoped: vi.fn(() => '[]'),
  });
  const runtime = await loadBevyRuntime({importModule: async () => m});
  const scene = {...sceneWith('k', 's'), canvasId: 'a'};
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    runtime.dispose();
  };
  try {
    expect(() => runtime.setScene(scene)).toThrow();
    runtime.openCanvasScope!('b');
    expect(() => runtime.setScene(scene)).toThrow();
    runtime.openCanvasScope!('a');
    runtime.setScene(scene);
    expect(m.set_scene_scoped).toHaveBeenCalled();
    expect((m.set_scene_scoped as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('42');
    dispose();
    expect(() => runtime.openCanvasScope!('a')).toThrow();
  } finally {
    dispose();
  }
});

it('identity check happens before model resource preparation', async () => {
  const calls: {kind: string; value: string}[] = [];
  const m = mockModule(calls);
  Object.assign(m, {
    begin_canvas_scope: vi.fn(() => '42'),
    end_canvas_scope: vi.fn(),
    set_scene_scoped: vi.fn(() => 7),
    set_texture_scoped: vi.fn(),
    set_model_media_texture_scoped: vi.fn(),
    set_image_focus_details_scoped: vi.fn(),
    poll_texture_receipts_scoped: vi.fn(() => '[]'),
  });
  expect(m.prepare_and_register_model_resource).toEqual(expect.any(Function));
  const runtime = await loadBevyRuntime({importModule: async () => m});
  const resource=prepareModelResource({sceneVersion:'woohaa-model-scene-ir-v2',ops:v2Ops(1)});
  const scene={...sceneWith(resource.resourceKey,resource.signature),canvasId:'a'};
  try {
    runtime.openCanvasScope!('b');
    expect(()=>runtime.setScene(scene,new Map([[resource.resourceKey,resource]]))).toThrow();
    expect(calls.filter(c=>c.kind==='prepare')).toHaveLength(0);
    expect(m.set_scene_scoped).not.toHaveBeenCalled();
    runtime.openCanvasScope!('a');
    runtime.setScene(scene,new Map([[resource.resourceKey,resource]]));
    expect(calls.filter(c=>c.kind==='prepare').length).toBeGreaterThan(0);
  } finally {
    runtime.dispose();
  }
});

it('scoped textures reject stale handles and wait for scoped receipts', async () => {
  const m = mockModule([]);
  delete m.poll_texture_receipts;
  let token = 0;
  const upload = vi.fn();
  const poll = vi.fn(() => JSON.stringify([['node','n',1,1,'asset']]));
  Object.assign(m, {
    begin_canvas_scope: vi.fn(() => String(++token)), end_canvas_scope: vi.fn(),
    set_scene_scoped: vi.fn(() => 1), set_texture_scoped: upload,
    set_model_media_texture_scoped: vi.fn(), set_image_focus_details_scoped: vi.fn(),
    poll_texture_receipts_scoped: poll
  });
  const runtime = await loadBevyRuntime({importModule: async () => m});
  const old = runtime.openCanvasScope!('a')!;
  const current = runtime.openCanvasScope!('b')!;
  const pixels = new Uint8Array([1,2,3,4]);
  expect(runtime.setTexture('n',1,1,pixels,{sourceKey:'asset',scope:old})).toBe(false);
  expect(upload).not.toHaveBeenCalled();
  expect(runtime.getRuntimeIssues!()).toHaveLength(0);
  expect(runtime.setTexture('n',1,1,pixels,{sourceKey:'asset',scope:current})).toBe(true);
  expect(upload).toHaveBeenCalledWith('2','n',1,1,pixels,'asset');
  expect(runtime.textureApplied!('n',1,1,'asset')).toBe(false);
  runtime.flushTextureReceipts!();
  expect(poll).toHaveBeenCalledWith('2');
  expect(runtime.textureApplied!('n',1,1,'asset')).toBe(true);
  runtime.openCanvasScope!('a');
  expect(runtime.textureApplied!('n',1,1,'asset')).toBe(false);
  runtime.dispose();
});

it('focus details reject stale scopes before encoding and use the current scoped channel', async () => {
  const m = mockModule([]);
  let next = 0;
  const send = vi.fn();
  Object.assign(m, {
    begin_canvas_scope: vi.fn(() => String(++next)), end_canvas_scope: vi.fn(),
    set_scene_scoped: vi.fn(() => 1), set_texture_scoped: vi.fn(),
    set_model_media_texture_scoped: vi.fn(), set_image_focus_details_scoped: send,
    poll_texture_receipts_scoped: vi.fn(() => '[]')
  });
  const runtime = await loadBevyRuntime({importModule: async () => m});
  const old = runtime.openCanvasScope!('a')!;
  const current = runtime.openCanvasScope!('b')!;
  const frame = {nodeId:'n',width:1,height:1,tiles:[{x:0,y:0,width:1,height:1,pixels:new Uint8Array([1,2,3,4])}]};
  expect(() => runtime.setImageFocusDetails!(frame,old)).toThrow();
  expect(send).not.toHaveBeenCalled();
  runtime.setImageFocusDetails!(frame,current);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe('2');
  expect(Array.from(send.mock.calls[0][2])).toEqual([1,2,3,4]);
  runtime.dispose();
});

it('notifies scope observers only on a real visit change', async () => {
  const m = mockModule([]); let token = 0;
  Object.assign(m, {
    begin_canvas_scope: vi.fn(() => String(++token)), end_canvas_scope: vi.fn(),
    set_scene_scoped: vi.fn(() => 1), set_texture_scoped: vi.fn(),
    set_model_media_texture_scoped: vi.fn(), set_image_focus_details_scoped: vi.fn(),
    poll_texture_receipts_scoped: vi.fn(() => '[]')
  });
  const runtime = await loadBevyRuntime({importModule: async () => m});
  const seen: string[] = [];
  const unsubscribe = runtime.subscribeCanvasScope!(() => seen.push(runtime.currentCanvasScope!()?.token ?? 'none'));
  const a = runtime.openCanvasScope!('a')!;
  runtime.openCanvasScope!('a');
  const b = runtime.openCanvasScope!('b')!;
  expect(runtime.closeCanvasScope!(a)).toBe(false);
  expect(seen).toEqual(['1','2']);
  expect(runtime.closeCanvasScope!(b)).toBe(true);
  expect(seen).toEqual(['1','2','none']);
  unsubscribe(); runtime.dispose();
});
