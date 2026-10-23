import { expect, it } from "vitest";
import { SelectionGesture, selectionModeForKeys } from "../../selection-gesture.js";
const none = {shift:false,alt:false,space:false};
const bounds = {width:400,height:300};
it.each([
  [false,false,"replace"], [true,false,"add"], [false,true,"subtract"], [true,true,"intersect"]
] as const)("按下前 Shift=%s Alt=%s 固定本次选区运算为 %s", (shift,alt,mode) => {
  const keys = {...none,shift,alt};
  const gesture = new SelectionGesture("marquee",{x:100,y:100},bounds,"replace",keys);
  gesture.update({x:160,y:120},keys);
  expect(gesture.mode).toBe(mode);
  expect(gesture.rect()).toEqual({x:100,y:100,width:60,height:20});
  gesture.update({x:170,y:130},none);
  expect(gesture.mode).toBe(mode);
});
it("没有临时修饰键时保留参数栏模式；修饰键可临时覆盖而不改偏好", () => {
  expect(selectionModeForKeys("subtract",none)).toBe("subtract");
  expect(selectionModeForKeys("subtract",{shift:true,alt:false})).toBe("add");
  expect(selectionModeForKeys("subtract",none)).toBe("subtract");
});
it("先加选，释放并重新按 Shift 才约束为正方形；Alt 在拖动后控制中心", () => {
  const gesture = new SelectionGesture("marquee",{x:100,y:100},bounds,"replace",{...none,shift:true});
  gesture.update({x:160,y:120},{...none,shift:true});
  expect(gesture.rect()).toEqual({x:100,y:100,width:60,height:20});
  gesture.key("Shift",false); gesture.key("Shift",true);
  expect(gesture.rect()).toEqual({x:100,y:100,width:60,height:60});
  gesture.key("Alt",true);
  expect(gesture.rect()).toEqual({x:40,y:40,width:120,height:120});
  gesture.key("Shift",false);
  expect(gesture.rect()).toEqual({x:40,y:80,width:120,height:40});
  gesture.key("Alt",false);
  expect(gesture.rect()).toEqual({x:100,y:100,width:60,height:20});
  expect(gesture.mode).toBe("add");
});
it("空格移动当前框，释放后继续调整大小且不跳回旧起点", () => {
  const gesture = new SelectionGesture("marquee",{x:50,y:50},bounds,"replace",none);
  gesture.update({x:80,y:70},none); gesture.key(" ",true);
  gesture.update({x:90,y:90},{...none,space:true});
  expect(gesture.rect()).toEqual({x:60,y:70,width:30,height:20});
  gesture.key(" ",false); gesture.update({x:110,y:100},none);
  expect(gesture.rect()).toEqual({x:60,y:70,width:50,height:30});
});
it("反向与中心等比绘制受文档范围限制，移位保持框的尺寸", () => {
  const gesture = new SelectionGesture("marquee",{x:20,y:15},{width:200,height:100},"replace",none);
  gesture.key("Shift",true); gesture.key("Alt",true);
  gesture.update({x:100,y:100},{...none,shift:true,alt:true});
  expect(gesture.rect()).toEqual({x:5,y:0,width:30,height:30});
  gesture.key("Shift",false); gesture.key("Alt",false);
  gesture.update({x:0,y:0},none);
  expect(gesture.rect()).toEqual({x:0,y:0,width:20,height:15});
  gesture.key(" ",true); gesture.update({x:-10,y:-10},{...none,space:true});
  expect(gesture.rect()).toEqual({x:0,y:0,width:20,height:15});
});
it("套索空格平移整条路径，不追加绘制点，释放后从新位置继续", () => {
  const gesture = new SelectionGesture("lasso",{x:50,y:50},bounds,"replace",{...none,alt:true});
  gesture.update({x:80,y:50},none); gesture.update({x:80,y:80},none);
  gesture.key(" ",true); gesture.update({x:90,y:90},{...none,space:true});
  expect(gesture.path()).toEqual([{x:60,y:60},{x:90,y:60},{x:90,y:90}]);
  gesture.key(" ",false); gesture.update({x:110,y:90},none);
  expect(gesture.path().at(-1)).toEqual({x:110,y:90}); expect(gesture.mode).toBe("subtract");
});
it("半像素起点取整后不越出文档，并保留等比约束", () => {
  const gesture = new SelectionGesture("marquee",{x:.5,y:.5},{width:100,height:100},"replace",none);
  gesture.update({x:100,y:100},{...none,shift:true});
  expect(gesture.rect()).toEqual({x:1,y:1,width:99,height:99});
});
