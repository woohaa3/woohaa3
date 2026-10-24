/** @vitest-environment jsdom */
import {act,useState} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {PaintModeField} from "./paint-mode-field.js";
import {cyclePaintMode,PAINT_MODES} from "./paint-modes.js";
import {decodePaintMemory} from "./paint-tool-state.js";
import {PHOTOSHOP_BLENDS} from "./editor-view-model.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("绘画Clear位于Dissolve后，独立记忆且不污染图层混合模式",()=>{
 expect(PAINT_MODES.slice(0,4)).toEqual(["Normal","Dissolve","Clear","Darken"]);expect(PHOTOSHOP_BLENDS).not.toContain("Clear");
 expect(cyclePaintMode("Dissolve",1)).toBe("Clear");expect(cyclePaintMode("Clear",1)).toBe("Darken");expect(cyclePaintMode("Normal",-1)).toBe("Luminosity");
 const memory=decodePaintMemory({brush:{mode:"Clear"},pencil:{mode:"Multiply"},eraser:{mode:"bad"}});expect(memory.brush.mode).toBe("Clear");expect(memory.pencil.mode).toBe("Multiply");expect(memory.eraser.mode).toBe("Normal");
});
it("悬停滚轮逐项/边界夹紧，反向和离开清余量，禁用及缩放修饰不写",()=>{
 const node=document.createElement("div"),root=createRoot(node),changed=vi.fn();let disabled=false;
 function Probe(){const [value,setValue]=useState("Normal");return <PaintModeField value={value} disabled={disabled} onChange={next=>{changed(next);setValue(next);}}/>;}
 const render=()=>act(()=>root.render(<Probe/>));render();const select=node.querySelector("select")!;
 const wheel=(deltaY:number,options:WheelEventInit={})=>{const event=new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY,...options});act(()=>select.dispatchEvent(event));return event;};
 try {
  expect(wheel(20).defaultPrevented).toBe(true);expect(changed).not.toHaveBeenCalled();wheel(20);expect(select.value).toBe("Dissolve");wheel(1,{deltaMode:1});expect(select.value).toBe("Clear");wheel(40);expect(select.value).toBe("Darken");
  wheel(-20);wheel(20);expect(select.value).toBe("Darken");
  act(()=>select.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body})));wheel(20);expect(select.value).toBe("Darken");
  wheel(20,{ctrlKey:true});expect(select.value).toBe("Darken");disabled=true;render();wheel(80);expect(select.value).toBe("Darken");disabled=false;render();wheel(-10000);expect(select.value).toBe("Normal");const calls=changed.mock.calls.length;wheel(-80);expect(changed).toHaveBeenCalledTimes(calls);
 }finally{act(()=>root.unmount());}
});
