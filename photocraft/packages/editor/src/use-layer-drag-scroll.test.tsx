/** @vitest-environment jsdom */
import {act,useRef} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {useLayerDragScroll} from "./use-layer-drag-scroll.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();vi.unstubAllGlobals();});
it("边缘速度渐增且窗口外有界；中间静止，取消/失焦/只读终止帧循环",()=>{
  let pending:FrameRequestCallback|null=null;
  vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback)=>{pending=callback;return 1;}));
  const cancel=vi.fn(()=>{pending=null;});vi.stubGlobal("cancelAnimationFrame",cancel);
  let scroll:ReturnType<typeof useLayerDragScroll>;
  function Probe({disabled=false}:{disabled?:boolean}) {const viewport=useRef<HTMLDivElement>(null);scroll=useLayerDragScroll(viewport,disabled);return <div ref={viewport}/>;}
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);const render=(disabled=false)=>act(()=>root.render(<Probe disabled={disabled}/>));render();
  const viewport=container.firstElementChild as HTMLElement;vi.spyOn(viewport,"getBoundingClientRect").mockReturnValue({top:100,bottom:400,height:300} as DOMRect);
  const tick=(time:number)=>{const next=pending;pending=null;act(()=>next?.(time));};
  scroll!.move(250);tick(0);expect(viewport.scrollTop).toBe(0);
  scroll!.move(380);tick(16);const gradual=viewport.scrollTop;expect(gradual).toBeGreaterThan(0);expect(gradual).toBeLessThan(9.6);
  act(()=>document.body.dispatchEvent(new MouseEvent("dragover",{bubbles:true,clientY:10000})));tick(10000);expect(viewport.scrollTop-gradual).toBeCloseTo(19.2);
  scroll!.stop();expect(pending).toBeNull();scroll!.move(-1000);tick(10016);expect(viewport.scrollTop).toBeLessThan(gradual+19.2);
  act(()=>window.dispatchEvent(new Event("blur")));expect(pending).toBeNull();
  scroll!.move(380);act(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"})));expect(pending).toBeNull();
  scroll!.move(380);render(true);expect(pending).toBeNull();expect(cancel).toHaveBeenCalled();
});
