/** @vitest-environment jsdom */
import {expect,it} from "vitest";
import {DEFAULT_NEW_DOCUMENT,decodeDocumentSettings,newDocumentParams,pixelsToUnit,unitToPixels} from "./new-document-dialog.js";

it("单位换算往返无损并保持整数像素",()=>{
  for(const unit of ["px","in","cm","mm","pt","pica"] as const){
    const px=unitToPixels(pixelsToUnit(1920,unit),unit);
    expect(Number.isInteger(px)).toBe(true);
    expect(Math.abs(px-1920)).toBeLessThanOrEqual(1);
  }
  expect(pixelsToUnit(144,"in")).toBe(2);
  expect(unitToPixels(2,"in")).toBe(144);
  expect(pixelsToUnit(72,"pt")).toBe(72);
});

it("严格解码文档设置：缺字段、越界与非枚举都返回 null",()=>{
  const base={width:800,height:600,resolution:72,mode:"rgb",depth:8,background:"white",unit:"px"};
  expect(decodeDocumentSettings(base)).toEqual(base);
  expect(decodeDocumentSettings({...base,mode:"grayscale"})?.mode).toBe("grayscale");
  expect(decodeDocumentSettings({...base,background:"#aabbcc"})?.background).toBe("#aabbcc");
  for(const bad of [null,{}, {...base,width:0},{...base,width:1.5},{...base,width:300001},
    {...base,resolution:0},{...base,resolution:30001},{...base,mode:"indexed"},{...base,depth:12},
    {...base,background:"transparentish"},{...base,unit:"furlong"},{...base,background:9}]){
    expect(decodeDocumentSettings(bad)).toBeNull();
  }
});

it("file.new 参数只含已核验字段，默认值可直接创建",()=>{
  expect(newDocumentParams(DEFAULT_NEW_DOCUMENT)).toEqual({width:1920,height:1080,resolution:72,mode:"rgb",depth:8,background:"white"});
  // 单位只是显示，不进入命令参数。
  expect(newDocumentParams({...DEFAULT_NEW_DOCUMENT,unit:"cm"})).not.toHaveProperty("unit");
});
