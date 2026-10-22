/**
 * 作品名称解析测试（change: 2026-10-09-improve-canvas-workflow，任务 2.1）。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_NODE_DISPLAY_NAME_LENGTH,
  contentTypeLabelForNode,
  promptSummary,
  resolveNodeDisplayName,
  validateExplicitName
} from "./node-display-name.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
describe("resolveNodeDisplayName 优先级", () => {
  it("显式名称优先于已提交提示词摘要", () => {
    const name = resolveNodeDisplayName({ type: "image", explicitName: "海边日落", prompt: "一张很长的提示词" });
    expect(name.displayName).toBe("海边日落");
    expect(name.contentTypeLabel).toBe("图片");
    expect(name.nameSource).toBe("explicit");
  });

  it("无显式名称时使用已提交提示词摘要", () => {
    const name = resolveNodeDisplayName({ type: "video", prompt: "开场镜头：晨雾中的城市天际线，缓慢推近" });
    expect(name.displayName).toBe("开场镜头：晨雾中的城市天际线，缓慢推近");
    expect(name.nameSource).toBe("prompt-summary");
  });

  it("无显式名称与提示词时使用中文默认名", () => {
    expect(resolveNodeDisplayName({ type: "audio" }).displayName).toBe("未命名音频");
    expect(resolveNodeDisplayName({ type: "group" }).displayName).toBe("未命名分组");
    expect(resolveNodeDisplayName({ type: "model3d" }).displayName).toBe("未命名模型");
    expect(resolveNodeDisplayName({ type: "unknown-type" }).displayName).toBe("未命名作品");
    expect(resolveNodeDisplayName({}).nameSource).toBe("default");
  });

  it("不读取未提交草稿：只接受显式传入的已提交字段", () => {
    const name = resolveNodeDisplayName({ type: "image", explicitName: "  ", prompt: undefined });
    expect(name.displayName).toBe("未命名图片");
    expect(name.nameSource).toBe("default");
  });
});

describe("promptSummary 有界可读摘要", () => {
  it("合并换行与多余空白", () => {
    expect(promptSummary("第一行\n\n  第二行   第三行")).toBe("第一行 第二行 第三行");
  });

  it("按 Unicode 字符截断到 32 字", () => {
    const long = "这".repeat(50);
    expect([...promptSummary(long)!].length).toBe(32);
  });

  it("mention token 转成可读标签而不是内部 ID", () => {
    const summary = promptSummary("参考 {{input_image:slot-abc:图片 1}} 生成");
    expect(summary).toBe("参考 @图片 1 生成");
    expect(summary).not.toContain("slot-abc");
  });

  it("空提示词返回 null", () => {
    expect(promptSummary("   \n  ")).toBeNull();
    expect(promptSummary(undefined)).toBeNull();
  });
});

describe("validateExplicitName 边界", () => {
  it("去首尾空白", () => {
    expect(validateExplicitName("  夏季新品主图  ")).toEqual({ ok: true, value: "夏季新品主图" });
  });

  it("拒绝纯空白与超长", () => {
    expect(validateExplicitName("   ")).toEqual({ ok: false, message: "名称不能为空" });
    expect(validateExplicitName("字".repeat(MAX_NODE_DISPLAY_NAME_LENGTH + 1)).ok).toBe(false);
  });

  it("恰好 120 字通过，121 字拒绝", () => {
    expect(validateExplicitName("字".repeat(120)).ok).toBe(true);
    expect(validateExplicitName("字".repeat(121)).ok).toBe(false);
  });
});

describe("类型标记与默认名", () => {
  it("覆盖普通类型与未知类型", () => {
    expect(contentTypeLabelForNode("image")).toBe("图片");
    expect(contentTypeLabelForNode(COMPOSITE_ASSET_NODE_TYPE)).toBe("复合资产");
    expect(contentTypeLabelForNode(undefined)).toBe("作品");
  });
});

describe("resolveNodeDisplayName 不修改输入", () => {
  it("传入对象不被改写", () => {
    const input = { type: "image", explicitName: "保持", prompt: "x" };
    const snapshot = JSON.stringify(input);
    resolveNodeDisplayName(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
