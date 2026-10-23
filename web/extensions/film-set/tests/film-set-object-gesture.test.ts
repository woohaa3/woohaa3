import { describe, expect, it } from "vitest";
import { createModelSnapshot, type GizmoYawConstraint, type FilmSetContent } from "@woohaa3/contracts";
import { FilmSetObjectSession } from "../src/authoring/browser/object-session.js";
import { createFilmSetObjectGesture } from "../src/authoring/browser/film-set-object-gesture.js";

function fixture(handle: "x" | "y" | "z" | "center" | "scale" | "yaw-ring", yaw = 0, worldToLocal?: number[], yawConstraint?: GizmoYawConstraint) {
  const content: FilmSetContent = { schemaVersion: 4, items: ["a", "b"].map(id => ({
    id, kind: "model", name: id,
    localTransform: { offset: { x: -1.25, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" })
  })) };
  const submitted: unknown[] = [];
  const session = new FilmSetObjectSession({ readContent: () => content, isWritable: () => true, submitItemOp: op => { submitted.push(op); return true; } });
  session.enter("film"); session.select("a");
  if (handle === "scale" || handle === "yaw-ring") session.setTool(handle === "scale" ? "scale" : "yaw");
  let camera = { target: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, distance: 20, flySpeed: 6 };
  const { handler } = createFilmSetObjectGesture({
    session, projection: () => camera, surface: () => ({ width: 800, height: 600 }),
    compositionBasis: () => ({ unit: 4, yaw, worldToLocal, center: [0, 0, 0] }),
    pick: () => "a", hitObjectGizmo: () => ({ handle, direction: [1, 0], worldPerPixel: handle === "scale" ? 1 / 128 : 2, yawConstraint }),
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
  it("center drag has no initial jump and external camera changes cancel it", () => {
    const h = fixture("center");
    const start = { x: 470, y: 325 };
    h.handler.begin(start, false); h.handler.move(start);
    expect(h.session.getState().preview!.offset).toEqual({ x: -1.25, y: 0, z: 0 });
    h.handler.move({ x: 490, y: 325 });
    expect(h.session.getState().preview!.offset.x).not.toBe(-1.25);
    h.changeCamera(); h.handler.move({ x: 500, y: 325 });
    expect(h.session.getState().preview).toBeNull();
    h.handler.end(); expect(h.submitted).toHaveLength(0);
  });
  it("switching selection invalidates the old gesture", () => {
    const h = fixture("x"); h.handler.begin({ x: 400, y: 300 }, false);
    h.session.select("b"); h.handler.move({ x: 450, y: 300 }); h.handler.end();
    expect(h.submitted).toHaveLength(0); expect(h.session.getState().preview).toBeNull();
  });
});


describe("explicit constrained tools", () => {
  it("uniform scale uses the frozen base and rejects nonfinite ratios", () => {
    const h=fixture("scale");
    expect(h.handler.begin({x:0,y:0},true)).toBe(true);
    h.handler.move({x:128*Math.log(2),y:0});
    expect(h.session.getState().preview!.scale).toBeCloseTo(2);
    expect(h.session.dragReadout()).toContain("2.00");
    h.handler.move({x:1e9,y:0});
    expect(h.session.getState().preview!.scale).toBeCloseTo(2);
    h.handler.move({x:-1e9,y:0});
    expect(h.session.getState().preview!.scale).toBeCloseTo(2);
    h.handler.end();h.handler.end();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({op:{localTransform:{scale:2,yaw:0,offset:{x:-1.25,y:0,z:0}}}});
  });
  it("edge-on yaw locks its tangent and tool changes cancel preview", () => {
    const constraint:GizmoYawConstraint={origin:[0,0,0],u:[1,0,0],v:[0,0,-1],normal:[0,1,0],
      mode:"tangent",startAngle:0,direction:[1,0],radiansPerPixel:0.01};
    const h=fixture("yaw-ring",0,undefined,constraint);
    expect(h.handler.begin({x:0,y:0},true)).toBe(true);
    h.handler.move({x:400,y:0});
    expect(h.session.getState().preview!.yaw).toBeCloseTo(4);
    expect(h.session.getState().preview!.scale).toBe(1);
    h.session.setTool("move");h.handler.move({x:420,y:0});h.handler.end();
    expect(h.session.getState().feedback.active).toBeUndefined();
    expect(h.submitted).toHaveLength(0);
  });
  it("hover never replaces active and cancel/no net change never submit", () => {
    const h=fixture("scale");
    h.handler.hover?.({x:0,y:0});expect(h.session.getState().feedback.hover).toBe("scale");
    h.handler.begin({x:0,y:0},false);h.handler.hover?.(null);
    expect(h.session.getState().feedback.active).toBe("scale");
    h.handler.move({x:0,y:0});h.handler.end();expect(h.submitted).toHaveLength(0);
    h.handler.begin({x:0,y:0},false);h.handler.move({x:20,y:0});h.handler.cancel();
    expect(h.session.getState().preview).toBeNull();expect(h.submitted).toHaveLength(0);
  });
});
