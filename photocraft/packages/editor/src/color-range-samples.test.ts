import {describe,expect,it} from "vitest";
import {DEFAULT_COLOR_RANGE,buildColorRange} from "./photo-editor-tools.js";

describe("颜色范围画布取样点（I269）",()=>{
 it("取样点只在「取样颜色」模式下编译，坐标取整",()=>{
  expect(buildColorRange(DEFAULT_COLOR_RANGE)).not.toHaveProperty("points");
  const sampled=buildColorRange({...DEFAULT_COLOR_RANGE,points:[[10.4,20.6]],subtractPoints:[[3.2,4.8]]});
  expect(sampled.points).toEqual([[10,21]]);
  expect(sampled.subtractPoints).toEqual([[3,5]]);
  // 空数组不下发，避免把「没点过」当成显式空集合。
  expect(buildColorRange({...DEFAULT_COLOR_RANGE,points:[],subtractPoints:[]})).not.toHaveProperty("points");
  // 色调预设忽略取样点。
  for(const select of ["reds","highlights","skinTones"] as const){
   const built=buildColorRange({...DEFAULT_COLOR_RANGE,select,points:[[1,1]]});
   expect(built).not.toHaveProperty("points");expect(built).not.toHaveProperty("subtractPoints");
  }
 });
 it("混合模式与其它字段保持不变",()=>{
  const built=buildColorRange({...DEFAULT_COLOR_RANGE,points:[[5,5]],fuzziness:80,localized:true,range:40,invert:true,sampleAllLayers:false,mode:"add"});
  expect(built).toMatchObject({select:"sampledColors",fuzziness:80,localized:true,range:40,invert:true,sampleAllLayers:false,mode:"add",points:[[5,5]]});
 });
});
