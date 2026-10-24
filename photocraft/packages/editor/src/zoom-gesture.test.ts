import {afterEach,expect,it,vi} from "vitest";
import {ZoomToolGesture,type ZoomGestureContext} from "./zoom-gesture.js";
afterEach(()=>vi.unstubAllGlobals());
function setup(scrubby=true){
 let now=0,id=0;const frames=new Map<number,FrameRequestCallback>();vi.spyOn(performance,"now").mockImplementation(()=>now);
 vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{frames.set(++id,callback);return id;});vi.stubGlobal("cancelAnimationFrame",(id:number)=>frames.delete(id));
 const rect=vi.fn(),publish=vi.fn((view:ZoomGestureContext["view"])=>{context.view=view;});
 const context:ZoomGestureContext={view:{x:0,y:0,zoom:.5},width:800,height:600,documentWidth:1600,documentHeight:1200,scrubby,center:false,publish};
 const gesture=new ZoomToolGesture(()=>context,rect);
 return {gesture,context,publish,rect,frames,step:(time:number)=>{now=time;const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(time));}};
}
it("scrubby按原点每100屏幕像素翻倍，夹紧并消费最终松手；点击按阶梯",()=>{
 const {gesture,context,publish,frames}=setup();gesture.start({x:500,y:300},false);expect(publish).not.toHaveBeenCalled();gesture.move({x:600,y:300});expect(context.view).toEqual({x:-100,y:0,zoom:1});expect(frames.size).toBe(0);
 gesture.end({x:400,y:300},false);expect(context.view).toEqual({x:50,y:0,zoom:.25});expect(gesture.active).toBe(false);
 gesture.start({x:500,y:300},false);gesture.end({x:500,y:300},false);expect(context.view.zoom).toBe(1/3);
 gesture.start({x:500,y:300},true);gesture.end({x:500,y:300},true);expect(context.view.zoom).toBe(.25);
 gesture.start({x:500,y:300},false);gesture.end({x:100000,y:300},false);expect(context.view.zoom).toBe(128);
});
it("框选缩放只在释放发布并居中，小框和Alt退回离散缩放，取消不发布",()=>{
 const {gesture,context,publish,rect}=setup(false);gesture.start({x:200,y:150},false);gesture.move({x:400,y:300});expect(publish).not.toHaveBeenCalled();expect(rect.mock.lastCall).toEqual([{x:200,y:150,width:200,height:150}]);
 gesture.end({x:600,y:450},false);expect(context.view).toEqual({x:0,y:0,zoom:1});expect(rect.mock.lastCall).toEqual([null]);
 gesture.start({x:200,y:150},false);gesture.move({x:400,y:300});gesture.cancel();expect(publish).toHaveBeenCalledOnce();
 gesture.start({x:200,y:150},true);gesture.end({x:600,y:450},true);expect(context.view.zoom).toBe(2/3);
});
it("300ms按住才连续缩放，Alt反向；取消代际隔离旧帧",()=>{
 const {gesture,context,publish,frames,step}=setup();gesture.start({x:400,y:300},false);step(299);expect(publish).not.toHaveBeenCalled();step(316);expect(context.view.zoom).toBeGreaterThan(.5);step(332);expect(context.view.zoom).toBeGreaterThan(.51);
 const before=context.view.zoom;gesture.end({x:400,y:300},false);expect(context.view.zoom).toBe(before);expect(frames.size).toBe(0);
 gesture.start({x:400,y:300},true);step(648);expect(context.view.zoom).toBeLessThan(before);
 const stale=[...frames.values()][0],count=publish.mock.calls.length;gesture.cancel();gesture.start({x:400,y:300},false);stale(700);expect(publish).toHaveBeenCalledTimes(count);gesture.cancel();expect(frames.size).toBe(0);
});
