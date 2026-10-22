// 纯坐标/缓存/事件调度，不创建图像、绘制上下文或调用真实合成器。
import {expect,it,vi} from "vitest";
import {planSourceDetails,SourceDetailPreview,type DetailFrame,type DetailFrameScheduler,type DetailRequest} from "./source-detail-preview.js";
import type {EditorPreviewRegion} from "./editor-wasm.js";

const view={width:800,height:600,x:0,y:0,zoom:1};
function harness() {
  let id=0;const jobs=new Map<number,()=>void>();const stale:(()=>void)[]=[];
  const frames:DetailFrameScheduler={request:cb=>{jobs.set(++id,cb);stale.push(cb);return id;},cancel:key=>{jobs.delete(key);}};
  const read=vi.fn((r:EditorPreviewRegion)=>({ok:true as const,value:{width:r.width,height:r.height,pixels:new Uint8Array(r.width*r.height*4)}}));
  const publish=vi.fn<(frame:DetailFrame|null)=>void>(),fail=vi.fn();
  const details=new SourceDetailPreview(read,publish,fail,frames);
  const tick=()=>{const entry=jobs.entries().next().value;if(entry){const [key,job]=entry;jobs.delete(key);job();}};
  const drain=()=>{for(let i=0;jobs.size&&i<100;i++)tick();expect(jobs.size).toBe(0);};
  const request:DetailRequest={width:8000,height:6000,view,contentVersion:1};
  return {details,read,publish,fail,jobs,stale,tick,drain,request};
}

it("100% 的可见区域按源像素分块，并随共享平移/缩放变化",()=>{
  const plan=planSourceDetails(8000,6000,view);
  expect(plan.tiles.length).toBeGreaterThan(1);
  for(const tile of plan.tiles) {
    expect(tile.x%512).toBe(0);expect(tile.y%512).toBe(0);
    expect(tile.width).toBeLessThanOrEqual(512);expect(tile.height).toBeLessThanOrEqual(512);
  }
  // 可见源范围 x=3600..4400、y=2700..3300 被完整覆盖。
  for(const [x,y] of [[3600,2700],[4399,3299],[4000,3000]])
    expect(plan.tiles.some(t=>x>=t.x&&x<t.x+t.width&&y>=t.y&&y<t.y+t.height)).toBe(true);
  expect(planSourceDetails(8000,6000,{...view,x:1000}).tiles.every(t=>t.x<3600)).toBe(true);
  expect(planSourceDetails(8000,6000,{...view,zoom:16}).tiles.length).toBeLessThan(plan.tiles.length);
});

it("边缘分块按文档裁切；小图/缩小/图片在视口外不请求；超大视口有容量门禁",()=>{
  const edge=planSourceDetails(8001,6001,{width:50,height:50,x:-4000.5,y:-3000.5,zoom:1});
  expect(edge.tiles.some(t=>t.x+t.width===8001&&t.y+t.height===6001)).toBe(true);
  expect(edge.tiles.every(t=>t.x>=0&&t.y>=0&&t.x+t.width<=8001&&t.y+t.height<=6001)).toBe(true);
  for(const v of [{...view,zoom:.5},{...view,x:100000},{...view,width:0},{...view,zoom:NaN}]) expect(planSourceDetails(8000,6000,v).tiles).toEqual([]);
  expect(planSourceDetails(2048,2048,view).tiles).toEqual([]);
  expect(()=>planSourceDetails(8000,6000,{...view,width:8000,height:6000})).toThrow("上限");
});

it("每帧最多两次区域读取，完整版本就绪后一次发布，平移复用重叠块",()=>{
  const h=harness();h.details.update(h.request);
  expect(h.read).not.toHaveBeenCalled();expect(h.publish).toHaveBeenLastCalledWith(null);
  h.tick();expect(h.read).toHaveBeenCalledTimes(2);expect(h.publish).toHaveBeenCalledTimes(1);
  h.drain();const frame=h.publish.mock.lastCall![0]!;
  expect(frame.tiles).toHaveLength(planSourceDetails(8000,6000,view).tiles.length);
  expect(h.fail).not.toHaveBeenCalled();
  h.read.mockClear();h.details.update(h.request);
  expect(h.jobs.size).toBe(0);expect(h.read).not.toHaveBeenCalled();expect(h.publish.mock.lastCall![0]).toEqual(frame);
  h.details.update({...h.request,view:{...view,x:512}});h.drain();
  expect(h.read.mock.calls.length).toBeGreaterThan(0);expect(h.read.mock.calls.length).toBeLessThan(frame.tiles.length);
  h.details.dispose();
});

it("内容/草稿版本变化清空缓存，视图变化取消旧帧，迟到回调不发布",()=>{
  const h=harness();h.details.update(h.request);const old=h.stale[0];h.tick();
  h.details.update({...h.request,contentVersion:2});
  const count=h.read.mock.calls.length;old();expect(h.read).toHaveBeenCalledTimes(count);
  h.drain();expect(h.read.mock.calls.length-count).toBe(planSourceDetails(8000,6000,view).tiles.length);
  h.read.mockClear();h.details.update({...h.request,contentVersion:3});h.tick();
  h.details.clear();const calls=h.read.mock.calls.length;for(const cb of h.stale)cb();
  expect(h.read).toHaveBeenCalledTimes(calls);expect(h.publish).toHaveBeenLastCalledWith(null);expect(h.jobs.size).toBe(0);
  h.details.dispose();h.details.update(h.request);expect(h.jobs.size).toBe(0);
});

it("失败或坏数据不发布部分集合，同版本可重试，异常和容量拒绝保留基础路径",()=>{
  const h=harness();
  h.read.mockImplementationOnce(()=>{throw new Error("暂时失败");});
  h.details.update(h.request);h.drain();expect(h.fail).toHaveBeenLastCalledWith("暂时失败");
  expect(h.publish.mock.calls.every(([frame])=>frame===null)).toBe(true);
  h.details.update(h.request);h.drain();expect(h.publish.mock.lastCall![0]).not.toBeNull();
  h.read.mockImplementationOnce(r=>({ok:true,value:{width:r.width,height:r.height,pixels:new Uint8Array(0)}}));
  h.details.update({...h.request,contentVersion:2});h.drain();expect(h.fail).toHaveBeenLastCalledWith("源像素细节数据不完整");
  h.read.mockClear();h.details.update({...h.request,view:{...view,width:8000,height:6000}});
  expect(h.read).not.toHaveBeenCalled();expect(h.jobs.size).toBe(0);expect(h.fail.mock.lastCall![0]).toContain("上限");
  h.details.dispose();
});

it("发布回调触发清理时不再建立旧任务",()=>{
  const h=harness();h.publish.mockImplementationOnce(()=>h.details.dispose());
  h.details.update(h.request);expect(h.jobs.size).toBe(0);expect(h.read).not.toHaveBeenCalled();
});

it("局部改动仅重读相交块；未知/非法范围清空，确定无像素变化则复用",()=>{
  const h=harness();h.details.update(h.request);h.drain();
  const initial=h.publish.mock.lastCall![0]!;
  const tile=initial.tiles[0];h.read.mockClear();
  h.details.update({...h.request,contentVersion:2,changedRegions:[{x:tile.x,y:tile.y,width:1,height:1}]});h.drain();
  expect(h.read).toHaveBeenCalledTimes(1);
  const updated=h.publish.mock.lastCall![0]!;
  for(const old of initial.tiles) {
    const next=updated.tiles.find(t=>t.key===old.key)!;
    if(old.key===tile.key)expect(next.preview).not.toBe(old.preview);
    else expect(next.preview).toBe(old.preview);
  }
  h.read.mockClear();h.details.update({...h.request,contentVersion:3,changedRegions:[]});
  expect(h.read).not.toHaveBeenCalled();expect(h.jobs.size).toBe(0);
  h.details.update({...h.request,contentVersion:4,changedRegions:[{x:-1,y:0,width:1,height:1}]});h.drain();
  expect(h.read).toHaveBeenCalledTimes(initial.tiles.length);
  h.details.dispose();
});

it("局部预览同步暂停旧读取，保留上次完整画面并立即只重读受影响块",()=>{
  const h=harness();h.details.update(h.request);h.drain();
  const before=h.publish.mock.lastCall![0]!;
  expect(h.details.hasCoverage(8000,6000,view)).toBe(true);
  expect(h.details.hasCoverage(8000,6000,{...view,x:10000})).toBe(false);
  const tile=before.tiles[0];h.read.mockClear();h.publish.mockClear();
  h.details.pause();expect(h.publish).not.toHaveBeenCalled();
  h.details.update({...h.request,contentVersion:2,keepPrevious:true,immediate:true,changedRegions:[{x:tile.x,y:tile.y,width:1,height:1}]});
  expect(h.read).toHaveBeenCalledTimes(1);expect(h.jobs.size).toBe(0);
  expect(h.publish).toHaveBeenCalledOnce();expect(h.publish.mock.lastCall![0]).not.toBeNull();
  h.details.update({...h.request,contentVersion:2,keepPrevious:true,view:{...view,zoom:.5}});
  expect(h.publish).toHaveBeenLastCalledWith(null);expect(h.jobs.size).toBe(0);
  h.details.clear();expect(h.details.hasCoverage(8000,6000,view)).toBe(false);h.details.dispose();
});
