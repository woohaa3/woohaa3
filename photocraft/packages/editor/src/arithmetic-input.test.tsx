/** @vitest-environment jsdom */
import {act,useState} from "react";import {createRoot} from "react-dom/client";import {expect,it,vi} from "vitest";import {ArithmeticInput} from "./arithmetic-input.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("表达式确认前使候选无效；Enter同步发布结果后调用最新确认，非法失焦不提交旧候选",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),confirm=vi.fn(),blur=vi.fn();
 function Probe(){const [value,setValue]=useState("10");return <ArithmeticInput value={value} invalidate min={1} max={1000} onChange={event=>setValue(event.currentTarget.value)} onBlur={blur} onKeyDown={event=>{if(event.key==="Enter")confirm(value);}}/>;}
 try{act(()=>root.render(<Probe/>));const input=host.querySelector("input")!;const edit=(text:string)=>act(()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,text);input.dispatchEvent(new Event("input",{bubbles:true}));});
 edit("(2+3)*4");expect(input.value).toBe("(2+3)*4");act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));expect(confirm.mock.calls).toEqual([["20"]]);expect(input.value).toBe("20");
 edit("5/0");act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));act(()=>input.blur());expect(confirm).toHaveBeenCalledOnce();expect(blur).not.toHaveBeenCalled();expect(input.validity.valid).toBe(false);
 edit("1000+1");act(()=>input.blur());expect(blur).not.toHaveBeenCalled();edit("1920/2");act(()=>input.blur());expect(input.value).toBe("960");expect(blur).toHaveBeenCalledOnce();
 }finally{act(()=>root.unmount());host.remove();}
});
it("单位换算与方向键保留原生数值体验，IME的Enter不提交",()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),changed=vi.fn(),enter=vi.fn();
 try{act(()=>root.render(<ArithmeticInput value={10} units={{unit:"px",dpi:300}} onChange={event=>changed(event.currentTarget.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.nativeEvent.isComposing)enter();}}/>));const input=host.querySelector("input")!;const edit=(text:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,text);input.dispatchEvent(new Event("input",{bubbles:true}));});
 edit("2in");act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true})));expect(changed).not.toHaveBeenCalled();act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));expect(changed.mock.lastCall).toEqual(["600"]);act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",shiftKey:true,bubbles:true})));expect(changed.mock.lastCall).toEqual(["610"]);
 }finally{act(()=>root.unmount());host.remove();}
});
