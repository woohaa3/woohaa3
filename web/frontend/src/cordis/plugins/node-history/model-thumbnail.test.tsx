/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ModelThumbnail } from "./model-thumbnail.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{vi.unstubAllGlobals();document.body.innerHTML="";});

const entry = (entryId: string) => ({ canvasId: "c", nodeId: "n", entryId });

it("shows safe failure cause, retries current version, releases preview URL", async()=>{
  const render=vi.fn()
    .mockResolvedValueOnce({ok:false,code:"thumbnail-readiness-timeout"})
    .mockResolvedValue({ok:true,blob:new Blob(["test response"],{type:"image/png"})});
  const create=vi.fn(()=>"blob:test"),revoke=vi.fn();
  vi.stubGlobal("URL",{createObjectURL:create,revokeObjectURL:revoke});
  const el=document.createElement("div");document.body.append(el);const root=createRoot(el);
  await act(async()=>{root.render(<ModelThumbnail entry={entry("e")} render={render} thumbnail />);});
  await act(async()=>{await Promise.resolve();});
  expect(el.textContent).toContain("预览渲染超时");expect(el.textContent).not.toContain("model-renderer");
  await act(async()=>el.querySelector("button")!.click());
  await act(async()=>{await Promise.resolve();});
  expect(render).toHaveBeenCalledTimes(2);expect(el.querySelector("img")?.src).toBe("blob:test");
  await act(async()=>root.unmount());expect(revoke).toHaveBeenCalledWith("blob:test");
});

it("old selection completion is ignored; no-source has explanation without retry",async()=>{
  let finish!:(value:unknown)=>void;
  const render=vi.fn()
    .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
    .mockResolvedValue({ok:false,code:"no-source"});
  const el=document.createElement("div");const root=createRoot(el);
  await act(async()=>{root.render(<ModelThumbnail entry={entry("a")} render={render} thumbnail />);});
  await act(async()=>{root.render(<ModelThumbnail entry={entry("b")} render={render} thumbnail />);});
  await act(async()=>{await Promise.resolve();});
  await act(async()=>{finish({ok:true,blob:new Blob(["old"],{type:"image/png"})});});
  await act(async()=>{await Promise.resolve();});
  expect(el.textContent).toContain("没有模型内容");expect(el.querySelector("button")).toBeNull();expect(el.querySelector("img")).toBeNull();
  await act(async()=>root.unmount());
});
