import { describe, expect, it } from "vitest";
import { findAdaptiveOption } from "@woohaa3/contracts";
import { buildChatBody, buildGenerateBody, describeGrsaiModel, grsaiInputSchema } from "../src/schema.js";
import type { GrsaiModel } from "../src/discovery.js";

const image: GrsaiModel = { id: "nano-banana-2", kind: "image", title: "nano-banana-2" };
const video: GrsaiModel = { id: "minimax-h3", kind: "video", title: "minimax-h3" };
const text: GrsaiModel = { id: "gpt-5.5", kind: "language", title: "gpt-5.5" };

describe("grsai 输入表单", () => {
  it("可选参数不给默认值，避免把 A 模型的取值发给 B 模型", () => {
    const schema = grsaiInputSchema("image");
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.prompt).toMatchObject({ type: "string", "x-component": "Input.TextArea" });
    for (const key of ["aspectRatio", "imageSize", "quality", "background"]) {
      expect(properties[key]).toMatchObject({ "x-component": "Select" });
      expect(properties[key]?.default).toBeUndefined();
    }
    expect(properties.urls).toMatchObject({ "x-pptask-semantic": "reference-image", "x-component": "Upload" });
    // 公共参数语义：比例/分辨率/质量由 builder 声明，自适应选项仍是静默的 auto。
    expect(properties.aspectRatio).toMatchObject({ title: "比例", "x-pptask-control": "aspect-ratio" });
    expect(findAdaptiveOption(properties.aspectRatio?.enum)).toEqual({ value: "auto", label: "自适应" });
    expect(properties.imageSize).toMatchObject({ title: "图片分辨率", "x-pptask-control": "resolution" });
    expect(properties.quality).toMatchObject({ title: "质量", "x-pptask-control": "quality" });
    expect(properties.background?.["x-pptask-control"]).toBeUndefined();
    expect(describeGrsaiModel(image)).toMatchObject({
      title: "nano-banana-2",
      promptRequirement: "required",
      defaultInput: { prompt: "", urls: [] }
    });
    // 文本模型保留 chat completions 自己的默认值。
    expect(describeGrsaiModel(text).defaultInput).toMatchObject({ maxTokens: 2048, jsonMode: false });
    expect(grsaiInputSchema("video").properties).toHaveProperty("duration");
    const videoProperties = grsaiInputSchema("video").properties as Record<string, Record<string, unknown>>;
    expect(videoProperties.aspectRatio).toMatchObject({ title: "比例", "x-pptask-control": "aspect-ratio" });
    expect(findAdaptiveOption(videoProperties.aspectRatio?.enum)).toBeUndefined();
    expect(videoProperties.resolution).toMatchObject({ title: "分辨率", "x-pptask-control": "resolution" });
    expect(videoProperties.resolution?.default).toBeUndefined();
  });
});

describe("grsai 请求体", () => {
  it("图片走统一生成接口，空值不进请求体", () => {
    expect(buildGenerateBody(image, { prompt: "a cat", urls: ["https://cdn.example/a.png"], aspectRatio: "", imageSize: "2K" }))
      .toEqual({ model: "nano-banana-2", prompt: "a cat", replyType: "async", images: ["https://cdn.example/a.png"], imageSize: "2K" });
    expect(buildGenerateBody(image, { prompt: "a cat" })).toEqual({ model: "nano-banana-2", prompt: "a cat", replyType: "async" });
  });

  it("视频带分辨率与时长，不带图片专属字段", () => {
    expect(buildGenerateBody(video, { prompt: "pan", urls: ["https://cdn.example/first.png"], resolution: "1080p", duration: 8, imageSize: "1K" }))
      .toEqual({
        model: "minimax-h3",
        prompt: "pan",
        replyType: "async",
        images: ["https://cdn.example/first.png"],
        resolution: "1080p",
        duration: 8
      });
  });

  it("文本走 Chat Completions，系统提示词与参考图都归位", () => {
    const body = buildChatBody(text, {
      system: "简洁",
      messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
      urls: ["https://cdn.example/a.png"],
      maxTokens: 32,
      jsonMode: true
    });
    expect(body.model).toBe("gpt-5.5");
    expect(body.max_tokens).toBe(32);
    expect(body.response_format).toEqual({ type: "json_object" });
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toMatchObject({ role: "system", content: "简洁" });
    // 单段文本会被压成字符串，参考图随后追加到同一条 user 消息里。
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "你好" }, { type: "image_url", image_url: { url: "https://cdn.example/a.png" } }]
    });
  });
});
