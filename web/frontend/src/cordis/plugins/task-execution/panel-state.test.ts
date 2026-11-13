/**
 * 面板受控 draft 派生测试（回归：生成面板刷新后重置参数）。
 *
 * 已提交的 prompt/parameters 由 Canvas Service 写入权威 nodeData；草稿只在内存存活、
 * 刷新即丢。面板刷新后必须回落到 nodeData，否则会丢失上次执行记录并把参数重置成目录默认。
 */
import { describe, expect, it } from "vitest";
import { derivePanelDraft, derivePanelTaskState } from "./panel-state.js";

describe("derivePanelDraft", () => {
  it("无草稿时回落到规范 nodeData（刷新后保留上次执行记录）", () => {
    const draft = derivePanelDraft(
      { prompt: "雨夜霓虹街道", parameters: { ratio: "16:9", resolution: "2K", model: "gpt-image-2" } },
      undefined
    );
    expect(draft).toEqual({
      prompt: "雨夜霓虹街道",
      parameters: { ratio: "16:9", resolution: "2K", model: "gpt-image-2" }
    });
  });

  it("模型草稿替换参数集合，避免带入另一模型的规范参数", () => {
    const draft = derivePanelDraft(
      { prompt: "规范提示词", parameters: { ratio: "16:9", resolution: "2K" } },
      { prompt: "本地未提交", parameters: { ratio: "1:1" } }
    );
    expect(draft.prompt).toBe("本地未提交");
    expect(draft.parameters).toEqual({ ratio: "1:1" });
  });

  it("规范与草稿都缺失时给出空值而不是 undefined", () => {
    expect(derivePanelDraft({}, undefined)).toEqual({ prompt: "", parameters: {} });
  });

  it("不把非字符串 prompt 当成文本", () => {
    expect(derivePanelDraft({ prompt: 123 } as never, undefined).prompt).toBe("");
  });
});

describe("derivePanelTaskState", () => {
  it("cancelled 映射为 failed 并带取消原因", () => {
    expect(derivePanelTaskState({ taskStatus: "cancelled" })).toEqual({
      taskStatus: "failed",
      progress: undefined,
      errorMessage: "任务已取消"
    });
  });
});
