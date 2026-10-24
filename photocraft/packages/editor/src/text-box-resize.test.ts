import {expect,it} from "vitest";
import {applyAffine,boxHandleAt,boxHandlePoints,boxOutline,invertAffine,paragraphBoxOf,resizeTextBox,textBoxHandles,type Affine} from "./text-box-resize.js";

const identity:Affine=[1,0,0,1,0,0];
const rect={x:10,y:10,width:80,height:40};

it("八个手柄按上游顺序排列，命中容差按缩放换算且角点优先",()=>{
  expect(textBoxHandles(rect)).toEqual([[10,10],[90,10],[90,50],[10,50],[50,10],[90,30],[50,50],[10,30]]);
  // 1 倍缩放：6 屏幕像素容差。
  expect(boxHandleAt(rect,identity,[90,10],1)).toBe(1);
  expect(boxHandleAt(rect,identity,[95,10],1)).toBe(1);
  // 4 倍缩放：容差缩到 1.5 文档像素，5 像素外的指针不命中。
  expect(boxHandleAt(rect,identity,[95,10],4)).toBeNull();
  expect(boxHandleAt(rect,identity,[91,10],4)).toBe(1);
  // 缩小视图时容差变大：24 文档像素在 0.25 倍下仍是 6 屏幕像素。
  expect(boxHandleAt(rect,identity,[90,10],.25)).toBe(1);
  // 角点与边中点同距时角点优先；远处不命中。
  expect(boxHandleAt(rect,identity,[10,10],1)).toBe(0);
  expect(boxHandleAt(rect,identity,[50,50],1)).toBe(6);
  expect(boxHandleAt(rect,identity,[200,200],1)).toBeNull();
  expect(boxHandleAt(null,identity,[10,10],1)).toBeNull();
  expect(boxHandleAt(rect,null,[10,10],1)).toBeNull();
});

it("拖边只改该边，Alt 以按下时的中心镜像并在最小尺寸处夹紧",()=>{
  expect(resizeTextBox({handle:5,rect,transform:identity,point:[120,30],alt:false})).toEqual([10,10,110,40]);
  expect(resizeTextBox({handle:6,rect,transform:identity,point:[50,80],alt:false})).toEqual([10,10,80,70]);
  // 反向拖动不会反转：右边拖到左边以外，宽度夹紧到 4。
  expect(resizeTextBox({handle:5,rect,transform:identity,point:[-50,30],alt:false})).toEqual([10,10,4,40]);
  // Alt 右中：中心 x=50 固定，指针 120 → 右边 120、左边 -20。
  expect(resizeTextBox({handle:5,rect,transform:identity,point:[120,30],alt:true})).toEqual([-20,10,140,40]);
  // Alt 右中越过中心：右边夹紧到 52。
  expect(resizeTextBox({handle:5,rect,transform:identity,point:[0,30],alt:true})).toEqual([48,10,4,40]);
  // 左上角同时改两条边。
  expect(resizeTextBox({handle:0,rect,transform:identity,point:[20,20],alt:false})).toEqual([20,20,70,30]);
  // 上中手柄只改上边。
  expect(resizeTextBox({handle:4,rect,transform:identity,point:[50,0],alt:false})).toEqual([10,0,80,50]);
});

it("旋转与位移先把指针还原到文字空间，再把新原点投影回文档",()=>{
  // 90° 旋转 + 平移：文档 x = 100-y，文档 y = x+50。
  const transform:Affine=[0,1,-1,0,100,50];
  const inverse=invertAffine(transform)!;
  expect(inverse.map(value=>Math.round(value*1000)/1000)).toEqual([0,-1,1,0,-50,100]);
  expect(applyAffine(transform,[10,10])).toEqual([90,60]);
  for(const point of [[10,10],[90,60],[20,25]] as const){
    const round=applyAffine(inverse,applyAffine(transform,point)).map(value=>Math.round(value*1000)/1000);
    expect(round).toEqual([point[0],point[1]]);
  }
  // 文档指针 (90,70) 在文字空间是 (20,10)：右中手柄只改右边，宽度 10。
  const next=resizeTextBox({handle:5,rect,transform,point:[90,70],alt:false});
  expect(next[2]).toBeCloseTo(10,6);expect(next[3]).toBeCloseTo(40,6);
  // 新原点是文字空间 (10,10) 的投影，未因拖右边改变。
  expect(next[0]).toBeCloseTo(90,6);expect(next[1]).toBeCloseTo(60,6);
  expect(boxOutline(rect,transform)).toEqual([[90,60],[90,140],[50,140],[50,60]]);
  expect(boxHandlePoints(rect,transform)[4]).toEqual([90,100]);
  // 退化变换不可逆，命中直接放弃。
  expect(invertAffine([0,0,0,0,5,5])).toBeNull();
});

it("原生 type.info 只把段落框当作缩放目标，点文字与无效投影不猜测",()=>{
  expect(paragraphBoxOf({new:true})).toBeNull();
  expect(paragraphBoxOf(null)).toBeNull();
  expect(paragraphBoxOf({shape:"Point"})).toBeNull();
  expect(paragraphBoxOf({shape:{Box:{x:1,y:2,width:0,height:40}}})).toBeNull();
  expect(paragraphBoxOf({shape:{Box:{x:1,y:2,width:30,height:40}}})).toEqual({rect:{x:1,y:2,width:30,height:40},transform:identity});
  // 扁平写法（旧数据）同样接受。
  expect(paragraphBoxOf({shape:{x:1,y:2,width:30,height:40}})).toEqual({rect:{x:1,y:2,width:30,height:40},transform:identity});
  expect(paragraphBoxOf({shape:{Box:{x:1,y:2,width:30,height:40}},transform:[2,0,0,2,3,4]})).toEqual({rect:{x:1,y:2,width:30,height:40},transform:[2,0,0,2,3,4]});
  // 残缺/非有限变换退回单位矩阵，但非有限数值的框不猜测。
  expect(paragraphBoxOf({shape:{Box:{x:1,y:2,width:30,height:40}},transform:[0,0,0]})?.transform).toEqual(identity);
  expect(paragraphBoxOf({shape:{Box:{x:1,y:2,width:30,height:40}},transform:[0,0,0,0,0,Number.NaN]})?.transform).toEqual(identity);
  expect(paragraphBoxOf({shape:{Box:{x:Number.NaN,y:2,width:30,height:40}}})).toBeNull();
});
