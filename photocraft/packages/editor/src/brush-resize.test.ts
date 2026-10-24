import {expect,it} from "vitest";
import {resizeBrush,stepBrushHardness,stepBrushSize} from "./brush-resize.js";
it("笔刷尺寸比例步进小尺寸不滞留，硬度吸附相邻刻度",()=>{
 expect(stepBrushSize(1,-1)).toBe(1);expect(stepBrushSize(2,-1)).toBe(1);
 expect(stepBrushSize(100,1)).toBe(125);expect(stepBrushSize(125,-1)).toBe(100);
 expect(stepBrushHardness(.6,-1)).toBe(.25);expect(stepBrushHardness(.6,1)).toBe(.75);expect(stepBrushHardness(1,1)).toBe(1);
});
it("HUD拖动水平改直径，垂直按偏好修改硬度或不透明度并限制范围",()=>{
 const base={size:100,hardness:.5,opacity:.8};
 expect(resizeBrush(base,20,40)).toEqual({size:140,hardness:.7,opacity:.8});
 expect(resizeBrush(base,20,-200,false)).toEqual({size:140,hardness:.5,opacity:0});
 expect(resizeBrush(base,-1000,1000)).toEqual({size:1,hardness:1,opacity:.8});
 expect(resizeBrush(base,NaN,Infinity)).toEqual(base);
});

it("brush angles wrap at 180 degrees and reject nonfinite state",async()=>{
 const {normalizeBrushAngle:angle}=await import("./brush-resize.js");expect(angle(180)).toBe(-180);expect(angle(-181)).toBe(179);expect(angle(361)).toBe(1);expect(angle(Infinity)).toBe(0);expect(angle(NaN)).toBe(0);
});
