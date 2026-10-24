/** @vitest-environment jsdom */
import {expect,it} from "vitest";
import {installDocumentUnloadGuard} from "../src/document-unload.js";
import {pendingDraftOf} from "../src/document-session.js";
import type {EditorWorkspaceController} from "../src/editor-workspace.js";
it("beforeunload reads current unsettled/draft state synchronously and unregisters on disposal",()=>{
 let unsettled=false,draft=false,rotation=false;const target=new EventTarget(),controller={hasStroke:()=>draft,hasImageRotation:()=>rotation,hasTransform:()=>false} as unknown as EditorWorkspaceController;
 const dispose=installDocumentUnloadGuard(target,()=>unsettled||!!pendingDraftOf(controller));const send=()=>{const event=new Event("beforeunload",{cancelable:true});target.dispatchEvent(event);return event;};
 expect(send().defaultPrevented).toBe(false);unsettled=true;expect(send().defaultPrevented).toBe(true);unsettled=false;draft=true;expect(pendingDraftOf(controller)).toBe("请先结束当前笔迹");expect(send().defaultPrevented).toBe(true);draft=false;rotation=true;expect(pendingDraftOf(controller)).toBe("请先确认或取消图像旋转");expect(send().defaultPrevented).toBe(true);rotation=false;expect(send().defaultPrevented).toBe(false);dispose();unsettled=true;expect(send().defaultPrevented).toBe(false);
});
