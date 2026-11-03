import { describe, expect, it } from "vitest";
import { findAdaptiveOption } from "@woohaa3/contracts";
import { parseModelList } from "../src/discovery.js";
import { describeCephalonModel } from "../src/provider.js";
import MODELS from "./fixtures/models.json";

/** 用真实发现结果取模型事实（视觉能力与输出上限都来自平台声明）。 */
const DISCOVERED = parseModelList(MODELS);
const find = (id: string) => DISCOVERED.find((model) => model.id === id);

function propertiesOf(modelId: string, modelType: "language" | "image" | "video"): Record<string, Record<string, unknown>> {
  return describeCephalonModel(modelId, modelType, find(modelId)).inputSchema?.properties as Record<
    string,
    Record<string, unknown>
  >;
}

describe("端脑云参数 schema", () => {
  it("三类描述都带 providerId / modelId / modelType，取消一律不可用", () => {
    for (const [type, id] of [
      ["language", "deepseek-v4-flash"],
      ["image", "NanoBanana2"],
      ["video", "seedance-2.5"]
    ] as const) {
      const description = describeCephalonModel(id, type);
      expect(description).toMatchObject({ providerId: "cephalon", modelId: id, modelType: type, title: id });
      expect(description.capabilities).toMatchObject({ cancel: false });
      expect(description.defaultInput).toBeTypeOf("object");
    }
  });

  it("文本：参考图只给声明视觉能力的模型", () => {
    const vision = propertiesOf("gemini-3.5-flash", "language");
    expect(vision.urls).toMatchObject({ title: "参考图", "x-pptask-semantic": "reference-image" });

    const blind = describeCephalonModel("deepseek-v4-pro", "language", find("deepseek-v4-pro"));
    const blindProps = blind.inputSchema?.properties as Record<string, unknown>;
    expect(blindProps.urls).toBeUndefined();
    expect(blind.defaultInput).not.toHaveProperty("urls");
    expect(blind.inputSchema).toBeDefined();
  });

  it("文本：maxTokens 上限取平台 max_output_tokens", () => {
    const properties = propertiesOf("deepseek-v4-flash", "language");
    expect(properties.maxTokens).toMatchObject({ type: "number", default: 2048, maximum: 393216 });
    const unknown = propertiesOf("nexus-router", "language");
    // 平台没给上限时不冒充具体数字，用保守默认。
    expect(unknown.maxTokens).toMatchObject({ default: 2048, maximum: 8192 });
  });

  it("图片：只有提示词、分辨率档位与数量，不声明图生图", () => {
    const description = describeCephalonModel("NanoBanana2", "image");
    const properties = description.inputSchema?.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties).sort()).toEqual(["n", "prompt", "resolution"]);
    expect(properties.resolution).toMatchObject({
      title: "图片分辨率",
      default: "1K",
      "x-pptask-control": "resolution"
    });
    expect(properties.resolution?.enum).toEqual([
      { value: "auto", label: "auto" },
      { value: "1K", label: "1K" },
      { value: "2K", label: "2K" },
      { value: "4K", label: "4K" }
    ]);
    expect(properties.n).toMatchObject({ minimum: 1, maximum: 10, default: 1 });
    // 平台没有 /images/edits：不声明图生图/编辑，也不给参考图控件。
    expect(description.capabilities).toEqual({ mediaKind: "image", operations: ["text-to-image"], cancel: false });
    expect(properties.urls).toBeUndefined();
  });

  it("视频：比例带自适应、分辨率按模型取值域、时长 4 秒起", () => {
    const properties = propertiesOf("seedance-2.5", "video");
    expect(properties.aspectRatio).toMatchObject({
      title: "比例",
      default: "auto",
      "x-pptask-control": "aspect-ratio"
    });
    expect(findAdaptiveOption(properties.aspectRatio?.enum)).toEqual({ value: "auto", label: "自适应" });
    expect(properties.resolution?.enum).toEqual([
      { value: "720P", label: "720P" },
      { value: "1080P", label: "1080P" }
    ]);
    expect(properties.duration).toMatchObject({ default: 5, minimum: 4, maximum: 30 });
    // 视频没有取消端点：不声明取消，面板也不显示。
    expect(properties.cancel).toBeUndefined();

    // 平台文档：H3 只有 768P / 2K（明确没有 720P）。
    const h3 = propertiesOf("minimax-h3", "video");
    expect(h3.resolution?.enum).toEqual([
      { value: "768P", label: "768P" },
      { value: "2K", label: "2K" }
    ]);
    expect(h3.duration).toMatchObject({ maximum: 15 });

    // 平台没有给出取值域的模型不给分辨率控件（宁可少一个控件，也不显示必然失败的值）。
    const unknown = propertiesOf("brand-new-video-model", "video");
    expect(unknown.resolution).toBeUndefined();
    expect(unknown.duration).toMatchObject({ maximum: 15 });
  });

  it("视频描述不声明无实现字段", () => {
    const description = describeCephalonModel("seedance-2.5", "video");
    const properties = description.inputSchema?.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["aspectRatio", "duration", "prompt", "resolution", "urls"]);
    expect(properties).not.toHaveProperty("fps");
    expect(properties).not.toHaveProperty("seed");
    expect(properties).not.toHaveProperty("generateAudio");
    expect(description.capabilities).toEqual({
      mediaKind: "video",
      operations: ["text-to-video", "image-to-video"],
      cancel: false
    });
  });
});
