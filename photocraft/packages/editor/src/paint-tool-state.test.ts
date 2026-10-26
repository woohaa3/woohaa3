import { expect, it } from "vitest";
import { nativeBrushSettings, PaintPercentInput } from "./paint-tool-state.js";
it("数字支持连续两位、0 为满值、00 为零；超时、工具或属性变化重新起算", () => {
  const input=new PaintPercentInput();
  expect(input.input(5,"opacity","brush",0)).toBe(.5);
  expect(input.input(3,"opacity","brush",100)).toBe(.53);
  expect(input.input(0,"opacity","brush",200)).toBe(1);
  expect(input.input(5,"opacity","brush",300)).toBe(.05);
  expect(input.input(0,"flow","brush",400)).toBe(1);
  expect(input.input(0,"flow","brush",500)).toBe(0);
  expect(input.input(2,"flow","brush",600)).toBe(.2);
  expect(input.input(3,"flow","eraser",650)).toBe(.3);
  expect(input.input(4,"opacity","eraser",700)).toBe(.4);
  expect(input.input(6,"opacity","eraser",1500)).toBe(.6);
  input.reset(); expect(input.input(7,"opacity","eraser",1550)).toBe(.7);
});

it("精确百分比窗口为800ms，目标与属性隔离，不把零值当满值",()=>{
  const input=new PaintPercentInput();
  expect(input.input(0,"opacity","layer:1",0)).toBe(1);
  expect(input.input(0,"opacity","layer:1",799)).toBe(0);
  expect(input.input(4,"opacity","layer:1",1000)).toBe(.4);
  expect(input.input(2,"opacity","layer:1",1800)).toBe(.2);
  expect(input.input(3,"opacity","layer:2",1850)).toBe(.3);
  expect(input.input(4,"fill","layer:2",1900)).toBe(.4);
  expect(input.input(5,"fill","layer:2",1950)).toBe(.45);
});

it("应用预设回填当前画笔的大小、覆盖率、角度、平滑和混合模式",()=>{
 expect(nativeBrushSettings({size:35,hardness:.3,opacity:.6,flow:.4,angle:45,smoothing:{enabled:true,amount:.7},mode:"ColorDodge"})).toEqual({size:35,hardness:.3,opacity:.6,flow:.4,angle:45,smoothing:.7,mode:"Color Dodge"});
 expect(nativeBrushSettings({smoothing:{enabled:false,amount:.7},mode:"Normal",erase:true})).toEqual({smoothing:0,mode:"Clear"});
});
