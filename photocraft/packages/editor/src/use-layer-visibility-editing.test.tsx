/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {useLayerVisibilityEditing,type LayerVisibilityEditing} from "./use-layer-visibility-editing.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();vi.unstubAllGlobals();});
it("快速扫动按帧合并并在释放前 flush；失败和禁用取消草稿，旧帧不能修改后续会话",()=>{
  let frame:FrameRequestCallback|null=null;vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback)=>{frame=callback;return 1;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const controller={beginLayerVisibility:vi.fn(()=>({ok:true,value:{}})),previewLayerProperties:vi.fn(()=>({ok:true,value:{}})),commitLayerProperties:vi.fn(()=>({ok:true,value:{}})),cancelLayerProperties:vi.fn()};
  const refresh=vi.fn(),error=vi.fn();let editing:LayerVisibilityEditing;
  function Harness({disabled=false}:{disabled?:boolean}) {editing=useLayerVisibilityEditing(controller as unknown as EditorWorkspaceController,refresh,error,disabled);return null;}
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);const render=(disabled=false)=>act(()=>root.render(<Harness disabled={disabled}/>));render();
  act(()=>{expect(editing!.begin(3)).toBe(true);editing!.preview([3],false);editing!.preview([3,2,1],false);});
  expect(controller.previewLayerProperties).not.toHaveBeenCalled();const stale=frame!;
  act(()=>expect(editing!.finish(true)).toBe(true));expect(controller.previewLayerProperties.mock.calls).toEqual([[{layers:[3,2,1],visible:false}]]);expect(controller.commitLayerProperties).toHaveBeenCalledTimes(1);
  act(()=>{editing!.begin(2);editing!.preview([2],true);stale(1);});expect(controller.previewLayerProperties).toHaveBeenCalledTimes(1);
  render(true);expect(controller.cancelLayerProperties).toHaveBeenCalledTimes(1);expect(editing!.active).toBe(false);
  render(false);controller.commitLayerProperties.mockReturnValueOnce({ok:false,message:"拒绝"} as never);
  act(()=>{editing!.begin(1);editing!.preview([1],false);expect(editing!.finish(true)).toBe(false);});
  expect(controller.cancelLayerProperties).toHaveBeenCalledTimes(2);expect(error.mock.lastCall).toEqual(["拒绝"]);
  controller.beginLayerVisibility.mockReturnValueOnce({ok:false,message:"旧内核"} as never);
  act(()=>expect(editing!.begin(1)).toBe(false));expect(error.mock.lastCall).toEqual(["旧内核"]);
});
