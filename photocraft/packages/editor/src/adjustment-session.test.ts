import {afterEach,describe,expect,it,vi} from "vitest";
import {AdjustmentSession} from "./adjustment-session.js";

afterEach(()=>vi.unstubAllGlobals());
function setup() {
  const frames=new Map<number,FrameRequestCallback>();let id=0;
  vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{frames.set(++id,callback);return id;});
  // 故意保留取消后的回调，验证迟到帧隔离。
  vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const port={beginAdjustment:vi.fn(()=>({ok:true as const,value:{layer:1}})),
    previewAdjustment:vi.fn((_params:unknown)=>({ok:true as const,value:{}})),
    commitAdjustment:vi.fn(()=>({ok:true as const,value:{} as never})),cancelAdjustment:vi.fn()};
  const refresh=vi.fn(),error=vi.fn(),info=vi.fn();
  return {port,frames,refresh,error,info,session:new AdjustmentSession(port,refresh,error,info)};
}
describe("调整参数会话",()=>{
  it("合并同帧部分参数并补齐末帧，确认仅调用一次提交",()=>{
    const {session,port,frames}=setup();session.begin(1);
    session.preview({brightness:10});session.preview({contrast:20});session.preview({brightness:30});
    expect(frames.size).toBe(1);frames.get(1)!(0);
    expect(port.previewAdjustment).toHaveBeenLastCalledWith({brightness:30,contrast:20});
    session.preview({contrast:40});expect(session.commit()).toBe(true);
    expect(port.previewAdjustment).toHaveBeenLastCalledWith({contrast:40});
    expect(port.commitAdjustment).toHaveBeenCalledTimes(1);expect(session.active).toBe(false);
    frames.get(2)!(0);expect(port.previewAdjustment).toHaveBeenCalledTimes(2);
  });
  it("预览失败保留待修正参数，不确认上一版成功预览",()=>{
    const {session,port,error}=setup();session.begin(1);
    port.previewAdjustment.mockReturnValueOnce({ok:false,code:"bad-params",message:"参数无效"} as never);
    session.preview({hue:999});expect(session.commit()).toBe(false);
    expect(session.active).toBe(true);expect(port.commitAdjustment).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("参数无效");
    session.preview({hue:20});expect(session.commit()).toBe(true);
    expect(port.previewAdjustment).toHaveBeenLastCalledWith({hue:20});
  });
  it("取消后的迟到帧不消费下一会话，控制点使用快照",()=>{
    const {session,port,frames}=setup();session.begin(1);session.preview({brightness:10});session.cancel();
    session.begin(2);const points:[number,number][]=[[0,0],[255,255]];session.preview({points});points[0][1]=40;
    frames.get(1)!(0);expect(port.previewAdjustment).not.toHaveBeenCalled();
    frames.get(2)!(0);expect(port.previewAdjustment).toHaveBeenCalledWith({points:[[0,0],[255,255]]});
    session.cancel();expect(port.cancelAdjustment).toHaveBeenCalledTimes(2);
    expect(port.commitAdjustment).not.toHaveBeenCalled();
  });
  it("提交失败保留会话，取消和再次确认可用",()=>{
    const {session,port}=setup();session.begin(1);session.preview({lightness:10});
    port.commitAdjustment.mockReturnValueOnce({ok:false,code:"command-failed",message:"提交失败"} as never);
    expect(session.commit()).toBe(false);expect(session.active).toBe(true);
    expect(session.commit()).toBe(true);expect(port.previewAdjustment).toHaveBeenCalledTimes(1);
    session.cancel();expect(port.cancelAdjustment).not.toHaveBeenCalled();
  });
});
