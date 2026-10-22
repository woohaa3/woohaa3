/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from "vitest";
import {CONTOUR_LIBRARY_KEY,readContourLibrary,saveContourLibrary,validateContourLibrary,validLibraryContour} from "./contour-preset-store.js";
afterEach(()=>{localStorage.clear();vi.restoreAllMocks();});
const contour={Custom:{name:"细曲线",points:[{input:0,output:0},{input:.0001,output:.8},{input:1,output:1}]}};
const preset={id:"user-1",name:"细曲线",contour};
it("本机往返保留精细控制点、名称和稳定身份，不经 SHC 量化",()=>{
  expect(saveContourLibrary([preset])).toBe(true);
  expect(readContourLibrary()).toEqual([preset]);
  expect(validLibraryContour(contour)).toBe(true);
});
it("坏数据、未知结构、过量和重复身份整批拒绝",()=>{
  expect(validLibraryContour({Custom:{...contour.Custom,extra:true}})).toBe(false);
  expect(validLibraryContour({Custom:{...contour.Custom,points:[{input:0,output:0},{input:0,output:1}]}})).toBe(false);
  expect(validLibraryContour({Custom:{...contour.Custom,corners:[false,"false"]}})).toBe(false);
  expect(validateContourLibrary([preset,preset])).toBe(false);
  expect(validateContourLibrary(Array.from({length:65},(_,i)=>({...preset,id:String(i)})))).toBe(false);
  expect(saveContourLibrary([preset])).toBe(true);
  const before=localStorage.getItem(CONTOUR_LIBRARY_KEY);
  expect(saveContourLibrary([{...preset,name:" "}])).toBe(false);
  expect(localStorage.getItem(CONTOUR_LIBRARY_KEY)).toBe(before);
  localStorage.setItem(CONTOUR_LIBRARY_KEY,JSON.stringify({version:2,presets:[preset]}));expect(readContourLibrary()).toEqual([]);
  localStorage.setItem(CONTOUR_LIBRARY_KEY,"{");expect(readContourLibrary()).toEqual([]);
});
it("存储读取或写入受限时返回明确失败，不抛出异常",()=>{
  vi.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw new Error("denied");});
  vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota");});
  expect(readContourLibrary()).toEqual([]);expect(saveContourLibrary([preset])).toBe(false);
});

it("库总大小超限拒绝，不覆盖已有数据",()=>{
  expect(saveContourLibrary([preset])).toBe(true);
  const before=localStorage.getItem(CONTOUR_LIBRARY_KEY);
  const large=Array.from({length:64},(_,i)=>({...preset,id:String(i),contour:{Custom:{name:"大曲线",points:Array.from({length:256},(_,j)=>({input:j/255,output:.12345678901234567})),corners:Array(256).fill(false)}}}));
  expect(validateContourLibrary(large)).toBe(false);expect(saveContourLibrary(large)).toBe(false);
  expect(localStorage.getItem(CONTOUR_LIBRARY_KEY)).toBe(before);
});
