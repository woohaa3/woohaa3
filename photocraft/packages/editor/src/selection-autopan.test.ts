import { afterEach, expect, it, vi } from "vitest";
import { SelectionAutoPan, selectionPanStep, type SelectionPanContext } from "./selection-autopan.js";
const context = (patch: Partial<SelectionPanContext> = {}): SelectionPanContext => ({
  pointer:{x:799,y:300},width:800,height:600,documentWidth:1600,documentHeight:1200,zoom:1,x:0,y:0,...patch
});
afterEach(() => vi.unstubAllGlobals());
it("边缘按屏幕速度平移，只移动可滚动轴并限制到文档范围", () => {
  expect(selectionPanStep(context(),1/60)).toEqual({x:-7.75,y:0});
  expect(selectionPanStep(context({x:-399}),1/60)).toEqual({x:-1,y:0});
  expect(selectionPanStep(context({x:-400}),1/60)).toEqual({x:0,y:0});
  expect(selectionPanStep(context({zoom:.4}),1/60)).toEqual({x:0,y:0});
  expect(selectionPanStep(context({pointer:{x:400,y:300}}),1/60)).toEqual({x:0,y:0});
  expect(selectionPanStep(context({pointer:{x:-100,y:-100}}),1)).toEqual({x:15.36,y:15.36});
  expect(selectionPanStep(context({width:0,height:0}),1/60)).toEqual({x:0,y:0});
});
it("离开边缘、松手和取消停止循环；已取消的迟到帧不能恢复旧手势", () => {
  const callbacks = new Map<number,FrameRequestCallback>(); let sequence=0;
  vi.stubGlobal("requestAnimationFrame",vi.fn((callback: FrameRequestCallback) => {callbacks.set(++sequence,callback);return sequence;}));
  vi.stubGlobal("cancelAnimationFrame",vi.fn());
  let current: SelectionPanContext | null = context(); const pan=vi.fn();
  const auto = new SelectionAutoPan(() => current,pan);
  auto.update(); auto.update(); expect(callbacks.size).toBe(1);
  callbacks.get(1)!(0); expect(pan).toHaveBeenCalledWith({x:-7.75,y:0});
  expect(callbacks.size).toBe(2);
  current=context({pointer:{x:400,y:300}}); callbacks.get(2)!(16);
  expect(pan).toHaveBeenCalledTimes(1); expect(callbacks.size).toBe(2);
  current=context(); auto.update(); const stale=callbacks.get(3)!;
  auto.stop(); auto.update(); stale(32);
  expect(pan).toHaveBeenCalledTimes(1); expect(callbacks.size).toBe(4);
  current=null; callbacks.get(4)!(48); expect(pan).toHaveBeenCalledTimes(1);
});
