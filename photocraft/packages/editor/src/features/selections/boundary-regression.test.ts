import { expect, it } from "vitest";
import { buildLasso, buildRectSelection, pointInSelection } from "./tool-parameters.js";
import { feature } from "./index.js";

it("keeps intersect selection parameters and holes after domain extraction", () => {
  expect(buildRectSelection({ x: 3, y: 4, width: 8, height: 6 }, { mode: "intersect" })).toMatchObject({ mode: "intersect", x: 3, y: 4 });
  expect(buildLasso([{ x: 0, y: 0 }, { x: 4, y: 0 }])).toBeNull();
  const boundary = [[0, 0, 10, 0], [10, 0, 10, 10], [10, 10, 0, 10], [0, 10, 0, 0], [3, 3, 7, 3], [7, 3, 7, 7], [7, 7, 3, 7], [3, 7, 3, 3]];
  expect(pointInSelection({ x: 1, y: 1 }, boundary)).toBe(true);
  expect(pointInSelection({ x: 5, y: 5 }, boundary)).toBe(false);
  expect(feature.sections.map(section => section.id)).toEqual(["selection", "colorRange", "refine"]);
});
