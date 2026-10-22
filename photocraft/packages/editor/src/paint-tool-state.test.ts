import { expect, it } from "vitest";
import { PaintPercentInput } from "./paint-tool-state.js";
it("数字支持连续两位、0/00 为满值；超时、工具或属性变化重新起算", () => {
  const input=new PaintPercentInput();
  expect(input.input(5,"opacity","brush",0)).toBe(.5);
  expect(input.input(3,"opacity","brush",100)).toBe(.53);
  expect(input.input(0,"opacity","brush",200)).toBe(1);
  expect(input.input(5,"opacity","brush",300)).toBe(.05);
  expect(input.input(0,"flow","brush",400)).toBe(1);
  expect(input.input(0,"flow","brush",500)).toBe(1);
  expect(input.input(2,"flow","brush",600)).toBe(.2);
  expect(input.input(3,"flow","eraser",650)).toBe(.3);
  expect(input.input(4,"opacity","eraser",700)).toBe(.4);
  expect(input.input(6,"opacity","eraser",1500)).toBe(.6);
  input.reset(); expect(input.input(7,"opacity","eraser",1550)).toBe(.7);
});
