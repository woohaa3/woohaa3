/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {usePaintTools,decodePaintMemory} from "./paint-tool-state.js";
import {decodeTextToolMemory} from "./use-text-editing.js";
import {TOOL_MEMORY_PREFIX,readToolMemory} from "./tool-memory.js";
import {decodeBucketMemory,decodeMarqueeConstraint,decodeRememberedTool,decodeSampleMemory} from "./tool-option-memory.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("remount restores independent paint heads and colors, never document edit target",()=>{
 const host=document.createElement("div");document.body.append(host);let root=createRoot(host),paint:ReturnType<typeof usePaintTools>;
 function Probe({tool="brush",target="pixels"}:{tool?:string;target?:"pixels"|"mask"}){paint=usePaintTools(tool,target);return null;}
 try{act(()=>root.render(<Probe/>));act(()=>paint.setBrush({...paint.brush,size:77,flow:.35,color:"#aabbcc"}));act(()=>root.render(<Probe tool="pencil"/>));act(()=>paint.setBrush({...paint.brush,size:3,autoErase:true}));act(()=>paint.setBackground("#123456"));act(()=>root.unmount());
 const stored=localStorage.getItem(TOOL_MEMORY_PREFIX+"paint")!;expect(stored).not.toContain("target");expect(stored).not.toContain("color");
 root=createRoot(host);act(()=>root.render(<Probe target="mask"/>));expect(paint!.brush).toMatchObject({size:77,flow:.35,color:"#ffffff",target:"mask"});expect(paint!.colors.background).toBe("#000000");act(()=>paint!.setColor("#999999"));act(()=>root.render(<Probe tool="pencil"/>));expect(paint!.colors).toEqual({foreground:"#aabbcc",background:"#123456"});expect(paint!.brush).toMatchObject({size:3,autoErase:true});act(()=>paint!.resetPaint("all"));expect(localStorage.getItem(TOOL_MEMORY_PREFIX+"paint")).toBeNull();expect(paint!.colors.foreground).toBe("#aabbcc");
 }finally{act(()=>root.unmount());host.remove();}
});
it("malformed and unsupported memories fall back per field; drafts and unknown fields are excluded",()=>{
 expect(decodeTextToolMemory({text:"private document",size:Infinity,font:"unsupported",align:"right"})).toEqual({font:"Noto Sans SC",size:48,color:"#000000",bold:false,align:"right"});
 const decoded=decodePaintMemory({brush:{size:Infinity,flow:-1,opacity:.4,angle:999,mode:"invalid",target:"mask",document:{secret:true}},pencil:{size:4}});
 expect(decoded.brush).toMatchObject({size:24,flow:1,opacity:.4,angle:0,mode:"Normal"});expect(decoded.pencil.size).toBe(4);expect(JSON.stringify(decoded)).not.toMatch(/secret|document|target/);
 localStorage.setItem(TOOL_MEMORY_PREFIX+"paint","{broken");expect(readToolMemory("paint","fallback",()=>"decoded")).toBe("fallback");
 expect(decodeBucketMemory({opacity:"100/0",tolerance:"-1",contiguous:"false"})).toMatchObject({opacity:"100",tolerance:"32",contiguous:true});expect(decodeMarqueeConstraint({mode:"size",width:"2.5",height:"200"})).toEqual({mode:"size",width:"1",height:"200"});expect(decodeRememberedTool("transform")).toBe("marquee");expect(decodeSampleMemory({size:4,sampleLayer:"secret"})).toEqual({size:1,sampleLayer:"all"});
});
it("storage rejection reports once while tool changes stay usable",()=>{
 const host=document.createElement("div"),root=createRoot(host),report=vi.fn();let paint:ReturnType<typeof usePaintTools>;const set=vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota");});
 function Probe(){paint=usePaintTools("brush","pixels",report);return null;}
 try{act(()=>root.render(<Probe/>));act(()=>paint.setBrush({...paint.brush,size:42}));act(()=>paint.setBrush({...paint.brush,size:43}));expect(paint!.brush.size).toBe(43);expect(report).toHaveBeenCalledTimes(1);}finally{set.mockRestore();act(()=>root.unmount());}
});
