import { describe, expect, it } from "vitest";
import { buildModelApiGuideText } from "./guide.js";

describe("model api guide", () => {
  it("告诉人形脚本使用关节局部坐标，而不是整个人的站立高度", () => {
    const text = buildModelApiGuideText();
    expect(text).toContain("是该关节的局部坐标，不是整个人的站立高度");
    expect(text).toContain('from: [0, 0, 0]，to: [0, -0.4, 0]');
    expect(text).toContain('from: [0, -0.5, 0], to: [0, 0, 0]');
    expect(text).toContain("不要只在 Hips 和 Spine 原点各放一个小盒子");
    expect(text).toContain("人形和机甲不要照搬这些绝对高度");
  });
});

it("新建机甲使用完整SOMA模板，旧骨架仅用于兼容编辑",()=>{
 const text=buildModelApiGuideText();
 expect(text).toContain('scene.somaHumanoid');
 expect(text).toContain('不要改为14关节');
 expect(text).toContain('旧版14关节模型兼容');
});
