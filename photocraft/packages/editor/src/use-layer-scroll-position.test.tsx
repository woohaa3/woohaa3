/** @vitest-environment jsdom */
import {act,useRef} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {useLayerScrollPosition} from "./use-layer-scroll-position.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();});
it("各文档滚动隔离；短列表自动钳制不覆盖旧偏好，重挂载恢复且不创建内容命令",()=>{
  const a={},b={},restored=vi.fn();let owner=a,rows=40;let scrollHeight=1000;
  function Probe() {const viewport=useRef<HTMLDivElement>(null),save=useLayerScrollPosition(viewport,owner,0,rows,restored);return <div ref={viewport} onScroll={save}/>;}
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);const render=()=>act(()=>root.render(<Probe/>));render();
  const element=()=>container.firstElementChild as HTMLElement;
  const dimensions=()=>{Object.defineProperty(element(),"scrollHeight",{get:()=>scrollHeight,configurable:true});Object.defineProperty(element(),"clientHeight",{value:200,configurable:true});};dimensions();
  const scroll=(top:number)=>act(()=>{element().scrollTop=top;element().dispatchEvent(new Event("scroll"));});
  scroll(500);owner=b;render();scroll(100);owner=a;render();expect(element().scrollTop).toBe(500);expect(restored).toHaveBeenCalledTimes(1);
  scrollHeight=200;rows=3;render();scroll(0);scrollHeight=1000;rows=40;render();expect(element().scrollTop).toBe(500);
  owner=b;render();expect(element().scrollTop).toBe(100);
  act(()=>root.render(null));render();dimensions();expect(element().scrollTop).toBe(100);
});
