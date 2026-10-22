/**
 * Task Service language 多模态组装
 * （change: add-reference-inputs-and-mentions，任务 6.1 / 6.3）。
 *
 * 直接覆盖**生产实现** `composition/provider-input.ts#buildInput`：画布提交走
 * composition.ts → buildProviderInputForResource → buildInput，而 `worker/normalize.ts`
 * 下的同名组装没有生产消费者（2026-10-20 修正：此前测试测的是影子实现）。
 *
 * 组装形状是 OpenAI 风格的 content part（`image_url` + 签名 HTTPS URL），因为它要
 * JSON 序列化后落 `task_records.params_json`；把 part 翻译成各 provider 的 wire 形状
 * 是 `@sdppp/pptask` 归一层 / provider adapter 的职责。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskInput, TaskSubmitRequest } from "@woohaa3/contracts";
import { buildInput } from "./composition/provider-input.js";

function languageRequest(prompt: string, inputs: CanvasTaskInput[]): TaskSubmitRequest {
  return {
    workerTaskKey: "run-1",
    runId: "run-1",
    jobId: "job-run-1",
    nodeId: "n1",
    canvasId: "c1",
    modelKey: "litellm:gemini-2.5-flash",
    modelType: "language",
    prompt,
    parameters: {},
    inputs
  } as unknown as TaskSubmitRequest;
}

describe("buildInput language 多模态（任务 6.1）", () => {
  it("文本在前，媒体按稳定输入顺序追加", () => {
    const input = buildInput(
      languageRequest("描述这些素材", [
        { assetId: "a1", role: "reference_image", storageKey: "k/a.png", mediaType: "image/png", mediaKind: "image" },
        { assetId: "a2", role: "reference_video", storageKey: "k/b.mp4", mediaType: "video/mp4", mediaKind: "video" },
        { assetId: "a3", role: "reference_audio", storageKey: "k/c.mp3", mediaType: "audio/mpeg", mediaKind: "audio" }
      ]),
      ["https://signed/a.png", "https://signed/b.mp4", "https://signed/c.mp3"]
    );
    const messages = input.prompt as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content[0]).toEqual({ type: "text", text: "描述这些素材" });
    expect(messages[0]!.content[1]).toEqual({ type: "image_url", image_url: { url: "https://signed/a.png" } });
    expect(messages[0]!.content[2]).toEqual({ type: "video_url", video_url: { url: "https://signed/b.mp4" } });
    expect(messages[0]!.content[3]).toEqual({ type: "audio_url", audio_url: { url: "https://signed/c.mp3" } });
  });

  it("无 inputs 时退化为纯文本消息", () => {
    const input = buildInput(languageRequest("你好", []), []);
    const messages = input.prompt as Array<{ content: unknown[] }>;
    expect(messages[0]!.content).toEqual([{ type: "text", text: "你好" }]);
  });

  it("缺 mediaKind 时按 mediaType 推断", () => {
    const input = buildInput(
      languageRequest("x", [
        { assetId: "a1", role: "reference_image", storageKey: "k/a.jpg", mediaType: "image/jpeg" }
      ]),
      ["https://signed/a.jpg"]
    );
    const messages = input.prompt as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]!.content[1]).toEqual({ type: "image_url", image_url: { url: "https://signed/a.jpg" } });
  });

  it("参数原样并入 provider input（不吞掉模型参数）", () => {
    const request = { ...languageRequest("x", []), parameters: { maxTokens: 99 } } as unknown as TaskSubmitRequest;
    expect(buildInput(request, [])).toMatchObject({ maxTokens: 99 });
  });
});
