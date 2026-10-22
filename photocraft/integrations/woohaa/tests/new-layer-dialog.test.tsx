/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DialogService } from "@woohaa3/frontend/plugin-api";
import type { EditorWorkspaceController } from "../src/editor-workspace.js";
import { useNewLayerDialog } from "@woohaa3/photocraft-editor";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

it("dirty naming cancel/confirm/reopen preserves owner and rejects direct or expired requests", async () => {
  const dialogs=new DialogService();
  let owner: {canvasId:string;nodeId:string;sessionId:string}|null={canvasId:"c",nodeId:"n",sessionId:"s"};
  const dispatch=vi.fn(()=>({ok:true}));
  const controller={dialogOwner:()=>owner,snapshot:()=>({commands:new Map([["layer.new.layer",{allowed:true,enabled:true}]])}),dispatch} as unknown as EditorWorkspaceController;
  let blocked=false;
  function Probe() {
    const naming=useNewLayerDialog(dialogs,controller,blocked);
    const instance=dialogs.top();const Renderer=instance?dialogs.resolveRenderer(instance.dialogId):null;
    return <><button onClick={()=>naming.open()}>新建</button>{Renderer && instance ? <Renderer instance={instance}
      requestClose={()=>dialogs.requestClose()} setBusy={busy=>{dialogs.setBusy(instance.instanceId,busy);}} replace={()=>{}} />:null}</>;
  }
  const el=document.createElement("div");document.body.append(el);const root=createRoot(el);
  const render=async()=>act(async()=>root.render(<Probe />));
  const open=async()=>act(async()=>el.querySelector("button")!.click());
  try {
    await render();
    expect(dialogs.open({dialogId:"image-editor.new-layer"}).ok).toBe(false);
    expect(dialogs.open({dialogId:"image-editor.new-layer",payload:{editingOwner:owner}}).ok).toBe(false);
    await open();expect(dialogs.top()).not.toBeNull();
    await act(async()=>[...el.querySelectorAll("button")].find(button=>button.textContent==="取消")!.click());
    expect(dispatch).not.toHaveBeenCalled();expect(dialogs.top()).toBeNull();
    for(let i=0;i<2;i++) {
      await open();
      await act(async()=>el.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
      expect(dispatch).toHaveBeenCalledTimes(i+1);expect(dialogs.top()).toBeNull();
    }
    await open();owner={canvasId:"c",nodeId:"n",sessionId:"new"};
    await act(async()=>el.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(el.textContent).toContain("会话已更换");expect(dispatch).toHaveBeenCalledTimes(2);
    await act(async()=>dialogs.close());
    blocked=true;await render();await open();expect(dialogs.top()).toBeNull();
    blocked=false;owner=null;await render();await open();expect(dialogs.top()).toBeNull();
  } finally {await act(async()=>root.unmount());el.remove();}
});
