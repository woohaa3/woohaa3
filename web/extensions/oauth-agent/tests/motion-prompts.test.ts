import { describe, expect, it } from "vitest";
import { buildPrompt, buildToolsPrompt } from "../src/backend/generation/prompts.js";
import { executeMotionScript, PARKOUR_MOTION_SCRIPT } from "@woohaa3/contracts";

const input = { ownerId: "o", requestId: "r", canvasId: "c", nodeId: "film", mode: "film-set" as const, model: "m", prompt: "人物沿屋顶跑酷" };
const read = { ok: true as const, nodeType: "composite-asset", title: "片场", prompt: "", references: [], cameras: [] };

describe("人物运动生成指引", () => {
  for (const [name, build] of [["structured", buildPrompt], ["tools", buildToolsPrompt]] as const) {
    it(`${name} 模式告知连续动作能力及禁止复制人物`, () => {
      const text = build(input, read);
      expect(text).toContain("motion.model.keyframes");
      expect(text).toContain("motion.model.tween");
      expect(text).toContain("严禁按时间复制人物");
      expect(text).toContain("同一目标同一属性");
      expect(text).toContain("结束后保持终值");
      expect(text).toContain("mutate_film_set_item");
      const result = executeMotionScript(PARKOUR_MOTION_SCRIPT, { duration: 8, partIds: new Set(["root"]) });
      expect(result.ok).toBe(true);
    });
  }
});
