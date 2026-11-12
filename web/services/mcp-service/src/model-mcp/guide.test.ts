import { expect, it } from "vitest";
import { buildModelApiGuideText } from "./guide.js";

it("keeps geometry guidance while hiding humanoid authoring", () => {
  const guide = buildModelApiGuideText();
  expect(guide).toContain("scene.segment");
  expect(guide).toContain("连接示例");
  for (const text of ["rig.joint", "人形骨架", "人形和机甲不要照搬"]) expect(guide).not.toContain(text);
});
