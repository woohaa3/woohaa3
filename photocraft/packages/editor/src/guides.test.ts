import {expect,it} from "vitest";
import {DEFAULT_GUIDE_PREFERENCES,decodeGuides,draggedGuide,gridLines,guideAt,guideList,normalizeGuidePreferences,rulerTicks,snapPoint} from "./guides.js";

it("参考线投影只接受有限数值，扁平列表保留原生索引",()=>{
  expect(decodeGuides(null)).toEqual({horizontal:[],vertical:[]});
  expect(decodeGuides({horizontal:[10,20,"x",Number.NaN],vertical:[30]})).toEqual({horizontal:[10,20],vertical:[30]});
  const list=guideList({horizontal:[10,20],vertical:[30]});
  expect(list).toEqual([
    {orientation:"horizontal",position:10,index:0},
    {orientation:"horizontal",position:20,index:1},
    {orientation:"vertical",position:30,index:0}
  ]);
  const colored=guideList({horizontal:[10],vertical:[]},[{vertical:false,position:10,rgb:[255,0,0]},{vertical:false,position:99,rgb:[1,2,3]},{vertical:false,position:10,rgb:"bad"}]);
  expect(colored).toEqual([{orientation:"horizontal",position:10,index:0,color:[255,0,0]}]);
});

it("命中按屏幕容差换算，拖动方向与标尺相反",()=>{
  const list=guideList({horizontal:[100],vertical:[50]});
  expect(guideAt(list,{x:60,y:101},1)).toMatchObject({orientation:"horizontal",position:100});
  // 4 倍缩放下 4 屏幕像素 = 1 文档像素；2 像素外不再命中。
  expect(guideAt(list,{x:60,y:102},4)).toBeNull();
  expect(guideAt(list,{x:60,y:101},4)).not.toBeNull();
  expect(guideAt(list,{x:51,y:10},1)).toMatchObject({orientation:"vertical",position:50});
  expect(guideAt([],{x:0,y:0},1)).toBeNull();
  expect(draggedGuide("horizontal",{x:12.7,y:4})).toEqual({orientation:"vertical",position:13});
  expect(draggedGuide("vertical",{x:4,y:12.2})).toEqual({orientation:"horizontal",position:12});
});

it("吸附按阈值择近，网格与画布边缘都可参与",()=>{
  const guides=guideList({horizontal:[100],vertical:[200]});
  expect(snapPoint({x:203,y:97},{guides,threshold:4})).toEqual({point:{x:200,y:100},snappedX:true,snappedY:true});
  expect(snapPoint({x:210,y:60},{guides,threshold:4})).toEqual({point:{x:210,y:60},snappedX:false,snappedY:false});
  // 关闭参考线吸附后不再吸附。
  expect(snapPoint({x:203,y:97},{guides,threshold:4,snapToGuides:false}).snappedX).toBe(false);
  // 网格：就近取整到步长。
  // 距离 4/10：x 吸附到 100，y 离 200 太远不吸附。
  expect(snapPoint({x:104,y:190},{grid:50,threshold:8,snapToGrid:true})).toEqual({point:{x:100,y:190},snappedX:true,snappedY:false});
  expect(snapPoint({x:104,y:196},{grid:50,threshold:8,snapToGrid:true})).toEqual({point:{x:100,y:200},snappedX:true,snappedY:true});
  // 画布边缘。
  expect(snapPoint({x:1,y:639},{canvas:{width:640,height:640},threshold:3,snapToCanvas:true})).toEqual({point:{x:0,y:640},snappedX:true,snappedY:true});
  // 参考线优先于网格（更近者胜）。
  const both=snapPoint({x:201,y:5},{guides,grid:100,threshold:5,snapToGuides:true,snapToGrid:true});
  expect(both.point.x).toBe(200);
});

it("网格与标尺只生成可见范围，步长随缩放调整",()=>{
  expect(gridLines(0,100,50)).toEqual([0,50,100]);
  expect(gridLines(10,60,50)).toEqual([50]);
  expect(gridLines(0,100,0)).toEqual([]);
  expect(gridLines(10,10,5)).toEqual([]);
  // 超长范围被限制，不会为超大画布生成整幅网格。
  expect(gridLines(0,1e9,1,10)).toHaveLength(10);
  const zoomed=rulerTicks(1000,1,60);
  expect(zoomed.step).toBe(100);
  expect(zoomed.ticks[0]).toBe(0);
  expect(zoomed.ticks.at(-1)).toBe(1000);
  // 放大后步长变小。
  expect(rulerTicks(1000,10,60).step).toBe(10);
  expect(rulerTicks(0,1)).toEqual({step:1,ticks:[]});
});

it("显示偏好规范化：布尔回退、网格尺寸夹在合理范围",()=>{
  expect(normalizeGuidePreferences(null)).toEqual(DEFAULT_GUIDE_PREFERENCES);
  expect(normalizeGuidePreferences({showRulers:true,snapToGrid:true,gridSize:64})).toMatchObject({showRulers:true,snapToGrid:true,gridSize:64});
  expect(normalizeGuidePreferences({showGrid:"yes",gridSize:1})).toMatchObject({showGrid:false,gridSize:100});
  expect(normalizeGuidePreferences({gridSize:99999}).gridSize).toBe(100);
  expect(DEFAULT_GUIDE_PREFERENCES.showGuides).toBe(true);
});
