import { expect, it } from "vitest";
import { SelectionGesture, selectionModeForKeys } from "./selection-gesture.js";
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
it("反向与中心等比初次绘制受文档范围限制，空格移位可越界且保持尺寸", () => {
  const gesture = new SelectionGesture("marquee",{x:20,y:15},{width:200,height:100},"replace",none);
  gesture.key("Shift",true); gesture.key("Alt",true);
  gesture.update({x:100,y:100},{...none,shift:true,alt:true});
  expect(gesture.rect()).toEqual({x:5,y:0,width:30,height:30});
  gesture.key("Shift",false); gesture.key("Alt",false);
  gesture.update({x:0,y:0},none);
  expect(gesture.rect()).toEqual({x:0,y:0,width:20,height:15});
  gesture.key(" ",true); gesture.update({x:-10,y:-10},{...none,space:true});
  expect(gesture.rect()).toEqual({x:-10,y:-10,width:20,height:15});
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

it.each(["row","column"] as const)("%s 选框覆盖文档整行/列，使用当前点且边缘不越界",line=>{
  const gesture=new SelectionGesture("marquee",{x:20.8,y:30.9},bounds,"replace",{...none,shift:true},line);
  expect(gesture.mode).toBe("add");
  expect(gesture.rect()).toEqual(line==="row"?{x:0,y:30,width:400,height:1}:{x:20,y:0,width:1,height:300});
  gesture.update({x:400,y:300},{...none,alt:true,shift:true});
  expect(gesture.rect()).toEqual(line==="row"?{x:0,y:299,width:400,height:1}:{x:399,y:0,width:1,height:300});
});

it("没有选区的新选区模式释放 Alt 作居中几何；显式减选不被回退",()=>{
  const keys={shift:false,alt:true,space:false};
  const gesture=new SelectionGesture("marquee",{x:50,y:50},{width:100,height:100},"replace",keys,undefined,false);
  gesture.update({x:60,y:65},keys);expect(gesture.mode).toBe("replace");expect(gesture.rect()).toEqual({x:40,y:35,width:20,height:30});
  const subtract=new SelectionGesture("marquee",{x:50,y:50},{width:100,height:100},"subtract",keys,undefined,false);
  subtract.update({x:60,y:65},keys);expect(subtract.mode).toBe("subtract");expect(subtract.rect()).toEqual({x:50,y:50,width:10,height:15});
});

it("空格移位可完全越出文档，释放后保持新起点；套索也不夹紧或丢点",()=>{
 const marquee=new SelectionGesture("marquee",{x:350,y:250},bounds,"replace",none);
 marquee.update({x:390,y:290},none);marquee.update({x:510,y:410},{...none,space:true});
 expect(marquee.rect()).toEqual({x:470,y:370,width:40,height:40});
 marquee.key(" ",false);marquee.update({x:500,y:400},none);expect(marquee.rect()).toEqual({x:470,y:370,width:30,height:30});
 const lasso=new SelectionGesture("lasso",{x:10,y:10},bounds,"replace",none);
 lasso.update({x:20,y:10},none);lasso.update({x:20,y:20},none);lasso.update({x:-80,y:-80},{...none,space:true});
 expect(lasso.path()).toEqual([{x:-90,y:-90},{x:-80,y:-90},{x:-80,y:-80}]);
});


it("固定比例在四个方向保持宽高比，空格移位保留比例且不跳回",()=>{
 for(const [dx,dy] of [[80,10],[-80,10],[80,-10],[-80,-10]]) {
  const gesture=new SelectionGesture("marquee",{x:150,y:150},bounds,"replace",none,undefined,false,{mode:"ratio",width:2,height:1});
  gesture.update({x:150+dx,y:150+dy},none);const rect=gesture.rect();expect(rect.width).toBe(80);expect(rect.height).toBe(40);
  gesture.update({x:180+dx,y:170+dy},{...none,space:true});const moved=gesture.rect();expect(moved).toEqual({...rect,x:rect.x+30,y:rect.y+20});
 }
});
it("固定大小单击有效，拖动只改变方向，Alt居中不改变尺寸",()=>{
 const gesture=new SelectionGesture("marquee",{x:100,y:100},bounds,"replace",none,undefined,false,{mode:"size",width:80,height:40});
 expect(gesture.rect()).toEqual({x:100,y:100,width:80,height:40});
 gesture.update({x:90,y:95},none);expect(gesture.rect()).toEqual({x:20,y:60,width:80,height:40});
 gesture.key("Alt",true);expect(gesture.rect()).toEqual({x:60,y:80,width:80,height:40});
});
