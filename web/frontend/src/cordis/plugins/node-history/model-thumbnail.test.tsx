/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ModelThumbnail } from "./model-thumbnail.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{vi.unstubAllGlobals();document.body.innerHTML="";});
it("shows safe dependency cause, retries current version, releases preview URL", async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce({ok:false,json:async()=>({code:"renderer-start-failed",message:"secret host path"})})
    .mockResolvedValue({ok:true,blob:async()=>new Blob(["test response"],{type:"image/png"})});
  vi.stubGlobal("fetch",fetcher);
  const create=vi.fn(()=>"blob:test"),revoke=vi.fn();
  vi.stubGlobal("URL",{createObjectURL:create,revokeObjectURL:revoke});
  const el=document.createElement("div");document.body.append(el);const root=createRoot(el);
  await act(async()=>root.render(<ModelThumbnail href="/api/canvas-node-history/c/n/e/thumbnail" thumbnail />));
  expect(el.textContent).toContain("无法启动");expect(el.textContent).not.toContain("secret");
  await act(async()=>el.querySelector("button")!.click());
  expect(fetcher).toHaveBeenCalledTimes(2);expect(el.querySelector("img")?.src).toBe("blob:test");
  await act(async()=>root.unmount());expect(revoke).toHaveBeenCalledWith("blob:test");
});
it("old selection completion is ignored; no-source has explanation without retry",async()=>{
  let finish!:(value:unknown)=>void;
  const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
    .mockResolvedValue({ok:false,json:async()=>({code:"no-source"})});
  vi.stubGlobal("fetch",fetcher);
  const el=document.createElement("div");const root=createRoot(el);
  await act(async()=>root.render(<ModelThumbnail href="/api/canvas-node-history/c/n/a/thumbnail" thumbnail />));
  await act(async()=>root.render(<ModelThumbnail href="/api/canvas-node-history/c/n/b/thumbnail" thumbnail />));
  await act(async()=>finish({ok:true,blob:async()=>new Blob(["old"],{type:"image/png"})}));
  expect(el.textContent).toContain("没有模型内容");expect(el.querySelector("button")).toBeNull();expect(el.querySelector("img")).toBeNull();
  expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
  await act(async()=>root.unmount());
});
