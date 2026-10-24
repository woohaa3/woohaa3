import {expect,it} from "vitest";
import {duplicateDistance,measureBoxes,measureLabels,shouldMeasure,targetBox} from "./move-distance.js";

it("分离的框量相对边空隙，重叠时量对应边，零距离不显示",()=>{
  // b 在 a 右侧 60px，纵向与 a 重叠 20..40：水平线穿过重叠中点 y=30。
  const apart=measureBoxes([0,0,40,40],[100,20,150,80]);
  expect(apart.measures).toEqual([
    {horizontal:true,at:30,from:40,to:100},
    {horizontal:false,at:20,from:0,to:20},
    {horizontal:false,at:20,from:40,to:80}
  ]);
  expect(apart.extensions).toEqual([[100,20,20,20],[100,80,20,80]]);
  // 斜向分离：两个轴都有空隙。
  expect(measureBoxes([100,0,140,20],[20,70,70,90]).measures).toEqual([
    {horizontal:true,at:10,from:70,to:100},
    {horizontal:false,at:120,from:20,to:70}
  ]);
  // 选区在画布内：量到四边。
  expect(measureBoxes([40,40,90,80],[0,0,400,300]).measures).toEqual([
    {horizontal:true,at:60,from:0,to:40},
    {horizontal:true,at:60,from:90,to:400},
    {horizontal:false,at:65,from:0,to:40},
    {horizontal:false,at:65,from:80,to:300}
  ]);
  // 完全相同的框与非法坐标不显示任何距离。
  expect(measureBoxes([0,0,400,300],[0,0,400,300])).toEqual({measures:[],extensions:[]});
  expect(measureBoxes([Number.NaN,0,1,1],[0,0,400,300])).toEqual({measures:[],extensions:[]});
});

it("悬停未命中时量到画布边缘，Alt 复制量原件与副本间距",()=>{
  expect(targetBox(null,{width:400,height:300})).toEqual([0,0,400,300]);
  expect(targetBox([10,20,30,40],{width:400,height:300})).toEqual([10,20,30,40]);
  const overlay=duplicateDistance([40,40,90,80],{x:60,y:0});
  expect(overlay.measures).toContainEqual({horizontal:true,at:60,from:90,to:100});
});

it("显示条件与上游一致：Move、Extras、无拖动、Cmd、有选区和悬停目标",()=>{
  const base={tool:"move",extrasVisible:true,transforming:false,pressed:false,command:true,hasSelectedLayers:true,hasTarget:true};
  expect(shouldMeasure(base)).toBe(true);
  expect(shouldMeasure({...base,tool:"brush"})).toBe(false);
  expect(shouldMeasure({...base,extrasVisible:false})).toBe(false);
  expect(shouldMeasure({...base,pressed:true})).toBe(false);
  expect(shouldMeasure({...base,command:false})).toBe(false);
  expect(shouldMeasure({...base,transforming:true})).toBe(false);
  expect(shouldMeasure({...base,hasSelectedLayers:false})).toBe(false);
  expect(shouldMeasure({...base,hasTarget:false})).toBe(false);
});

it("标签复用七种测量单位与文档 DPI，百分比按对应轴换算",()=>{
  const overlay=measureBoxes([40,40,90,80],[0,0,400,300]);
  const pixels=measureLabels(overlay,{unit:"pixels",dpi:72,width:400,height:300,pointPica:72});
  expect(pixels.map(label=>label.text)).toEqual(["40 px","310 px","40 px","220 px"]);
  const percent=measureLabels(overlay,{unit:"percent",dpi:72,width:400,height:300,pointPica:72});
  expect(percent.map(label=>label.text)).toEqual(["10 %","77.5 %","13.3 %","73.3 %"]);
  const inches=measureLabels(overlay,{unit:"inches",dpi:144,width:400,height:300,pointPica:72});
  expect(inches[0]!.text).toBe("0.278 in");
  const points=measureLabels(overlay,{unit:"points",dpi:144,width:400,height:300,pointPica:72.27});
  expect(points[0]!.text).toBe("20.1 pt");
  // 标签位置：水平线用水平中点、垂直线用垂直中点。
  expect(pixels[0]).toMatchObject({horizontal:true,at:60,mid:20});
  expect(pixels[2]).toMatchObject({horizontal:false,at:65,mid:20});
});
