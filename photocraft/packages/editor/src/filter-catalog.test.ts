import {describe,expect,it} from "vitest";
import {FILTER_GROUPS,FILTER_SPECS,buildFilter,filterDefaults,filterSpec} from "./filter-catalog.js";

describe("滤镜目录与参数（I035）",()=>{
 it("目录覆盖固定引擎的 24 条可单独提交滤镜，且 id 唯一",()=>{
  expect(FILTER_SPECS).toHaveLength(24);
  expect(new Set(FILTER_SPECS.map(spec=>spec.id)).size).toBe(24);
  for(const spec of FILTER_SPECS){
   expect(spec.id.startsWith("filter.")).toBe(true);
   expect(FILTER_GROUPS).toContain(spec.group);
   // 每条都有可显示的参数（无参滤镜为空数组）。
   expect(Array.isArray(spec.fields)).toBe(true);
  }
  // 参数表单覆盖的每条命令都能从 id 反查。
  expect(filterSpec("filter.blur.gaussianBlur")?.label).toBe("高斯模糊…");
  expect(filterSpec("filter.liquify")).toBeNull();
 });

 it("默认值来自原生注册表而不是一律取最小",()=>{
  expect(filterDefaults(filterSpec("filter.blur.motionBlur")!)).toEqual({angle:0,distance:10});
  expect(filterDefaults(filterSpec("filter.distort.spherize")!)).toEqual({amount:100,mode:"normal"});
  expect(filterDefaults(filterSpec("filter.pixelate.mosaic")!)).toEqual({cellSize:10});
  expect(filterDefaults(filterSpec("filter.stylize.emboss")!)).toEqual({angle:135,height:3,amount:100});
 });

 it("越界、非数值与非枚举被拒绝，合法值原样编译",()=>{
  const gaussian=filterSpec("filter.blur.gaussianBlur")!;
  expect(buildFilter(gaussian,{radius:2.5})).toEqual({ok:true,params:{radius:2.5}});
  expect(buildFilter(gaussian,{radius:0})).toMatchObject({ok:false});
  expect(buildFilter(gaussian,{radius:1001})).toMatchObject({ok:false});
  expect(buildFilter(gaussian,{radius:"abc"})).toMatchObject({ok:false});
  expect(buildFilter(gaussian,{})).toMatchObject({ok:false});
  const spherize=filterSpec("filter.distort.spherize")!;
  expect(buildFilter(spherize,{amount:-50,mode:"horizontalOnly"})).toEqual({ok:true,params:{amount:-50,mode:"horizontalOnly"}});
  expect(buildFilter(spherize,{amount:-50,mode:"diagonal"})).toMatchObject({ok:false});
  expect(buildFilter(spherize,{amount:-101,mode:"normal"})).toMatchObject({ok:false});
  // 无参滤镜编译成空对象。
  expect(buildFilter(filterSpec("filter.blur.blur")!,{})).toEqual({ok:true,params:{}});
 });
});
