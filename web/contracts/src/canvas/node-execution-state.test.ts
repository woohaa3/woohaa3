/**
 * 空视频节点状态（change: 2026-11-06-guard-video-generation-inputs）。
 *
 * N12：创建后从未提交 prompt/model / provider 任务的视频节点，卡片必须写「未提交 · 待配置」，
 * 不能是空白，也不能因为没任务就显示成功或失败。
 */
import { describe, expect, it } from "vitest";
import {
  UNSUBMITTED_VIDEO_LABEL,
  isUnsubmittedVideoNode
} from "./node-execution-state.js";
import { readBody } from "./render-scene/node-projection.js";

describe("未提交视频节点", () => {
  it("idle 且无 run/产出时视为未提交", () => {
    expect(isUnsubmittedVideoNode("video", { taskStatus: "idle" })).toBe(true);
    expect(isUnsubmittedVideoNode("video", {})).toBe(true);
    expect(isUnsubmittedVideoNode("video", undefined)).toBe(true);
    expect(readBody("video", { taskStatus: "idle" }, new Map())).toBe(UNSUBMITTED_VIDEO_LABEL);
  });

  it("运行中 / 终态 / 有产出都不算未提交", () => {
    expect(isUnsubmittedVideoNode("video", { taskStatus: "pending" })).toBe(false);
    expect(isUnsubmittedVideoNode("video", { taskStatus: "processing", activeRunId: "run-1" })).toBe(false);
    expect(isUnsubmittedVideoNode("video", { taskStatus: "successed", outputAssetId: "a1" })).toBe(false);
    expect(isUnsubmittedVideoNode("video", { taskStatus: "failed", activeRunId: "run-1" })).toBe(false);
    expect(readBody("video", { taskStatus: "failed", activeRunId: "run-1" }, new Map())).not.toContain("未提交");
  });

  it("其它节点类型不套用视频文案", () => {
    expect(isUnsubmittedVideoNode("image", { taskStatus: "idle" })).toBe(false);
    expect(readBody("image", { taskStatus: "idle" }, new Map())).toBe("");
  });
});
