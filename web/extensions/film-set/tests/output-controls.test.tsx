/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FilmSetHostContext } from "../src/state/browser/host-ports.js";
import { FilmSetVideoExportControl } from "../src/authoring/browser/film-set-video-export-control.js";
import { NativeVideoExportControl } from "../src/authoring/browser/native-video-export-control.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), cancel: vi.fn(), target: vi.fn(), submit: vi.fn(), wait: vi.fn(), nativeCancel: vi.fn() }));
vi.mock("../src/authoring/browser/film-set-video-capture.js", () => ({
  createFilmSetVideoExportSession: () => ({ run: mocks.run, cancel: mocks.cancel, busy: false }),
  videoExportTarget: mocks.target
}));
vi.mock("../src/authoring/browser/native-recording-client.js", () => ({
  createRecordingDriver: () => ({ submit: mocks.submit, wait: mocks.wait, cancel: mocks.nativeCancel }),
  recordingStageLabel: () => "后台录制中"
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });
function context() {
  let preview = false;
  const calls: string[] = [];
  const ctx = {
    get: () => undefined,
    canvasState: { getCanvas: () => ({ id: "canvas" }) }, canvasRemote: {},
    filmSetPlayback: {
      getSnapshot: () => ({ preview }),
      preview: () => { preview = true; calls.push("preview"); },
      pause: () => calls.push("pause")
    },
    canvasRuntime: { controller: () => ({ cancelTransientGesture: () => calls.push("cancel-gesture") }) },
    modelWorkspace: { session: { cancelPose: vi.fn(), cancelFocus: vi.fn() } }
  } as unknown as FilmSetHostContext;
  return { ctx, calls };
}
const exportButton = () => [...element.querySelectorAll("button")].find(button => button.textContent === "导出视频")!;

it("browser export enters the selected shot preview before freezing its output target and cancels on unmount", async () => {
  const { ctx, calls } = context();
  const target = { canvasId: "canvas", nodeId: "film", clipId: "shot-a", title: "片场 / A", duration: 5 };
  mocks.target.mockImplementation(() => { expect(ctx.filmSetPlayback.getSnapshot().preview).toBe(true); calls.push("freeze-shot"); return target; });
  mocks.run.mockResolvedValue({ ok: true });
  await act(async () => root.render(<FilmSetVideoExportControl ctx={ctx} disabled={false} onBusyChange={() => {}} />));
  await act(async () => exportButton().click());
  expect(calls).toEqual(["cancel-gesture", "preview", "freeze-shot", "pause"]);
  expect(mocks.run).toHaveBeenCalledWith(target, expect.any(Function));
  expect(element.textContent).toContain("片场 / A 视频已生成");
  act(() => root.render(null));
  expect(mocks.cancel).toHaveBeenCalledTimes(1);
});

it("browser visibility loss cancels the exclusive capture", async () => {
  const { ctx } = context();
  await act(async () => root.render(<FilmSetVideoExportControl ctx={ctx} disabled={false} onBusyChange={() => {}} />));
  const original = Object.getOwnPropertyDescriptor(document, "hidden");
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(mocks.cancel).toHaveBeenCalledTimes(1);
  if (original) Object.defineProperty(document, "hidden", original); else delete (document as unknown as { hidden?: boolean }).hidden;
});

it("native export prevents duplicate acceptance and ignores acceptance arriving after target unmount", async () => {
  const { ctx } = context();
  let accepted!: (value: unknown) => void;
  mocks.submit.mockImplementation(() => new Promise(resolve => { accepted = resolve; }));
  await act(async () => root.render(<NativeVideoExportControl ctx={ctx} disabled={false} target={{ nodeId: "film", clipId: "shot-a", title: "A" }} onBusyChange={() => {}} />));
  const button = exportButton();
  act(() => { button.click(); button.click(); });
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "film", clipId: "shot-a" }));
  act(() => root.render(null));
  await act(async () => accepted({ ok: true, submission: { jobId: "job-a" } }));
  expect(mocks.wait).not.toHaveBeenCalled();
  expect(mocks.nativeCancel).not.toHaveBeenCalled();
});

it("native target unmount stops observation while leaving its accepted background job running", async () => {
  const { ctx } = context();
  mocks.submit.mockResolvedValue({ ok: true, submission: { jobId: "job-a" } });
  mocks.wait.mockImplementation(() => new Promise(() => {}));
  const onBusyChange = vi.fn();
  await act(async () => root.render(<NativeVideoExportControl ctx={ctx} disabled={false} target={{ nodeId: "film", clipId: "shot-a", title: "A" }} onBusyChange={onBusyChange} />));
  await act(async () => exportButton().click());
  const observing = mocks.wait.mock.calls[0]![2] as () => boolean;
  expect(observing()).toBe(true);
  act(() => root.render(null));
  expect(observing()).toBe(false);
  expect(mocks.nativeCancel).not.toHaveBeenCalled();
});
