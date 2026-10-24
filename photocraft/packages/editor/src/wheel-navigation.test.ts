import {it,expect} from "vitest";
import {WheelNavigation,type WheelContext,type WheelInput} from "./wheel-navigation.js";
const context:WheelContext={view:{x:0,y:0,zoom:.5},width:800,height:600,documentWidth:1600,documentHeight:900,anchor:{x:100,y:50},zoomWithScrollWheel:false,zoomWithTrackpadPinch:true};
const input=(patch:Partial<WheelInput>={}):WheelInput=>({deltaX:0,deltaY:3,deltaMode:1,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,timeStamp:0,...patch});
it("滚轮按像素/行/页平移，Shift和完整Ctrl鼠标格横移；Alt倍率准确锚点稳定",()=>{
 const nav=new WheelNavigation();expect(nav.apply(input(),context)).toEqual({x:0,y:-120,zoom:.5});
 expect(nav.apply(input({shiftKey:true}),context)).toEqual({x:-120,y:0,zoom:.5});
 expect(nav.apply(input({ctrlKey:true}),context)).toEqual({x:-120,y:0,zoom:.5});
 expect(nav.apply(input({deltaMode:0,deltaY:100,ctrlKey:true}),context)).toEqual({x:-100,y:0,zoom:.5});
 expect(nav.apply(input({deltaMode:2,deltaY:1}),context)).toEqual({x:0,y:-600,zoom:.5});
 const next=nav.apply(input({deltaY:-3,altKey:true}),context)!;expect(next.zoom).toBeCloseTo(.55);expect((100-next.x)/next.zoom).toBeCloseTo(200);expect((50-next.y)/next.zoom).toBeCloseTo(100);
 expect(nav.apply(input({altKey:true}),{...context,zoomWithScrollWheel:true})).toEqual({x:0,y:-120,zoom:.5});
 expect(nav.apply(input({deltaY:-3}),{...context,zoomWithScrollWheel:true})!.zoom).toBeCloseTo(.55);
});
it("Ctrl分数捏合与250ms延续独立受偏好控制，重置和倒退时间隔离，倍率有限",()=>{
 const nav=new WheelNavigation(),pinch=input({ctrlKey:true,deltaMode:0,deltaY:-10});
 expect(nav.apply(pinch,context)!.zoom).toBeGreaterThan(.5);
 expect(nav.apply({...pinch,deltaY:-100,timeStamp:200},context)!.zoom).toBeGreaterThan(.5);
 expect(nav.apply({...pinch,deltaY:-100,timeStamp:500},context)).toEqual({x:100,y:0,zoom:.5});
 expect(nav.apply(pinch,{...context,zoomWithTrackpadPinch:false})).toEqual({x:10,y:0,zoom:.5});
 nav.reset();expect(nav.apply({...pinch,deltaY:-120},context)).toEqual({x:120,y:0,zoom:.5});
 expect(nav.apply({...pinch,deltaY:NaN},context)).toBeNull();
 expect(nav.apply({...pinch,deltaY:-1e10},context)!.zoom).toBeLessThanOrEqual(32);
});
it("Shift缩放按阶梯累积，方向/空闲/重置清余量，无动画延迟尾巴",()=>{
 const nav=new WheelNavigation(),snap=input({altKey:true,shiftKey:true,deltaY:-1});
 expect(nav.apply(snap,context)).toBeNull();expect(nav.apply({...snap,timeStamp:10},context)).toBeNull();
 expect(nav.apply({...snap,timeStamp:20},context)!.zoom).toBe(2/3);
 nav.reset();nav.apply(snap,context);expect(nav.apply({...snap,deltaY:1,timeStamp:40},context)).toBeNull();
 expect(nav.apply({...snap,timeStamp:600},context)).toBeNull();expect(nav.apply({...snap,timeStamp:610},context)).toBeNull();expect(nav.apply({...snap,timeStamp:620},context)!.zoom).toBe(2/3);
});
