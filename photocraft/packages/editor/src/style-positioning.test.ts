import {expect,it} from "vitest";
import {canPositionStyle,readStyleGradientFrame,translateStyle,patternPosition,translatePattern,type StylePositionTarget} from "./style-positioning.js";

it.each(["PatternOverlay","BevelEmboss"] as const)("%s 拖动使用原快照的文档像素，不受图案缩放、旋转或链接影响",kind=>{
  const pattern={phase:[12,-9],scale:2.5,angle:45,link:false,id:"original",extra:"preserved"};
  const body=kind==="BevelEmboss"?{enabled:true,texture:pattern}:{...pattern,common:{enabled:true}};
  const base={style:{enabled:true,items:[{[kind]:body}]},globalLight:{angle:120}};
  const target:StylePositionTarget={key:"a",index:0,kind};
  const next=translatePattern(base,target,{x:100,y:50},{x:-20,y:80})!;
  expect(patternPosition(next.style.items,target)).toMatchObject({...pattern,phase:[-108,21]});
  expect(next.globalLight).toEqual(base.globalLight);
  expect(patternPosition(base.style.items,target)?.phase).toEqual([12,-9]);
  expect(patternPosition(translatePattern(base,target,{x:100,y:50},{x:100,y:50})!.style.items,target)?.phase).toEqual([12,-9]);
});
it("缺少纹理、禁用效果、错位目标和超限偏移拒绝整次计算",()=>{
  const target:StylePositionTarget={key:"a",index:0,kind:"PatternOverlay"};
  const base={style:{enabled:true,items:[{PatternOverlay:{phase:[999999,0],common:{enabled:true}}}]}};
  expect(translatePattern(base,target,{x:0,y:0},{x:2,y:0})).toBeNull();
  expect(translatePattern(base,target,{x:0,y:0},{x:NaN,y:0})).toBeNull();
  expect(translatePattern(base,{...target,index:1},{x:0,y:0},{x:1,y:0})).toBeNull();
  expect(patternPosition([{BevelEmboss:{texture:null}}],{...target,kind:"BevelEmboss"})).toBeNull();
  base.style.items[0]!.PatternOverlay.common.enabled=false;
  expect(translatePattern(base,target,{x:0,y:0},{x:1,y:0})).toBeNull();
});

it("渐变偏移使用原生帧宽高比例，保持角度缩放、色标和原快照",()=>{
  const target:StylePositionTarget={key:"g",index:0,kind:"GradientOverlay"};
  const base={gradientFrame:readStyleGradientFrame([-13,7,200,80])!,style:{enabled:true,items:[{GradientOverlay:{common:{enabled:true},gradient:{offset:[.25,-.5],scale:2,angle:45,stops:[[0,"black"],[1,"white"]]}}}]}};
  const moved=translateStyle(base,target,{x:10,y:20},{x:60,y:60})!;
  expect(moved.style.items[0]!.GradientOverlay.gradient).toEqual({...base.style.items[0]!.GradientOverlay.gradient,offset:[.5,0]});
  expect(base.style.items[0]!.GradientOverlay.gradient.offset).toEqual([.25,-.5]);
  expect(translateStyle(base,target,{x:10,y:20},{x:10,y:20})).toEqual(base);
  expect(canPositionStyle({...base,gradientFrame:undefined},target)).toBe(false);
  expect(translateStyle({...base,gradientFrame:undefined},target,{x:0,y:0},{x:1,y:1})).toBeNull();
  expect(translateStyle(base,target,{x:0,y:0},{x:200_000_001,y:1})).toBeNull();
});
it("原生帧元数据严格核验，不向发光或描边提供错误的图层帧定位",()=>{
  for(const value of [null,[],[0,0,0,10],[0,0,20,-1],[0,0,20,1.5],[Infinity,0,20,10],[0,0,20,10,2],[0,0,2**32,10]]) expect(readStyleGradientFrame(value)).toBeUndefined();
  const target:StylePositionTarget={key:"g",index:0,kind:"GradientOverlay"};
  for(const kind of ["Stroke","InnerGlow","OuterGlow"]) {
    const base={gradientFrame:readStyleGradientFrame([0,0,200,80]),style:{enabled:true,items:[{[kind]:{paint:{Gradient:{offset:[0,0]}}}}]}};
    expect(canPositionStyle(base,target)).toBe(false);
  }
});
it("描边渐变只用本次查询的独立原生帧，不回退到图层或旧帧",()=>{
  const target:StylePositionTarget={key:"stroke",index:0,kind:"Stroke"};
  const base={gradientFrame:readStyleGradientFrame([0,0,800,600]),style:{enabled:true,items:[{Stroke:{common:{enabled:true},size:20,position:"Outside",paint:{Gradient:{offset:[.25,-.3],angle:45,scale:2}}}}]}};
  expect(canPositionStyle(base,target)).toBe(true);
  expect(translateStyle(base,target,{x:10,y:20},{x:70,y:70})).toBeNull();
  const next=translateStyle(base,target,{x:10,y:20},{x:70,y:70},[-16,4,240,100])!;
  expect(next.style.items[0]!.Stroke.paint.Gradient).toEqual({offset:[.5,.2],angle:45,scale:2});
  expect(base.style.items[0]!.Stroke.paint.Gradient.offset).toEqual([.25,-.3]);
  expect(translateStyle(base,target,{x:0,y:0},{x:1,y:1},[0,0,0,10])).toBeNull();
});

it.each(["DropShadow","InnerShadow"] as const)("%s 拖动遵循原生位移方向，局部角度和全局光源分别修改",kind=>{
  const target:StylePositionTarget={key:"s",index:0,kind};
  for(const linked of [false,true]) {
    const body={common:{enabled:true},distance:10,angle:0,use_global_light:linked,extra:"keep"};
    const base={globalLight:{angle:90,altitude:30},style:{enabled:true,items:[{[kind]:body},{DropShadow:{...body,use_global_light:true}}] as Record<string,typeof body>[]}};
    const next=translateStyle(base,target,{x:0,y:0},{x:10,y:0})!;
    const shadow=next.style.items[0]![kind]!;
    expect(shadow.distance).toBeCloseTo(linked?Math.sqrt(200):0);
    expect(shadow.angle).toBe(0);
    expect(next.globalLight.angle).toBeCloseTo(linked?135:90);
    expect(next.globalLight.altitude).toBe(30);
    expect(next.style.items[1]).toEqual(base.style.items[1]);
    expect(shadow.extra).toBe("keep");expect(body.distance).toBe(10);
    expect(translateStyle(base,target,{x:0,y:0},{x:0,y:0})).toEqual(base);
  }
  const base={style:{enabled:true,items:[{[kind]:{common:{enabled:true},distance:0,angle:-45,use_global_light:false}}]}};
  const next=translateStyle(base,target,{x:0,y:0},{x:0,y:-20})!;
  expect(next.style.items[0]![kind]!.distance).toBe(20);expect(next.style.items[0]![kind]!.angle).toBe(-90);
});
it("阴影参数边界、缺失光源、禁用和错误目标拒绝定位",()=>{
  const target:StylePositionTarget={key:"s",index:0,kind:"DropShadow"};
  const body={common:{enabled:true},distance:2048,angle:0,use_global_light:false};
  const base={style:{enabled:true,items:[{DropShadow:body}]}};
  expect(translateStyle(base,target,{x:0,y:0},{x:-1,y:0})).toBeNull();
  expect(translateStyle(base,target,{x:0,y:0},{x:NaN,y:0})).toBeNull();
  expect(canPositionStyle(base,{...target,index:1})).toBe(false);
  expect(canPositionStyle({...base,style:{...base.style,enabled:false}},target)).toBe(false);
  body.common.enabled=false;expect(canPositionStyle(base,target)).toBe(false);body.common.enabled=true;
  body.use_global_light=true;expect(canPositionStyle(base,target)).toBe(false);
  expect(canPositionStyle({...base,globalLight:{angle:Infinity}},target)).toBe(false);
  body.use_global_light=false;body.distance=-1;expect(canPositionStyle(base,target)).toBe(false);
  body.distance=1;body.angle=361;expect(canPositionStyle(base,target)).toBe(false);
  expect(patternPosition([{DropShadow:{phase:[0,0]}}],target)).toBeNull();
});
