import {describe,expect,it} from "vitest";
import {adjustmentFields,buildAdjustmentParams} from "./adjustment-dialog.js";

const values=(kind:Parameters<typeof adjustmentFields>[0])=>{const out:Record<string,any>={};for(const field of adjustmentFields(kind))out[field.key]=field.value;return out;};

describe("直接图像调整参数",()=>{
 it("无参调整生成空对象，其余按固定引擎字段名编译",()=>{
  expect(buildAdjustmentParams("invert",{})).toEqual({});
  expect(buildAdjustmentParams("desaturate",{})).toEqual({});
  expect(buildAdjustmentParams("equalize",{})).toEqual({});
  expect(buildAdjustmentParams("posterize",values("posterize") as never)).toEqual({levels:4});
  expect(buildAdjustmentParams("threshold",values("threshold") as never)).toEqual({level:128});
  expect(buildAdjustmentParams("levels",values("levels") as never)).toEqual({inBlack:0,gamma:1,inWhite:255,outBlack:0,outWhite:255});
 });

 it("亮度、色相和曲线可直接提交且拒绝无效候选",()=>{
  expect(buildAdjustmentParams("brightnessContrast",values("brightnessContrast"))).toEqual({brightness:0,contrast:0,legacy:false});
  expect(buildAdjustmentParams("hueSaturation",values("hueSaturation"))).toEqual({hue:0,saturation:0,lightness:0});
  expect(buildAdjustmentParams("curves",{points:[[0,0],[100,180],[255,255]]})).toEqual({points:[[0,0],[100,180],[255,255]]});
  expect(buildAdjustmentParams("curves",{points:[[0,0],[0,255]]})).toBeNull();
  expect(buildAdjustmentParams("brightnessContrast",{brightness:151,contrast:0,legacy:false})).toBeNull();
 });

 it("渐变映射输出 0–1 位置的两端色标，不发送界面内部结构",()=>{
  expect(buildAdjustmentParams("gradientMap",{stops:["#112233","#ddeeff"],reverse:false,dither:true})).toEqual({stops:[[0,"#112233"],[1,"#ddeeff"]],reverse:false,dither:true});
  expect(buildAdjustmentParams("gradientMap",{stops:["#112233","not-a-color"],reverse:false,dither:false})).toBeNull();
 });

 it("越界数值、未知枚举与缺失字段拒绝提交",()=>{
  const levels=values("levels");levels["gamma"]=0;expect(buildAdjustmentParams("levels",levels as never)).toBeNull();
  const exposure=values("exposure");exposure["exposure"]=21;expect(buildAdjustmentParams("exposure",exposure as never)).toBeNull();
  const black=values("blackWhite");black["filter"]="red";expect(buildAdjustmentParams("blackWhite",black)).not.toBeNull();
  const photo=values("photoFilter");photo["filter"]="sepiaTone";expect(buildAdjustmentParams("photoFilter",photo)).toBeNull();
  const selective=values("selectiveColor");(selective["reds"] as unknown)=[];expect(buildAdjustmentParams("selectiveColor",selective)).not.toBeNull();
  const balance=values("colorBalance");(balance["midtones"] as unknown)=[0,0];expect(buildAdjustmentParams("colorBalance",balance)).toBeNull();
  const mixer=values("channelMixer");(mixer["red"] as unknown)=[0,0,0,999];expect(buildAdjustmentParams("channelMixer",mixer)).toBeNull();
 });

 it("各调整的字段集合只包含本类型公开参数",()=>{
  expect(adjustmentFields("levels").map(field=>field.key)).toEqual(["inBlack","gamma","inWhite","outBlack","outWhite"]);
  expect(adjustmentFields("vibrance").map(field=>field.key)).toEqual(["vibrance","saturation"]);
  expect(adjustmentFields("photoFilter").map(field=>field.key)).toEqual(["filter","color","density","preserveLuminosity"]);
  expect(adjustmentFields("selectiveColor").map(field=>field.key)).toEqual(["method","colors","cyan","magenta","yellow","black"]);
  expect(adjustmentFields("invert")).toHaveLength(0);
 });
});
