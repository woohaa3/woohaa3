/** @vitest-environment jsdom */
// Window protocol/state only: no rendering or device fullscreen claim.
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {useScreenModeWindow} from "./screen-mode-window.js";
import {INITIAL_EDITOR_DISPLAY,editorDisplayLayout,setEditorScreenMode,toggleEditorDisplay} from "./editor-display.js";
import type {EditorScreenMode} from "./editor-display.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|null=null;
afterEach(()=>{act(()=>root?.unmount());root=null;document.body.innerHTML="";vi.restoreAllMocks();});
function setup(){
  let full:Element|null=null;
  Object.defineProperty(document,"fullscreenElement",{configurable:true,get:()=>null});
  vi.spyOn(document,"fullscreenElement","get").mockImplementation(()=>full);
  const change=(element:Element|null)=>{full=element;document.dispatchEvent(new Event("fullscreenchange"));};
  const request=vi.fn(async()=>{change(document.documentElement);}),exit=vi.fn(async()=>{change(null);});
  Object.defineProperty(document.documentElement,"requestFullscreen",{configurable:true,value:request});
  Object.defineProperty(document,"exitFullscreen",{configurable:true,value:exit});
  const publish=vi.fn();let setMode:(mode:EditorScreenMode)=>void=()=>{};
  function Harness(){setMode=useScreenModeWindow(publish);return null;}
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);act(()=>root!.render(<Harness/>));
  return {request,exit,publish,change,setMode:(mode:EditorScreenMode)=>setMode(mode)};
}
it("三模式保持原面板/Tab恢复状态，全屏Tab只改变临时chrome",()=>{
  const original=toggleEditorDisplay(INITIAL_EDITOR_DISPLAY,"tools");
  let state=setEditorScreenMode(original,"fullScreenWithMenuBar");
  expect(editorDisplayLayout(state)).toEqual(editorDisplayLayout(original));
  state=setEditorScreenMode(state,"fullScreen");
  expect(editorDisplayLayout(state)).toMatchObject({chrome:false,toolbar:0,toolColumn:0,panel:false});
  state=toggleEditorDisplay(state,"panels");
  expect(editorDisplayLayout(state)).toEqual(editorDisplayLayout(original));
  expect(state.toolsVisible).toBe(false);expect(state.optionsVisible).toBe(true);expect(state.restore).toBeNull();
  state=toggleEditorDisplay(state,"panels");expect(editorDisplayLayout(state).toolbar).toBe(0);
  expect(editorDisplayLayout(setEditorScreenMode(state,"standard"))).toEqual(editorDisplayLayout(original));
});
it("一次可信请求进入，两全屏模式不重复请求；浏览器Escape还原标准",async()=>{
  const h=setup();await act(async()=>h.setMode("fullScreenWithMenuBar"));
  expect(h.request).toHaveBeenCalledTimes(1);expect(h.publish).toHaveBeenLastCalledWith("fullScreenWithMenuBar",undefined);
  act(()=>h.setMode("fullScreen"));expect(h.request).toHaveBeenCalledTimes(1);expect(h.publish).toHaveBeenLastCalledWith("fullScreen",undefined);
  act(()=>h.change(null));expect(h.publish).toHaveBeenLastCalledWith("standard",undefined);
  await act(async()=>h.setMode("fullScreen"));await act(async()=>h.setMode("standard"));expect(h.exit).toHaveBeenCalledTimes(1);
});
it("拒绝/同步失败保留标准，退出失败保留实际全屏；不退出外部已有全屏",async()=>{
  const h=setup();h.request.mockRejectedValueOnce(new Error("denied"));await act(async()=>h.setMode("fullScreen"));
  expect(h.publish.mock.lastCall).toEqual(["standard",expect.stringContaining("权限")]);
  h.request.mockImplementationOnce(()=>{throw new Error("sync");});act(()=>h.setMode("fullScreen"));expect(h.publish.mock.lastCall?.[0]).toBe("standard");
  await act(async()=>h.setMode("fullScreen"));h.exit.mockRejectedValueOnce(new Error("exit"));await act(async()=>h.setMode("standard"));
  expect(h.publish.mock.lastCall).toEqual(["fullScreen",expect.stringContaining("退出")]);
  act(()=>h.change(null));act(()=>h.change(document.body));act(()=>h.setMode("fullScreen"));
  h.exit.mockClear();act(()=>h.setMode("standard"));expect(h.exit).not.toHaveBeenCalled();
});
it("pending请求不重入，卸载后迟到成功退出自有全屏且不发布",async()=>{
  const h=setup();let resolve!:()=>void;h.request.mockImplementationOnce(()=>new Promise<void>(done=>{resolve=()=>{h.change(document.documentElement);done();};}));
  act(()=>{h.setMode("fullScreen");h.setMode("fullScreenWithMenuBar");});expect(h.request).toHaveBeenCalledTimes(1);
  act(()=>root!.unmount());root=null;await act(async()=>resolve());expect(h.publish).not.toHaveBeenCalled();expect(h.exit).toHaveBeenCalledTimes(1);
});
