/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {useLayerPropertiesEditing} from "./use-layer-properties-editing.js";
import {savePatternLibrarySnapshot} from "./pattern-preset-store.js";
vi.mock("./pattern-preset-store.js",()=>({readPatternLibrarySnapshot:vi.fn(async()=>null),savePatternLibrarySnapshot:vi.fn(async()=>{})}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("创建图案更新本机库并保存独立快照；原生拒绝不保存，存储失败不丢内存图案",async()=>{
 let presets:unknown[]=[];const dispatch=vi.fn(()=>{presets=[{key:"p",id:"p-id",name:"Region",width:4,height:3}];return {ok:true};}),snapshot=vi.fn(()=>({ok:true,value:new Uint8Array([1,2,3])})),error=vi.fn();
 const controller={patternLibrary:()=>({ok:true,value:{presets}}),dispatch,patternLibrarySnapshot:snapshot} as unknown as EditorWorkspaceController;
 let editing!:ReturnType<typeof useLayerPropertiesEditing>,blocked=false;
 function App(){editing=useLayerPropertiesEditing(controller,undefined,vi.fn(),error,blocked);return null;}
 const node=document.createElement("div"),root=createRoot(node),render=()=>act(()=>root.render(<App/>));render();
 try{
  act(()=>expect(editing.definePattern("Region")).toBeNull());expect(dispatch.mock.calls).toEqual([["edit.definePattern",{name:"Region"}]]);expect(editing.styleEditing.patternLibrary?.presets[0]?.name).toBe("Region");expect(savePatternLibrarySnapshot).toHaveBeenCalledWith(new Uint8Array([1,2,3]));
  vi.mocked(savePatternLibrarySnapshot).mockClear();dispatch.mockReturnValueOnce({ok:false,message:"满了"} as never);act(()=>expect(editing.definePattern("Rejected")).toBe("满了"));expect(savePatternLibrarySnapshot).not.toHaveBeenCalled();
  vi.mocked(savePatternLibrarySnapshot).mockRejectedValueOnce(new Error("quota"));await act(async()=>{expect(editing.definePattern("Region")).toBeNull();await Promise.resolve();});expect(error.mock.lastCall?.[0]).toContain("浏览器未能保存图案库");expect(editing.styleEditing.patternLibrary?.presets).toHaveLength(1);
  blocked=true;render();dispatch.mockClear();act(()=>expect(editing.definePattern("Blocked")).toContain("结束当前操作"));expect(dispatch).not.toHaveBeenCalled();
 }finally{act(()=>root.unmount());}
});
