/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCanvasLasso } from "./canvas-lasso.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each(["polygon-lasso","magnetic-lasso"])("%s 支持画布取点、回退、闭合，并把未完成点列纳入保存门禁", tool => {
  let blocked=false;
  const session={beginMagneticLasso:vi.fn((_params: Record<string,unknown>)=>({ok:true,value:{}})),updateMagneticLasso:vi.fn(()=>({ok:true,value:{}})),draftOutline:vi.fn(()=>({ok:true,value:[]})),commitSelectionDraft:vi.fn(()=>({ok:true,value:{}})),cancelSelectionDraft:vi.fn()};
  const controller={features:{selections:session},hasActiveDraft:()=>blocked,setCanvasToolDraft:(active:boolean)=>{blocked=active;}} as unknown as EditorWorkspaceController;
  const container=document.createElement("div"), root=createRoot(container);
  let hook!:ReturnType<typeof useCanvasLasso>;
  function App(){hook=useCanvasLasso(controller,tool,100,100,"replace",1,vi.fn(),vi.fn());return null;}
  try {
    act(()=>root.render(<App/>));
    act(()=>{hook.add({x:10,y:10});hook.add({x:50,y:10});});
    expect(blocked).toBe(true);expect(session.beginMagneticLasso).not.toHaveBeenCalled();
    act(()=>hook.back());expect(hook.count).toBe(1);
    act(()=>{hook.add({x:50,y:10});hook.add({x:50,y:50});});
    expect(session.beginMagneticLasso).toHaveBeenCalledOnce();
    if(tool==="polygon-lasso")expect(session.beginMagneticLasso.mock.calls[0]?.[0]).toMatchObject({trace:false});
    act(()=>hook.finish());expect(session.commitSelectionDraft).toHaveBeenCalledOnce();expect(hook.active).toBe(false);expect(blocked).toBe(false);
    act(()=>hook.add({x:50,y:50},true));expect(hook.active).toBe(false);
    act(()=>hook.add({x:10,y:10}));act(()=>hook.cancel());expect(hook.active).toBe(false);expect(blocked).toBe(false);
  } finally {act(()=>root.unmount());container.remove();}
});
