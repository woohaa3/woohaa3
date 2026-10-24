import {expect,it} from "vitest";
import {stepEditorZoom as step,minimumZoom,clampEditorZoom} from "./zoom-levels.js";
it("upstream ladder steps arbitrary values to the next rung in either direction",()=>{
 expect(step(8.8,1,2000,1500)).toBe(12);expect(step(8.8,-1,2000,1500)).toBe(8);
 let value=1;const levels=[];while(value<128){value=step(value,1,2000,1500);levels.push(value);}
 expect(levels).toEqual([2,3,4,5,6,7,8,12,16,32,64,128]);expect(step(128,1,2000,1500)).toBe(128);
 for(let i=0;i<50;i++)value=step(value,-1,2000,1500);expect(value).toBe(2/1500);
});
it("minimum shows the shorter document side at two pixels, including tiny and invalid input",()=>{
 expect(minimumZoom(4,4)).toBe(.5);expect(minimumZoom(8192,4096)).toBe(2/4096);expect(step(.5,-1,4,4)).toBe(.5);
 expect(clampEditorZoom(Infinity,2000,1500)).toBe(1);expect(clampEditorZoom(-1,2000,1500)).toBe(2/1500);expect(clampEditorZoom(999,2000,1500)).toBe(128);
});
