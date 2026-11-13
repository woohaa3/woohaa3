import { describe, expect, it } from "vitest";
import { toolResultDetail } from "./tool-detail.js";

describe("toolResultDetail", () => {
  it("优先结构化 code/message", () => {
    expect(toolResultDetail({
      isError: true,
      content: [{ type: "text", text: "原始文本" }],
      structuredContent: { ok: false, code: "not-ready", message: "模型 m1 的动画部件无法编译" }
    })).toBe("[not-ready] 模型 m1 的动画部件无法编译");
  });

  it("退回到协议错误、消息行与文本内容", () => {
    expect(toolResultDetail({ error: { message: "上游拒绝" } })).toBe("上游拒绝");
    expect(toolResultDetail({ content: [{ type: "text", text: "工具没有返回原因" }] })).toBe("工具没有返回原因");
    expect(toolResultDetail(JSON.stringify({ ok: false, message: "序列化回执" }))).toBe("序列化回执");
  });

  it("没有可读原因时返回 undefined，并截断超长文本", () => {
    expect(toolResultDetail({ isError: true })).toBeUndefined();
    expect(toolResultDetail("x".repeat(600))?.length).toBe(401);
  });
});
