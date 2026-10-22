import { describe, expect, it, vi } from 'vitest';
import { FilmSetVideoExportSession, videoSize, type FilmSetVideoExportDeps, type FilmSetVideoTarget } from '../src/authoring/browser/film-set-video-export.js';
const target: FilmSetVideoTarget = {canvasId:'canvas',nodeId:'film',clipId:'parkour',sourceIdentity:'scene-v1',generation:3,title:'屋顶跑酷',duration:.105,aspect:'16:9',time:.06,playing:true,layoutIdentity:'layout'};
function fixture() {
  const encoder={add:vi.fn(async()=>{}),finish:vi.fn(async()=>new Blob(['encoded-video'],{type:'video/mp4'})),cancel:vi.fn(async()=>{})};
  const release=vi.fn();
  const deps: FilmSetVideoExportDeps = {
    isCurrent:vi.fn(()=>true),seek:vi.fn(),restore:vi.fn(),
    capture:vi.fn(async()=>({width:1280,height:720,rgba:new Uint8Array(4)})),
    createEncoder:vi.fn(async()=>encoder),acquire:vi.fn(async()=>release),
    upload:vi.fn(async()=>({ok:true as const,media:{storageKey:'sha256-movie',checksum:'movie',contentType:'video/mp4',size:13,url:'/api/media/movie',deduplicated:false}})),
    sourcePosition:vi.fn(()=>({x:123,y:456,width:1566})),submit:vi.fn(async()=>({ok:true as const}))
  };
  return {deps,encoder,release,session:new FilmSetVideoExportSession(deps)};
}
describe('film set video export',()=>{
 it('samples exactly one whole clip at 30 fps, holds endpoint, saves stable video next to the source in one command batch and restores playback',async()=>{
  const f=fixture(),progress=vi.fn();const result=await f.session.run(target,progress);
  expect(result.ok).toBe(true);expect(f.session.busy).toBe(false);
  expect(vi.mocked(f.deps.seek).mock.calls.map(x=>x[0])).toEqual([0,1/30,2/30,.105]);
  const frames=f.encoder.add.mock.calls as unknown as [unknown,number,number][];
  expect(frames.map(x=>x[1])).toEqual([0,1/30,2/30,.1]);
  expect(frames.reduce((t,x)=>t+x[2],0)).toBeCloseTo(.105,10);
  expect(f.encoder.finish).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledTimes(1);expect(f.deps.restore).toHaveBeenCalledTimes(1);expect(f.deps.restore).toHaveBeenCalledWith(target);
  const file=vi.mocked(f.deps.upload).mock.calls[0][0];expect(file.type).toBe('video/mp4');expect(file.name).toBe('屋顶跑酷.mp4');
  const commands=vi.mocked(f.deps.submit).mock.calls[0][0];expect(commands.map(c=>c.type)).toEqual(['asset.upsert','node.add']);
  const node=commands.find(c=>c.type==='node.add');expect(node).toMatchObject({node:{type:'video',position:{x:1705,y:456}},nodeData:{resourceKind:'video',filmSetVideoOrigin:{clipId:'parkour',sourceIdentity:'scene-v1',duration:.105}}});
  expect(progress).toHaveBeenLastCalledWith({phase:'saving',completed:4,total:4});
 });
 it('cancels after a frame without uploading or writing, releases capture and is retryable',async()=>{
  const f=fixture();vi.mocked(f.deps.capture).mockImplementationOnce(async()=>{f.session.cancel();return{width:1280,height:720,rgba:new Uint8Array(4)};});
  expect(await f.session.run(target,vi.fn())).toMatchObject({ok:false,code:'canceled'});expect(f.deps.upload).not.toHaveBeenCalled();expect(f.deps.submit).not.toHaveBeenCalled();expect(f.encoder.cancel).toHaveBeenCalled();expect(f.release).toHaveBeenCalled();expect(f.deps.restore).toHaveBeenCalled();
  expect((await f.session.run(target,vi.fn())).ok).toBe(true);
 });
 it('rejects a changed clip or lost write permission during upload with no late node',async()=>{
  const f=fixture();let current=true;vi.mocked(f.deps.isCurrent).mockImplementation(()=>current);
  vi.mocked(f.deps.upload).mockImplementationOnce(async()=>{current=false;return{ok:true as const,media:{storageKey:'movie',checksum:'movie',contentType:'video/mp4',size:13,url:'/api/media/movie',deduplicated:false}};});
  expect(await f.session.run(target,vi.fn())).toMatchObject({ok:false,message:expect.stringContaining('已变化')});expect(f.deps.submit).not.toHaveBeenCalled();expect(f.session.busy).toBe(false);
 });
 it('shows a renderer error and restores the player instead of publishing a partial video',async()=>{
  const f=fixture();vi.mocked(f.deps.capture).mockRejectedValueOnce(new Error('第 0.03 秒的镜头捕捉超时'));
  expect(await f.session.run(target,vi.fn())).toMatchObject({ok:false,message:'第 0.03 秒的镜头捕捉超时'});expect(f.encoder.finish).not.toHaveBeenCalled();expect(f.deps.upload).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalled();expect(f.deps.restore).toHaveBeenCalled();
 });
 it('surfaces durable command rejection, not success',async()=>{
  const f=fixture();vi.mocked(f.deps.submit).mockResolvedValueOnce({ok:false,error:'服务器拒绝保存'});
  expect(await f.session.run(target,vi.fn())).toMatchObject({ok:false,message:'视频节点保存失败：服务器拒绝保存'});expect(f.session.busy).toBe(false);
 });
 it('cancellation during upload prevents insertion',async()=>{
  const f=fixture();vi.mocked(f.deps.upload).mockImplementationOnce(async()=>{f.session.cancel();return{ok:true as const,media:{storageKey:'movie',checksum:'movie',contentType:'video/mp4',size:13,url:'/api/media/movie',deduplicated:false}};});
  expect(await f.session.run(target,vi.fn())).toMatchObject({ok:false,code:'canceled'});expect(f.deps.submit).not.toHaveBeenCalled();
 });
 it('aborts a pending upload and releases the player without waiting for a network response',async()=>{
  const f=fixture();vi.mocked(f.deps.upload).mockImplementationOnce((_file,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve({ok:false,error:'上传已取消'}),{once:true})));
  const run=f.session.run(target,vi.fn());await vi.waitFor(()=>expect(f.deps.upload).toHaveBeenCalledTimes(1));f.session.cancel();
  expect(await run).toMatchObject({ok:false,code:'canceled'});expect(f.session.busy).toBe(false);expect(f.deps.submit).not.toHaveBeenCalled();expect(f.deps.restore).toHaveBeenCalledTimes(1);
 });
 it('unsupported encoding and empty timelines make no canvas changes',async()=>{
  const f=fixture();vi.mocked(f.deps.createEncoder).mockRejectedValueOnce(new Error('当前浏览器不支持视频编码'));
  expect(await f.session.run(target,vi.fn())).toMatchObject({ok:false,message:'当前浏览器不支持视频编码'});expect(f.deps.acquire).not.toHaveBeenCalled();expect(f.deps.submit).not.toHaveBeenCalled();
  expect(await f.session.run({...target,duration:0},vi.fn())).toMatchObject({ok:false,message:expect.stringContaining('时长')});
 });
 it('preserves even output dimensions for all camera orientations',()=>{
  expect(videoSize('16:9')).toEqual({width:1280,height:720});expect(videoSize('9:16')).toEqual({width:720,height:1280});expect(videoSize('1:1')).toEqual({width:720,height:720});
 });
 it('hd60 按 60fps 采样并记录 1920×1080/60 的成片元数据',async()=>{
  const f=fixture();
  const result=await f.session.run({...target,profile:'hd60'},vi.fn());
  expect(result.ok).toBe(true);
  // ceil(0.105 * 60) = 7 帧；末端停在 duration。
  expect(f.encoder.add.mock.calls).toHaveLength(7);
  const commands=vi.mocked(f.deps.submit).mock.calls[0][0];
  const asset=commands.find(c=>c.type==='asset.upsert');
  expect(asset).toMatchObject({asset:{metadata:{width:1920,height:1080,frameRate:60}}});
  const node=commands.find(c=>c.type==='node.add');
  expect(node).toMatchObject({nodeData:{filmSetVideoOrigin:{profile:'hd60',frameRate:60,aspect:'16:9'}}});
 });
});
