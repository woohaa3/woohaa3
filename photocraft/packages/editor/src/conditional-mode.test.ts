import {expect,it} from "vitest";
import {DEFAULT_CONDITIONAL_MODE,buildConditionalMode,decodeConditionalModeResult,willConvert} from "./conditional-mode.js";

it("任意来源编译为 from:\"any\"，显式来源去重后按引擎名称提交",()=>{
  expect(buildConditionalMode(DEFAULT_CONDITIONAL_MODE)).toEqual({from:"any",to:"rgb"});
  expect(buildConditionalMode({anySource:false,from:["grayscale","cmyk"],to:"lab"})).toEqual({from:["grayscale","cmyk"],to:"lab"});
  // 未选来源且未勾选任意：表单无效。
  expect(buildConditionalMode({anySource:false,from:[],to:"rgb"})).toBeNull();
  // 未知来源被过滤；全部未知时视为无效。
  expect(buildConditionalMode({anySource:false,from:["bogus" as never],to:"rgb"})).toBeNull();
  // 未知目标被拒绝。
  expect(buildConditionalMode({anySource:true,from:[],to:"bitmap" as never})).toBeNull();
});

it("只有当前模式在来源集合内且与目标不同才会转换",()=>{
  expect(willConvert({anySource:true,from:[],to:"rgb"},"cmyk")).toBe(true);
  expect(willConvert({anySource:true,from:[],to:"rgb"},"Rgb")).toBe(false);
  // 引擎把 gray 归一为 grayscale。
  expect(willConvert({anySource:true,from:[],to:"grayscale"},"Gray")).toBe(false);
  expect(willConvert({anySource:false,from:["cmyk"],to:"rgb"},"cmyk")).toBe(true);
  expect(willConvert({anySource:false,from:["cmyk"],to:"rgb"},"lab")).toBe(false);
});

it("回执严格解码：缺字段或类型不符返回 null",()=>{
  expect(decodeConditionalModeResult({changed:true,mode:"rgb"})).toEqual({changed:true,mode:"rgb"});
  expect(decodeConditionalModeResult({changed:false,mode:"lab"})).toEqual({changed:false,mode:"lab"});
  expect(decodeConditionalModeResult(null)).toBeNull();
  expect(decodeConditionalModeResult({changed:"yes",mode:"rgb"})).toBeNull();
  expect(decodeConditionalModeResult({changed:true})).toBeNull();
  expect(decodeConditionalModeResult({changed:true,mode:""})).toBeNull();
});
