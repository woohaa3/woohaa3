/**
 * 任务失败文案映射（change: 2026-11-06-guard-video-generation-inputs）。
 *
 * 现场三条 Provider 原文必须变成「缺哪个字段 / 允许范围」，而不是把上游响应直接展示。
 */
import { describe, expect, it } from "vitest";
import { describeTaskFailure, PARAMETER_ERROR_FALLBACK, readParameterFailure } from "./task-failure.js";

describe("参数错误的可行动文案", () => {
  it("缺宽高比：保留字段名", () => {
    const message = describeTaskFailure({ message: "aspectRatio is required", status: 400 });
    expect(message).toContain("缺少必填参数");
    expect(message).toContain("宽高比");
    expect(message).toContain("aspectRatio");
    expect(message).not.toBe("aspectRatio is required");
  });

  it("缺分辨率：保留字段名", () => {
    const message = describeTaskFailure({ message: "resolution is required", status: 400 });
    expect(message).toContain("缺少必填参数");
    expect(message).toContain("分辨率");
  });

  it("时长越界：同时给出上下限", () => {
    const message = describeTaskFailure({
      message: "duration maximum value is 12 seconds, and duration must be greater than 4 seconds",
      status: 400
    });
    expect(message).toContain("时长");
    expect(message).toContain("12 秒");
    expect(message).toContain("4 秒");
  });

  it("上游把 JSON 响应体当消息时只提取 message", () => {
    const raw = JSON.stringify({
      error: {
        message: "resolution is required",
        type: "invalid_request_error"
      }
    });
    const message = describeTaskFailure({ message: raw, status: 400 });
    expect(message).toContain("分辨率");
    expect(message).not.toContain("invalid_request_error");
    expect(message).not.toContain("{");
  });

  it("识别为参数错误但无法细分时使用稳定兜底，不回显原文", () => {
    const raw = "unprocessable entity: {\"detail\":\"something provider-specific\"}";
    const message = describeTaskFailure({ message: raw, status: 422 });
    expect(message).toBe(PARAMETER_ERROR_FALLBACK);
    expect(message).not.toContain("provider-specific");
  });

  it("允许值列表错误给出可选项", () => {
    const message = readParameterFailure("aspectRatio must be one of 16:9, 9:16, 1:1");
    expect(message).toContain("宽高比");
    expect(message).toContain("16:9");
    expect(message).toContain("9:16");
  });

  it("非参数错误保留原消息", () => {
    expect(describeTaskFailure({ message: "上游任务已取消", status: 500 })).toBe("上游任务已取消");
  });
});
