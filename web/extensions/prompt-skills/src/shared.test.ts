import { describe, expect, it } from "vitest";
import { cleanRewrittenPrompt, decodePromptSkillRewriteRequest, PROMPT_SKILLS_MAX_PROMPT_CHARS } from "./shared.js";

const valid = {
  requestId: "req-1",
  skillId: "polish",
  label: "画面细节润色",
  prompt: "雨夜街道",
  canvasId: "c1",
  nodeId: "n1",
  taskKind: "image-generation"
};

describe("decodePromptSkillRewriteRequest", () => {
  it("接受最小合法请求并保留技能身份", () => {
    const decoded = decodePromptSkillRewriteRequest(valid);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toMatchObject({ skillId: "polish", prompt: "雨夜街道", canvasId: "c1" });
  });

  it("拒绝空提示词与空请求身份", () => {
    expect(decodePromptSkillRewriteRequest({ ...valid, prompt: "   " })).toEqual({ ok: false, error: "请先输入提示词" });
    expect(decodePromptSkillRewriteRequest({ ...valid, requestId: "" })).toEqual({ ok: false, error: "requestId 必须是非空字符串" });
  });

  it("拒绝超过上限的草稿（给模板留出空间）", () => {
    const decoded = decodePromptSkillRewriteRequest({ ...valid, prompt: "a".repeat(PROMPT_SKILLS_MAX_PROMPT_CHARS + 1) });
    expect(decoded.ok).toBe(false);
  });

  it("含参考素材 token 的草稿明确拒绝（避免静默丢失参考绑定）", () => {
    const decoded = decodePromptSkillRewriteRequest({ ...valid, prompt: "{{input_image:slot-a:图片 1}} 雨夜街道" });
    expect(decoded).toEqual({
      ok: false,
      error: "草稿里包含参考素材标记，暂不支持一键改写；请先复制文字改写后再粘贴"
    });
  });

  it("模型不属于线上请求：多余 modelKey 被忽略，由插件配置决定", () => {
    const decoded = decodePromptSkillRewriteRequest({ ...valid, modelKey: "ghost:model" });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect("modelKey" in decoded.value).toBe(false);
  });
});

describe("cleanRewrittenPrompt", () => {
  it("去掉代码围栏与常见前缀", () => {
    const fenced = "\u0060\u0060\u0060text\n改写后：雨夜霓虹街道，湿漉漉的柏油路。\n\u0060\u0060\u0060";
    expect(cleanRewrittenPrompt(fenced)).toBe("雨夜霓虹街道，湿漉漉的柏油路。");
  });

  it("去掉包裹引号但保留正文引号", () => {
    expect(cleanRewrittenPrompt("“雨夜街道，霓虹灯反射在水面上。”")).toBe("雨夜街道，霓虹灯反射在水面上。");
    expect(cleanRewrittenPrompt("霓虹灯写着「营业中」")).toBe("霓虹灯写着「营业中」");
  });
});
