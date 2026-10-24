import {expect,it} from "vitest";
import {FlickPan,interpolateViewport,zoomAt} from "./viewport-motion.js";
it("release velocity uses only recent samples; stale, slow, disabled and clicks do not coast",()=>{
 const flick=new FlickPan();flick.start({x:0,y:0},0);flick.track({x:1000,y:0},1000);flick.track({x:1010,y:0},1020);expect(flick.release(1020,true)).toBe(true);
 let total=0,previous=Infinity,count=0;
 for(let delta=flick.step(16);delta;delta=flick.step(16)){expect(delta.x).toBeGreaterThan(0);expect(delta.x).toBeLessThan(previous);previous=delta.x;total+=delta.x;expect(++count).toBeLessThan(200);}
 expect(total).toBeLessThan(91);expect(total).toBeGreaterThan(80);
 for(const [end,at,enabled] of [[1,20,true],[20,200,true],[20,20,false]] as const){flick.start({x:0,y:0},0);flick.track({x:end,y:0},20);expect(flick.release(at,enabled)).toBe(false);}
 flick.start({x:0,y:0},0);expect(flick.release(0,true)).toBe(false);
});
it("flick caps hostile speed and frame gaps and stop clears all future steps",()=>{
 const flick=new FlickPan();flick.start({x:0,y:0},0);flick.track({x:1e12,y:0},16);flick.track({x:NaN,y:0},17);expect(flick.release(17,true)).toBe(true);
 expect(flick.step(Infinity)).toEqual({x:0,y:0});expect(flick.step(10000)!.x).toBeLessThan(600);flick.stop();expect(flick.step(16)).toBeNull();
});
it("zoom preserves its clicked document anchor, optionally centering it, throughout easing",()=>{
 const from={x:40,y:-20,zoom:.5},anchor={x:100,y:60};const to=zoomAt(from,2,anchor);
 for(const at of [0,55,110,220]){const v=interpolateViewport(from,to,at);expect((anchor.x-v.x)/v.zoom).toBeCloseTo((anchor.x-from.x)/from.zoom);expect((anchor.y-v.y)/v.zoom).toBeCloseTo((anchor.y-from.y)/from.zoom);}
 expect(interpolateViewport(from,to,220)).toEqual(to);expect(interpolateViewport(from,to,300)).toEqual(to);
 const centered=zoomAt(from,2,anchor,true);expect(-centered.x/centered.zoom).toBe((anchor.x-from.x)/from.zoom);expect(-centered.y/centered.zoom).toBe((anchor.y-from.y)/from.zoom);
});
