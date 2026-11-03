import { describe, expect, it } from "vitest";
import { buildRewriteInput, resolvePromptSkillTemplate } from "./prompts.js";

describe("buildRewriteInput", () => {
  it("技能指令同时进 system 与用户消息，草稿原文完整保留", () => {
    const input = buildRewriteInput({ skillId: "translate", prompt: "雨夜街道", taskKind: "image-generation" });
    expect(input.system).toContain("中文与英文之间做等价翻译");
    expect(input.system).toContain("图像生成");
    // 兼容忽略 system 的 Provider：用户消息里也要有任务与输出约束。
    expect(input.prompt).toContain("中文与英文之间做等价翻译");
    expect(input.prompt).toContain("只输出改写后的提示词正文");
    expect(input.prompt).toContain("雨夜街道");
  });

  it("视频任务给出视频上下文", () => {
    const input = buildRewriteInput({ skillId: "loop-frame", prompt: "海浪", taskKind: "video-generation" });
    expect(input.system).toContain("视频生成");
  });

  it("未知技能回落到通用润色而不是抛错", () => {
    expect(resolvePromptSkillTemplate("not-a-skill").instruction).toBe(resolvePromptSkillTemplate("universal-polish").instruction);
  });
});
