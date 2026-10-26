/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {HistogramPanel} from "./histogram-panel.js";
import {decodeHistogram,type HistogramReadout} from "./histogram-data.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const bins=Array.from({length:256},(_,i)=>i===85?1:0);
const sample:HistogramReadout={channels:Array.from({length:4},()=>({bins,mean:85,stdDev:0,median:85,samples:1})),pixels:48,cacheLevel:1};
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("validates bounded bins, consistent counts and native statistics",()=>{
  expect(decodeHistogram(sample)).toEqual(sample);
  for(const patch of [{pixels:0},{cacheLevel:0},{channels:[]},{channels:sample.channels.map(c=>({...c,samples:2}))},{channels:sample.channels.map(c=>({...c,mean:NaN}))},{channels:sample.channels.map(c=>({...c,bins:[1]}))}])expect(()=>decodeHistogram({...sample,...patch})).toThrow();
});
it("throttles changing candidates to 250ms, marks cached data, clears across documents and unmounts",()=>{
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});
  const read=vi.fn(()=>({ok:true as const,value:sample})),node=document.createElement("div"),root=createRoot(node);
  const render=(doc="a",revision="1")=>act(()=>root.render(<HistogramPanel documentKey={doc} contextKey={revision} read={read}/>));
  const tick=(ms:number)=>act(()=>vi.advanceTimersByTime(ms));
  try{
    render();tick(0);expect(read).toHaveBeenCalledTimes(1);expect(node.textContent).toContain("48");
    render("a","2");expect(node.querySelector("[data-histogram-cached]")).not.toBeNull();tick(100);render("a","3");tick(149);expect(read).toHaveBeenCalledTimes(1);tick(1);expect(read).toHaveBeenCalledTimes(2);expect(node.querySelector("[data-histogram-cached]")).toBeNull();
    const select=node.querySelector("select")!;act(()=>{select.value="1";select.dispatchEvent(new Event("change",{bubbles:true}));});expect(read).toHaveBeenCalledTimes(2);expect(node.querySelector("svg")?.getAttribute("data-histogram-channel")).toBe("1");
    render("b");expect(node.textContent).not.toContain("48");tick(0);expect(read).toHaveBeenCalledTimes(3);
    render("b","4");act(()=>root.unmount());tick(1000);expect(read).toHaveBeenCalledTimes(3);
  }finally{act(()=>root.unmount());}
});
it("failed reads clear the former bins and show the error",()=>{
  vi.useFakeTimers();const node=document.createElement("div"),root=createRoot(node);
  try{act(()=>root.render(<HistogramPanel documentKey="a" contextKey="1" read={()=>({ok:false,code:"unavailable",message:"内核读取失败"})}/>));act(()=>vi.runAllTimers());expect(node.textContent).toContain("内核读取失败");expect(node.querySelector("path")?.getAttribute("d")).toBe("");}
  finally{act(()=>root.unmount());}
});
it("inactive mounted tabs cancel pending reads and refresh when reopened",()=>{
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});
 const read=vi.fn(()=>({ok:true as const,value:sample})),node=document.createElement("div"),root=createRoot(node);
 const render=(active:boolean,contextKey:string)=>act(()=>root.render(<HistogramPanel documentKey="a" contextKey={contextKey} active={active} read={read}/>));
 try {
  render(true,"1");act(()=>vi.advanceTimersByTime(0));expect(read).toHaveBeenCalledTimes(1);
  render(true,"2");render(false,"2");act(()=>vi.advanceTimersByTime(1000));expect(read).toHaveBeenCalledTimes(1);
  render(false,"3");act(()=>vi.advanceTimersByTime(1000));expect(read).toHaveBeenCalledTimes(1);
  render(true,"3");act(()=>vi.advanceTimersByTime(250));expect(read).toHaveBeenCalledTimes(2);
 } finally {act(()=>root.unmount());}
});
