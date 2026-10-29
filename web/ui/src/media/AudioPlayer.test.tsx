/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudioPlayer } from "./AudioPlayer.js";
let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {}); vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
function render(url: string) { act(() => root.render(<AudioPlayer url={url} />)); return host.querySelector("audio")!; }
function ready(audio: HTMLAudioElement) { Object.defineProperty(audio, "duration", { configurable: true, value: 12 }); act(() => audio.dispatchEvent(new Event("loadedmetadata"))); }
it("reports media/decode failure and retries only the current source", () => {
  const first = render("/first.wav"); act(() => first.dispatchEvent(new Event("error")));
  expect(host.textContent).toContain("音频无法读取");
  act(() => [...host.querySelectorAll("button")].find(b => b.textContent === "重试")!.click());
  const retry = host.querySelector("audio")!; expect(retry).not.toBe(first); expect(retry.getAttribute("src")).toBe("/first.wav");
  ready(retry); expect(host.textContent).toContain("0:12"); expect(host.textContent).not.toContain("音频无法读取");
});
it("isolates rejected play promises and old events after source change/unmount", async () => {
  let reject!: (cause: Error) => void;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockRejectedValueOnce(new Error("permission"));
  const first = render("/old.wav"); ready(first);
  act(() => host.querySelector("button")!.click());
  const current = render("/current.wav");
  await act(async () => reject(new Error("late")));
  act(() => first.dispatchEvent(new Event("error")));
  expect(host.textContent).not.toContain("播放未能开始"); expect(host.textContent).not.toContain("无法读取");
  ready(current); await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("播放未能开始");
  act(() => root.render(null)); expect(current.getAttribute("src")).toBe(null);
  act(() => current.dispatchEvent(new Event("error"))); expect(host.textContent).toBe("");
});
