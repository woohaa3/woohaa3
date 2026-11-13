import { describe, it, expect, vi } from 'vitest';
import { DirectorSomaMotionCache } from './director-soma-motion.js';
import type { ServerCanvas, PreparedSomaMotion, WorldSomaClipTrack } from '@woohaa3/contracts';
const mocks = vi.hoisted(() => ({ load: vi.fn(), validateBody: vi.fn(), tracks: [] as unknown[] }));
vi.mock('./soma-motion.js', () => ({ loadSomaMotion: mocks.load }));
vi.mock('./media-remote.js', () => ({ resolveCanonicalMediaUrl: (asset: {id:string} | undefined) => asset ? '/api/media/'+asset.id : null }));
vi.mock('@woohaa3/contracts', async original => ({ ...await original<object>(), validateSomaBodyAdaptation: mocks.validateBody, decodeSceneAreaData: (value: {script?:string}|undefined) => ({ok:true,value:{animationScript:{script:value?.script ?? '',duration:1,loop:false}}}), executeWorldAnimationScript: (source: string) => ({ok:true,ir:{somaTracks:source === 'bad' ? [{assetId:'missing'}] : mocks.tracks}}) }));
const track = (id: string) => ({targetId:'actor',assetId:id,checksum:'a'.repeat(64),fps:30,frameCount:2,startTime:0,endTime:1,jointPrefix:'soma'}) as WorldSomaClipTrack;
const canvas = (ids: string[]) => ({id:'c', document:{nodes:[{id:'area'}]},nodeData:{area:{}},assets:ids.map(id=>({id}))}) as unknown as ServerCanvas;
describe('director SOMA cache', () => {
 it('prepares once, bounds concurrency and resolves only the current asset version', async () => {
  const completions: (()=>void)[]=[];
  mocks.load.mockImplementation(() => new Promise(resolve=>completions.push(()=>resolve({frameCount:2} as PreparedSomaMotion))));
  mocks.tracks=['a','b','c'].map(track);
  const cache=new DirectorSomaMotionCache(), changed=vi.fn();
  cache.sync(canvas(['a','b','c']),changed);
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(cache.snapshot()).toBe("动作加载中…");
  completions.shift()!(); await new Promise(resolve=>setTimeout(resolve,0));
  expect(mocks.load).toHaveBeenCalledTimes(3);
  expect(cache.resolve(track('a'))).toEqual({frameCount:2});
  expect(mocks.load.mock.calls[0]!.slice(2)).toEqual([30,2,'a'.repeat(64)]);
  cache.sync(canvas([]),changed);
  completions.forEach(done=>done()); await expect(cache.ready()).rejects.toThrow('不存在');
  expect(cache.resolve(track('a'))).toBeUndefined();
  expect(cache.snapshot()).toContain("动作加载失败");
  cache.dispose();
 });
});

it('scopes capture preparation and supports more than four small clips', async () => {
 mocks.load.mockReset().mockResolvedValue({frameCount:2});
 mocks.tracks=['a','b','c','d','e','f'].map(track);
 const data=canvas(['a','b','c','d','e','f']);
 data.document.nodes.push({id:'other'} as never);
 data.nodeData.other={sceneArea:{script:'bad'}} as never;
 const cache=new DirectorSomaMotionCache();
 cache.sync(data,vi.fn(),new Set(['area']));
 await expect(cache.ready()).resolves.toBeUndefined();
 expect(mocks.load).toHaveBeenCalledTimes(6);
 expect(cache.snapshot()).toBeNull();
 cache.sync(data,vi.fn(),new Set());
 await expect(cache.ready()).resolves.toBeUndefined();
 expect(cache.resolve(track('a'))).toBeUndefined();
 cache.dispose();
});


it('retries a failed load only on request, preserving prepared clips and resource identity', async () => {
 mocks.load.mockReset().mockImplementation((url: string) => url.endsWith('/a') ? Promise.reject(new Error('HTTP 502')) : Promise.resolve({frameCount:2}));
 mocks.tracks=['a','b'].map(track);
 const data=canvas(['a','b']), cache=new DirectorSomaMotionCache();
 cache.sync(data,vi.fn());
 await expect(cache.ready()).rejects.toThrow('HTTP 502');
 await new Promise(resolve=>setTimeout(resolve,0));
 cache.sync({...data},vi.fn());
 expect(mocks.load).toHaveBeenCalledTimes(2);
 const firstSignal=mocks.load.mock.calls[0]![1] as AbortSignal;
 mocks.load.mockResolvedValue({frameCount:2});
 cache.retryFailed();
 await expect(cache.ready()).resolves.toBeUndefined();
 expect(mocks.load).toHaveBeenCalledTimes(3);
 expect(firstSignal.aborted).toBe(true);
 expect(mocks.load.mock.calls[2]!.slice(2)).toEqual([30,2,'a'.repeat(64)]);
 expect(cache.resolve(track('b'))).toEqual({frameCount:2});
 expect(cache.snapshot()).toBeNull();
 cache.dispose();
 cache.retryFailed();
 expect(mocks.load).toHaveBeenCalledTimes(3);
});

 it('shares one immutable source across all adult and age target adaptation identities',async()=>{
  const {SOMA_BODY_PRESETS,SOMA_BODY_ADAPTATION_VERSION}=await import('@woohaa3/contracts');
  mocks.load.mockReset().mockResolvedValue({frameCount:2});mocks.validateBody.mockClear();
  const tracks=SOMA_BODY_PRESETS.map((p):WorldSomaClipTrack=>({...track('shared'),targetId:p.id,targetBodyPreset:p.id,adaptationVersion:SOMA_BODY_ADAPTATION_VERSION}));
  mocks.tracks=tracks;const cache=new DirectorSomaMotionCache();cache.sync(canvas(['shared']),vi.fn());
  await cache.ready();expect(mocks.load).toHaveBeenCalledTimes(1);
  expect(new Set(mocks.validateBody.mock.calls.map(call=>call[1])).size).toBe(SOMA_BODY_PRESETS.length);
  for(const t of tracks)expect(cache.resolve(t)).toBe(cache.resolve(tracks[0]!));
  cache.dispose();
 });
