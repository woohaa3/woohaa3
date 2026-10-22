import { describe, expect, it } from "vitest";
import { createModelSnapshot, type FilmSetContent } from "@woohaa3/contracts";
import { FilmSetObjectSession } from "../src/authoring/browser/object-session.js";
import { createFilmSetObjectGesture } from "../src/authoring/browser/film-set-object-gesture.js";

function fixture(handle: "x" | "y" | "z" | "center", yaw = 0, worldToLocal?: number[]) {
  const content: FilmSetContent = { schemaVersion: 3, items: ["a", "b"].map(id => ({
    id, kind: "model", name: id,
    localTransform: { offset: { x: -1.25, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" })
  })) };
  const submitted: unknown[] = [];
  const session = new FilmSetObjectSession({ readContent: () => content, isWritable: () => true, submitItemOp: op => { submitted.push(op); return true; } });
  session.enter("film"); session.select("a");
  let camera = { target: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, distance: 20, flySpeed: 6 };
  const { handler } = createFilmSetObjectGesture({
    session, projection: () => camera, surface: () => ({ width: 800, height: 600 }),
    compositionBasis: () => ({ unit: 4, yaw, worldToLocal, center: [0, 0, 0] }),
    pick: () => "a", hitObjectGizmo: () => ({ handle, direction: [1, 0], worldPerPixel: 2 }),
    nodeId: () => "film", blocked: () => false
  });
  return { session, handler, submitted, changeCamera: () => { camera = { ...camera, yaw: 2, distance: 200 }; } };
}

describe("object drag", () => {
  it("selection is active immediately on entering the workspace", () => {
    const h = fixture("x"); h.session.select(null);
    expect(h.handler.active()).toBe(true);
    expect(h.handler.select({ x: 10, y: 10 })).toBe(true);
    expect(h.session.getState().selectedItemId).toBe("a");
    h.session.exit(); expect(h.handler.active()).toBe(false);
  });
  it("media drags use the frozen inverse coordinate basis", () => {
    const h = fixture("x", 0, [0, 0, 0.5, 0.5, 0, 0, 0, 0.5, 0]);
    h.handler.begin({ x: 400, y: 300 }, false); h.handler.move({ x: 410, y: 300 });
    expect(h.session.getState().preview!.offset).toEqual({ x: -1.25, y: 0, z: 10 });
    h.handler.end(); expect(h.submitted).toHaveLength(1);
  });
  it.each(["x", "y", "z"] as const)("converts %s world displacement using the frozen root scale", axis => {
    const h = fixture(axis);
    expect(h.handler.begin({ x: 400, y: 300 }, false)).toBe(true);
    h.handler.move({ x: 410, y: 300 });
    expect(h.session.getState().preview!.offset[axis]).toBe(axis === "x" ? 3.75 : 5);
    expect(h.submitted).toHaveLength(0);
    h.handler.end();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({ itemId: "a", op: { expectedLocalTransform: { offset: { x: -1.25, y: 0, z: 0 } } } });
  });
  it("inverts placement yaw without applying the observer's isometric rotation", () => {
    const h = fixture("x", Math.PI / 2);
    h.handler.begin({ x: 400, y: 300 }, false); h.handler.move({ x: 410, y: 300 });
    expect(h.session.getState().preview!.offset.x).toBeCloseTo(-1.25);
    expect(h.session.getState().preview!.offset.z).toBeCloseTo(5);
  });
  it("center drag has no initial jump and freezes the camera", () => {
    const h = fixture("center");
    const start = { x: 470, y: 325 };
    h.handler.begin(start, false); h.changeCamera(); h.handler.move(start);
    expect(h.session.getState().preview!.offset).toEqual({ x: -1.25, y: 0, z: 0 });
    h.handler.move({ x: 490, y: 325 });
    expect(h.session.getState().preview!.offset.x).not.toBe(-1.25);
    h.handler.cancel(); expect(h.submitted).toHaveLength(0);
  });
  it("switching selection invalidates the old gesture", () => {
    const h = fixture("x"); h.handler.begin({ x: 400, y: 300 }, false);
    h.session.select("b"); h.handler.move({ x: 450, y: 300 }); h.handler.end();
    expect(h.submitted).toHaveLength(0); expect(h.session.getState().preview).toBeNull();
  });
});
