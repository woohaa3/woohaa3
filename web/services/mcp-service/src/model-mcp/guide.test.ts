import { expect, it } from "vitest";
import { buildModelApiGuideText } from "./guide.js";

it("keeps geometry guidance while hiding humanoid authoring", () => {
  const guide = buildModelApiGuideText();
  expect(guide).toContain("scene.segment");
  expect(guide).toContain("连接示例");
  for (const text of ["rig.joint", "人形骨架", "人形和机甲不要照搬"]) expect(guide).not.toContain(text);
});

it("新建机甲使用完整SOMA模板，旧骨架创作入口暂停",()=>{
 const text=buildModelApiGuideText();
 expect(text).toContain('scene.somaHumanoid');
 expect(text).toContain('不要改为14关节');
 expect(text).not.toContain('旧版14关节模型兼容');
});
