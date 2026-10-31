/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { ModelCamera } from "@woohaa3/contracts";
import { ModelEditorSession } from "@woohaa3/frontend/extension-api";
import { FilmSetCameraProperties } from "../src/authoring/browser/workspace-camera-properties.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });
function setup(disabled = false, azimuth = 0) {
  let cameras: ModelCamera[] = [{ id: "clip:a", name: "日光漫游", order: 0, azimuth, elevation: Math.PI / 4, distance: 6, aspect: "16:9" }];
  cameras.push({ ...cameras[0], id: "clip:b", name: "午后" });
  const writes: ModelCamera[][] = [];
  const session = new ModelEditorSession({ readCameras: () => cameras, isWritable: () => !disabled,
    submitCameras: (_id, value) => { writes.push([...value]); cameras = [...value]; return true; } });
  session.enter("film");
  const element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  act(() => root!.render(<FilmSetCameraProperties session={session} disabled={disabled} />));
  return { session, writes };
}
const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
function change(field: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("numeric composition previews locally then commits once on blur", () => {
  const h = setup(); const field = input("镜头方位");
  act(() => field.focus()); change(field, "25");
  expect(h.session.getState().posePreview?.azimuth).toBeCloseTo(25 * Math.PI / 180);
  expect(h.writes).toHaveLength(0);
  act(() => field.blur());
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0][0].azimuth).toBeCloseTo(25 * Math.PI / 180);
  expect(h.writes[0][0].distance).toBe(6);
  expect(h.writes[0][0].aspect).toBe("16:9");
});
it("Escape and invalid distance discard preview without submitting on blur", () => {
  const h = setup(); const azimuth = input("镜头方位");
  act(() => azimuth.focus()); change(azimuth, "90");
  act(() => azimuth.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(h.session.getState().posePreview).toBeNull();
  const distance = input("镜头距离"); act(() => distance.focus()); change(distance, "-1"); act(() => distance.blur());
  expect(h.writes).toHaveLength(0);
  expect(distance.value).toBe("6");
});
it("distance slider keeps its extent during drag and commits once on release", () => {
  const h = setup(); const slider = input("镜头距离滑杆");
  act(() => slider.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  change(slider, "40");
  expect(h.session.getState().posePreview?.distance).toBe(40);
  expect(slider.max).toBe("50");
  expect(h.writes).toHaveLength(0);
  act(() => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));
  act(() => slider.dispatchEvent(new Event("focusout", { bubbles: true })));
  expect(h.writes).toHaveLength(1); expect(h.writes[0][0].distance).toBe(40);
});
it("pointer cancellation and camera selection changes reject stale slider writes", () => {
  const h = setup(); const slider = input("镜头仰角滑杆");
  act(() => slider.dispatchEvent(new Event("pointerdown", { bubbles: true }))); change(slider, "20");
  act(() => slider.dispatchEvent(new Event("pointercancel", { bubbles: true })));
  expect(h.session.getState().posePreview).toBeNull(); expect(h.writes).toHaveLength(0);
  act(() => slider.dispatchEvent(new Event("pointerdown", { bubbles: true }))); change(slider, "30");
  act(() => h.session.selectCamera("clip:b"));
  act(() => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));
  expect(h.writes).toHaveLength(0);
});
it("focus fields preserve the camera pose and submit their own single edit", () => {
  const h = setup(); const y = input("注视点 Y");
  act(() => y.focus()); change(y, "1.6"); expect(h.writes).toHaveLength(0);
  expect(h.session.getState().focusPreview?.y).toBe(1.6);
  act(() => y.blur()); expect(h.writes).toHaveLength(1);
  expect(h.writes[0][0]).toMatchObject({ distance: 6, focusOffset: { x: 0, y: 1.6, z: 0 } });
});
it("read-only properties disable every editable control", () => {
  const h = setup(true);
  expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].every(element => element.disabled)).toBe(true);
  expect(h.writes).toHaveLength(0);
});
it("unwrapped camera azimuth remains editable without changing it merely by focusing", () => {
  const h = setup(false, Math.PI * 3); const field = input("镜头方位");
  expect(field.value).toBe("540"); act(() => field.focus()); act(() => field.blur());
  expect(h.writes).toHaveLength(0);
});
