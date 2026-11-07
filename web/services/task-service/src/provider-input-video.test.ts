/**
 * Task 默认视频输入携带画布身份
 * （change: 2026-11-06-add-litellm-local-video，任务 2.1 / 2.2）。
 *
 * 本机 LiteLLM Provider 把视频结果写成任务所属画布的稳定媒体对象，所以默认视频输入
 * 必须带 `canvasId`；其它模型类型保持原形状，参考输入分组（urls / videoUrls / audioUrls）
 * 不变。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskInput, TaskSubmitRequest } from "@woohaa3/contracts";
import { buildInput } from "./composition/provider-input.js";

function request(
  modelType: "video" | "audio" | "image" | "language",
  inputs: CanvasTaskInput[] = [],
  parameters: Record<string, unknown> = {}
): TaskSubmitRequest {
  return {
    workerTaskKey: "run-1",
    canvasId: "canvas-7",
    nodeId: "n1",
    runId: "run-1",
    jobId: "job-run-1",
    nodeType: modelType === "language" ? "text" : modelType,
    modelKey: `litellm:${modelType}-model`,
    modelType,
    prompt: "一只猫在窗边",
    parameters,
    inputs
  } as unknown as TaskSubmitRequest;
}

const REFERENCES: CanvasTaskInput[] = [
  { assetId: "a1", role: "reference_image", storageKey: "k/a.png", mediaType: "image/png", mediaKind: "image" },
  { assetId: "a2", role: "reference_video", storageKey: "k/b.mp4", mediaType: "video/mp4", mediaKind: "video" },
  { assetId: "a3", role: "reference_audio", storageKey: "k/c.mp3", mediaType: "audio/mpeg", mediaKind: "audio" }
];
const URLS = ["https://signed/a.png", "https://signed/b.mp4", "https://signed/c.mp3"];

describe("buildInput 视频输入", () => {
  it("带上画布身份，同时保持三类参考输入分组", () => {
    const input = buildInput(
      request("video", REFERENCES, { durationSeconds: 4, aspectRatio: "16:9", resolution: "720p" }),
      URLS
    );

    expect(input).toEqual({
      prompt: "一只猫在窗边",
      durationSeconds: 4,
      aspectRatio: "16:9",
      resolution: "720p",
      canvasId: "canvas-7",
      urls: [{ url: "https://signed/a.png", role: "reference_image" }],
      videoUrls: [{ url: "https://signed/b.mp4", role: "reference_video" }],
      audioUrls: [{ url: "https://signed/c.mp3", role: "reference_audio" }]
    });
  });

  it("请求的画布身份不被面板参数覆盖", () => {
    const input = buildInput(request("video", [], { canvasId: "spoofed" }), []);
    expect(input.canvasId).toBe("canvas-7");
  });

  it("音频/图片/文本输入不新增画布身份", () => {
    const audio = buildInput(
      request("audio", [{ assetId: "a3", role: "reference_audio", storageKey: "k/c.mp3", mediaType: "audio/mpeg", mediaKind: "audio" }]),
      ["https://signed/c.mp3"]
    );
    expect(audio).not.toHaveProperty("canvasId");

    expect(buildInput(request("image"), [])).not.toHaveProperty("canvasId");
    expect(buildInput(request("language"), [])).not.toHaveProperty("canvasId");
  });
});
