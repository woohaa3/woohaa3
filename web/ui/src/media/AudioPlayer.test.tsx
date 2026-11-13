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
it("seeks on the waveform, clamps the position and changes the actual media mute state", () => {
  const audio = render("/seek.wav"); ready(audio);
  const wave = host.querySelector<HTMLElement>(".ui-audio-player__wave")!;
  wave.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect;
  act(() => wave.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 150 })));
  expect(audio.currentTime).toBe(3);
  expect(host.querySelector(".ui-audio-player__elapsed")!.textContent).toBe("0:03");
  act(() => wave.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 500 })));
  expect(audio.currentTime).toBe(12);
  act(() => host.querySelector<HTMLButtonElement>(".ui-audio-player__volume")!.click());
  expect(audio.muted).toBe(true);
  render("/other.wav");
  expect(host.querySelector("audio")!.muted).toBe(false);
});

it("uses an icon-only play control and keeps the seek bar synchronized with playback", () => {
  const audio = render("/progress.wav"); ready(audio);
  const play = host.querySelector<HTMLButtonElement>(".ui-audio-player__play")!;
  expect(play.textContent).toBe(""); expect(play.title).toBe("播放");
  const seek = host.querySelector<HTMLInputElement>(".ui-audio-player__seek")!;
  expect(seek.disabled).toBe(false); expect(seek.max).toBe("12");
  act(() => { audio.currentTime = 6; audio.dispatchEvent(new Event("timeupdate")); });
  expect(seek.value).toBe("6"); expect(seek.style.getPropertyValue("--audio-progress")).toBe("50%");
  act(() => { seek.value = "9"; seek.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(audio.currentTime).toBe(9);
  expect(host.querySelector(".ui-audio-player__elapsed")!.textContent).toBe("0:09");
  render("/next.wav"); expect(seek.disabled).toBe(true); expect(seek.value).toBe("0");
});
