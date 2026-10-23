/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCanvasCrop } from "./canvas-crop.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("裁剪框拖动只更新候选，确认一次提交；取消与失败候选不能写入",()=>{
  const begin=vi.fn(()=>({ok:true,value:{}})), update=vi.fn(()=>({ok:true,value:{}})), commit=vi.fn(()=>({ok:true,value:{}})), cancel=vi.fn();
  const controller={beginCompose:begin,updateCompose:update,commitCompose:commit,cancelCompose:cancel} as unknown as EditorWorkspaceController;
  const container=document.createElement("div"),root=createRoot(container);let crop!:ReturnType<typeof useCanvasCrop>;
  function App(){crop=useCanvasCrop(controller,100,100,vi.fn(),vi.fn());return null;}
  try {
    act(()=>root.render(<App/>));
    act(()=>crop.preview({x:10,y:10,width:50,height:40}));
    expect(begin).toHaveBeenCalledWith("image.crop",expect.objectContaining({x:10,y:10,width:50,height:40}));
    act(()=>crop.preview({x:12,y:10,width:48,height:40}));expect(update).toHaveBeenCalledOnce();expect(commit).not.toHaveBeenCalled();
    act(()=>crop.confirm());expect(commit).toHaveBeenCalledOnce();expect(crop.active).toBe(false);
    act(()=>crop.preview({x:10,y:10,width:50,height:40}));act(()=>crop.cancel());expect(cancel).toHaveBeenCalledOnce();
    act(()=>crop.preview({x:0,y:0,width:-1,height:10}));act(()=>crop.confirm());expect(commit).toHaveBeenCalledOnce();
  } finally {act(()=>root.unmount());container.remove();}
});
