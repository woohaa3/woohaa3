/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { resolveAudioPreview } from "./media-preview.js";
import { AudioPlayer } from "../../../shared/ui/AudioPlayer.js";

(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML=""; });
it("only canonical ready own output is allowed; input, external, wrong kind and missing target are rejected", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-19T00:00:00Z");
  canvas.document.nodes.push({id:"audio",type:"audio",position:{x:0,y:0}});
  canvas.nodeData.audio = {title:"音频",outputAssetId:"asset"};
  canvas.assets.push({id:"asset",title:"test.wav",mediaKind:"audio",status:"ready",source:"uploaded",createdAt:"2026-10-19T00:00:00Z",url:"/api/media/test.wav"});
  expect(resolveAudioPreview(canvas,"audio")).toMatchObject({assetId:"asset",url:"/api/media/test.wav?canvas=canvas"});
  expect(resolveAudioPreview(canvas,"audio","other")).toBeNull();
  expect(resolveAudioPreview(canvas,"missing")).toBeNull();
  canvas.assets[0]!.url="https://outside.example/a.wav";
  expect(resolveAudioPreview(canvas,"audio")).toBeNull();
  canvas.assets[0]!.url="/api/media/test.wav"; canvas.assets[0]!.status="generating";
  expect(resolveAudioPreview(canvas,"audio")).toBeNull();
  canvas.assets[0]!.status="ready"; canvas.assets[0]!.mediaKind="video";
  expect(resolveAudioPreview(canvas,"audio")).toBeNull();
});
it("does not autoplay; exposes timing, play rejection, pause, retry and releases old media on source change", async () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype,"play").mockRejectedValueOnce(new Error("denied")).mockResolvedValue();
  const el=document.createElement("div");document.body.append(el);const root=createRoot(el);
  try {
    await act(async () => root.render(<AudioPlayer url="/api/media/a.wav" />));
    const audio=el.querySelector("audio")!;
    expect(play).not.toHaveBeenCalled();expect(audio.autoplay).toBe(false);
    Object.defineProperty(audio,"duration",{value:4});audio.currentTime=2;
    await act(async () => {audio.dispatchEvent(new Event("loadedmetadata"));audio.dispatchEvent(new Event("timeupdate"));});
    expect(el.textContent).toContain("0:02 / 0:04");
    await act(async () => el.querySelector("button")!.click());
    expect(el.textContent).toContain("声音权限");
    await act(async () => el.querySelector("button")!.click());
    expect(play).toHaveBeenCalledTimes(2);
    Object.defineProperty(audio,"paused",{value:false});
    await act(async () => {audio.dispatchEvent(new Event("play"));});
    expect(el.querySelector("button")!.textContent).toBe("暂停");
    await act(async () => el.querySelector("button")!.click());expect(pause).toHaveBeenCalled();
    await act(async () => audio.dispatchEvent(new Event("error")));
    expect(el.textContent).toContain("无法读取或解码");
    await act(async () => [...el.querySelectorAll("button")].find(button=>button.textContent==="重试")!.click());
    expect(el.querySelector("audio")).not.toBe(audio);
    await act(async () => root.render(<AudioPlayer url="/api/media/b.wav" />));
    await act(async () => audio.dispatchEvent(new Event("timeupdate")));
    expect(el.textContent).toContain("0:00 / 0:00");
  } finally { await act(async () => root.unmount()); }
});
