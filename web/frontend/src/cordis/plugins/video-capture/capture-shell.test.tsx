/** @vitest-environment jsdom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCaptureSession, type CaptureSession, type CaptureSessionOptions } from "./capture-shell.js";
import type { FrameCaptureSource } from "./capture-source.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let session: CaptureSession;
const revoke = vi.fn();
const createUrl = vi.fn(() => "blob:frame");
function source(overrides: Partial<FrameCaptureSource> = {}): FrameCaptureSource {
  return { state: () => ({ duration: 4, currentTime: 1, playing: false, muted: false, ready: true, width: 640, height: 360 }),
    subscribe: () => () => {}, play: async () => {}, pause: vi.fn(), seek: async () => {}, setMuted: () => {},
    capture: async () => new Blob(["png"], { type: "image/png" }), ...overrides };
}
function Probe(props: CaptureSessionOptions) { session = useCaptureSession(props); return <div>{session.frames.length}:{session.busy}:{session.error}</div>; }
async function mount(props: Partial<CaptureSessionOptions> = {}) {
  const element = document.createElement("div"); document.body.append(element);
  root = createRoot(element);
  const options = { source: source(), instanceId: "instance", targetNodeId: "node", onAddFrames: vi.fn(async () => []), ...props };
  const render = async (next = options) => { await act(async () => root!.render(<StrictMode><Probe {...next} /></StrictMode>)); };
  await render();
  return { options, render, element };
}
beforeEach(() => { createUrl.mockClear(); revoke.mockClear(); Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke }); });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });
it("StrictMode replay captures first/current/last and releases previews once", async () => {
  const { element } = await mount();
  for (const kind of ["first", "current", "last"] as const) await act(async () => session.captureFrame(kind));
  expect(session.frames.map(f => f.timeSeconds)).toEqual([0, 1, 3.95]);
  expect(element.textContent).toBe("3::");
  act(() => root!.unmount()); root = undefined;
  expect(revoke).toHaveBeenCalledTimes(3);
});
it("old capture completion cannot clear new busy state or append a frame", async () => {
  let finish!: (blob: Blob) => void;
  const old = source({ capture: () => new Promise(resolve => { finish = resolve; }) });
  const { options, render } = await mount({ source: old });
  let first!: Promise<void>; await act(async () => { first = session.captureFrame("current"); });
  let finishNew!: (blob: Blob) => void;
  await render({ ...options, targetNodeId: "new", source: source({ capture: () => new Promise(resolve => { finishNew = resolve; }) }) });
  let second!: Promise<void>; await act(async () => { second = session.captureFrame("first"); });
  await act(async () => { finish(new Blob(["old"])); await first; });
  expect(session.busy).toBe("first"); expect(session.frames).toHaveLength(0);
  await act(async () => { finishNew(new Blob(["new"])); await second; });
  expect(session.frames).toHaveLength(1); expect(session.busy).toBeNull();
});
it("partial add removes successes, retries only failures, and reports capture failure", async () => {
  const capture = vi.fn().mockRejectedValueOnce(new Error("decode failed")).mockResolvedValue(new Blob(["png"]));
  const add = vi.fn(async ({ frames }: Parameters<CaptureSessionOptions["onAddFrames"]>[0]) => frames.map((f, i) => ({ frameId: f.id, timeSeconds: f.timeSeconds, ok: i === 0 })));
  await mount({ source: source({ capture }), onAddFrames: add });
  await act(async () => session.captureFrame("first"));
  expect(session.error).toBeTruthy(); expect(session.busy).toBeNull();
  await act(async () => session.captureFrame("first")); await act(async () => session.captureFrame("last"));
  await act(async () => session.addAll());
  expect(session.frames).toHaveLength(1); expect(session.pendingFrameIds).toEqual([session.frames[0]!.id]);
  await act(async () => session.retryFailed());
  expect(add.mock.calls[1]![0].frames).toHaveLength(1); expect(session.frames).toHaveLength(0);
});
it("decoder timeout releases busy and preserves existing frames for retry", async () => {
  vi.useFakeTimers();
  try {
    const capture=vi.fn().mockResolvedValueOnce(new Blob(["first"])).mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue(new Blob(["retry"]));
    await mount({source:source({capture})});
    await act(async()=>session.captureFrame("first"));
    let pending!:Promise<void>;
    await act(async()=>{pending=session.captureFrame("last");});
    await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);await pending;});
    expect(session.error).toContain("超时");expect(session.busy).toBeNull();expect(session.frames).toHaveLength(1);
    await act(async()=>session.captureFrame("last"));expect(session.frames).toHaveLength(2);
  } finally {vi.useRealTimers();}
});
