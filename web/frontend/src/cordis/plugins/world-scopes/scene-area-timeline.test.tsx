// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { CanvasRuntimeService } from "../../contract/canvas-runtime.js";
import { WorldAnimationTransport } from "../canvas-runtime/world-animation-transport.js";
import { installSceneAreaPlayback, SceneAreaProgress, trackFraction } from "./scene-area-progress.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const canvas = document.createElement("canvas"); document.body.append(canvas);
  const captured = new Set<number>();
  canvas.setPointerCapture = id => { captured.add(id); };
  canvas.hasPointerCapture = id => captured.has(id);
  canvas.releasePointerCapture = id => { captured.delete(id); };
  const transport = new WorldAnimationTransport(() => {}, { now: () => 0, request: () => 1, cancel: () => {} });
  const areas = ["a", "b"].map(nodeId => ({ nodeId, key: "v1", duration: 4, loop: false }));
  transport.sync("timeline", areas, "a");
  let control = "play", nodeId = "b", accepted = true;
  const queryPoint = vi.fn(() => accepted ? { ok: true, generation: 3, value: {
    kind: "scene-area-playback", nodeId, control, track: [10, 90, 90, 10]
  } } : { ok: false, reason: "stale" });
  const runtime = {
    runtime: () => ({ interactionGeneration: () => 3, queryPoint }),
    clientToWorld: (point: {x:number;y:number}) => point,
    worldToClient: (point: {x:number;y:number}) => ({x:point.x * 2,y:point.y * 2}),
    cancelTransientGesture: vi.fn(),
    worldAnimationState: transport.snapshot,
    playWorldAnimation: transport.play, pauseWorldAnimation: transport.pause,
    seekWorldAnimation: transport.seek, setWorldAnimationLoop: transport.setLoop,
    controller: () => ({ selectNode: (id: string) => { transport.sync("timeline", areas, id); return true; } })
  } as unknown as CanvasRuntimeService;
  const dispose = installSceneAreaPlayback(runtime, canvas); cleanups.push(dispose, () => transport.dispose());
  return { canvas, transport, runtime, queryPoint, dispose,
    target: (next: string, id = "b") => { control = next; nodeId = id; }, stale: () => { accepted = false; } };
}
function pointer(canvas: HTMLCanvasElement, type: string, x = 50, y = 50, id = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: id }); canvas.dispatchEvent(event); return event;
}
it("selects and toggles playback from native hits, with no competing canvas gesture", () => {
  const f = fixture(), downstream = vi.fn(); f.canvas.addEventListener("pointerdown", downstream);
  expect(pointer(f.canvas, "pointerdown").defaultPrevented).toBe(true);
  expect(f.transport.snapshot()).toMatchObject({nodeId:"b", playing:true});
  expect(downstream).not.toHaveBeenCalled();
  pointer(f.canvas, "pointerdown"); expect(f.transport.snapshot().playing).toBe(false);
  expect(f.queryPoint).toHaveBeenCalledWith({generation:3,x:50,y:50,zoom:2});
  f.target("loop"); pointer(f.canvas,"pointerdown"); expect(f.transport.snapshot().loop).toBe(true);
});
it("scrubs along the native rotated track and resumes at the release coordinate", () => {
  const f=fixture(); f.target("track","a"); f.transport.play();
  pointer(f.canvas,"pointerdown",30,70); expect(f.transport.snapshot()).toMatchObject({time:1,playing:false});
  pointer(f.canvas,"pointermove",50,50); expect(f.transport.snapshot().time).toBe(2);
  pointer(f.canvas,"pointerup",70,30); expect(f.transport.snapshot()).toMatchObject({time:3,playing:true});
  expect(f.canvas.hasPointerCapture(1)).toBe(false);
});
it("cancel restores the initial playhead and ignores other pointers", () => {
  const f=fixture(); f.target("track","a"); f.transport.seek(1);
  pointer(f.canvas,"pointerdown"); pointer(f.canvas,"pointermove",90,10,2);
  expect(f.transport.snapshot().time).toBe(2);
  pointer(f.canvas,"pointercancel"); expect(f.transport.snapshot().time).toBe(1);
});
it("never seeks or resumes a different area after selection changes during a scrub", () => {
  const f=fixture(); f.target("track","a"); f.transport.play(); pointer(f.canvas,"pointerdown");
  f.runtime.controller()!.selectNode("b"); pointer(f.canvas,"pointerup",90,10);
  expect(f.transport.snapshot()).toMatchObject({nodeId:"b",time:0,playing:false});
});
it("does not resume at the end unless loop is enabled", () => {
  const f=fixture(); f.target("track","a"); f.transport.play(); pointer(f.canvas,"pointerdown");
  pointer(f.canvas,"pointerup",90,10); expect(f.transport.snapshot()).toMatchObject({time:4,playing:false});
});
it("passes stale hits through and removes input ownership on cleanup", () => {
  const f=fixture(); f.stale(); expect(pointer(f.canvas,"pointerdown").defaultPrevented).toBe(false);
  f.dispose(); const count=f.queryPoint.mock.calls.length; pointer(f.canvas,"pointerdown");
  expect(f.queryPoint.mock.calls).toHaveLength(count);
});
it("clamps track projection without inventing a DOM rectangle", () => {
  expect(trackFraction({x:50,y:50},[10,90,90,10])).toBe(0.5);
  expect(trackFraction({x:100,y:0},[10,90,90,10])).toBe(1);
  expect(trackFraction({x:0,y:100},[10,90,90,10])).toBe(0);
});
it("renders no DOM player and binds a canvas mounted later", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const f=fixture(); f.dispose(); f.canvas.remove();
  const host=document.createElement("div"); document.body.append(host); const root=createRoot(host);
  await act(async () => { root.render(<SceneAreaProgress runtime={f.runtime}/>); });
  expect(host.childElementCount).toBe(0);
  f.canvas.id="bevy-canvas";
  await act(async () => { document.body.append(f.canvas); });
  pointer(f.canvas,"pointerdown"); expect(f.transport.snapshot().playing).toBe(true);
  await act(async () => root.unmount());
});
