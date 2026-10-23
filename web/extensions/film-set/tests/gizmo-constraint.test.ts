import { describe, expect, it } from "vitest";
import type { GizmoYawConstraint } from "@woohaa3/contracts";
import { constrainedYawAngle, gizmoParentBasis, unwrapAngle } from "../src/authoring/browser/gizmo-constraint.js";
describe("local yaw geometry", () => {
  it("unwraps both pi boundaries continuously", () => {
    expect(unwrapAngle(-3.1-3.1)).toBeCloseTo(2*Math.PI-6.2);
    expect(unwrapAngle(3.1+3.1)).toBeCloseTo(6.2-2*Math.PI);
  });
  it("solves a nonorthogonal parent basis without baking the basis into yaw", () => {
    const c:GizmoYawConstraint={origin:[0,0,0],u:[2,0,0],v:[1,0,-3],normal:[0,1,0],
      mode:"plane",startAngle:0,direction:[0,0],radiansPerPixel:0};
    const angle=2.4, x=2*Math.cos(angle)+Math.sin(angle), z=-3*Math.sin(angle);
    expect(constrainedYawAngle(c,{origin:[x,5,z],direction:[0,-1,0]})).toBeCloseTo(angle);
    expect(constrainedYawAngle(c,{origin:[0,5,0],direction:[1,0,0]})).toBeNull();
    const parent=gizmoParentBasis([0,0,0.5,0.5,0,0,0,0.5,0],0,1);
    expect(parent).toEqual([0,2,0,0,0,2,2,0,0]);
  });
});
