import { describe, expect, it } from "vitest";
import { buildPredictionInput, classifyReplicateModel, promptText } from "../src/schema.js";
import { parseModelIds } from "../src/shared.js";

const VERSION = "a".repeat(64);

function modelPayload(input: Record<string, unknown>, output: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    description: extra.description,
    default_example: extra.example ? { input: extra.example } : undefined,
    latest_version: {
      id: VERSION,
      openapi_schema: { components: { schemas: { Input: input, Output: output } } }
    }
  };
}

describe("Replicate 模型名单", () => {
  it("接受逗号和换行，拒绝不是 owner/name 的标识", () => {
    expect(parseModelIds("black-forest-labs/flux-schnell, owner/model\nowner/model")).toEqual({
      ok: true,
      ids: ["black-forest-labs/flux-schnell", "owner/model"]
    });
    expect(parseModelIds("flux-schnell").ok).toBe(false);
    expect(parseModelIds("")).toEqual({ ok: true, ids: [] });
  });
});

describe("Replicate 模型分类", () => {
  it("把带 uri 图片输入的模型收成参考图字段，并把 urls 映到 image", () => {
    const model = classifyReplicateModel("black-forest-labs/flux-schnell", modelPayload(
      {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", title: "Prompt", "x-order": 0 },
          image: { type: "string", format: "uri", title: "Image", "x-order": 1 },
          aspect_ratio: { type: "string", title: "Aspect", enum: ["1:1", "16:9"], default: "1:1", "x-order": 2 },
          mask: { type: "string", format: "uri", title: "Mask" }
        }
      },
      { type: "array", items: { type: "string", format: "uri" } },
      { description: "Fast image generation", example: { prompt: "a cat", aspect_ratio: "16:9", image: "https://example.test/in.png" } }
    ));
    expect(model?.modelType).toBe("image");
    expect(model?.promptRequirement).toBe("required");
    expect(model?.image).toEqual({ key: "image", many: false });
    expect(model?.defaultInput).toEqual({ prompt: "a cat", urls: [], aspect_ratio: "16:9" });
    const properties = (model?.inputSchema.properties ?? {}) as Record<string, { "x-pptask-semantic"?: string; "x-pptask-control"?: string }>;
    expect(properties.urls?.["x-pptask-semantic"]).toBe("reference-image");
    expect(properties.aspect_ratio?.["x-pptask-control"]).toBe("aspect-ratio");
    expect(properties.image).toBeUndefined();
    expect(buildPredictionInput({
      prompt: "draw",
      urls: ["https://cdn.example/in.png", "https://cdn.example/extra.png"],
      aspect_ratio: "16:9",
      ignored: true
    }, model!)).toEqual({
      prompt: "draw",
      image: "https://cdn.example/in.png",
      aspect_ratio: "16:9"
    });
  });

  it("多图字段接收整个 urls 数组，文本模型从消息里取 prompt", () => {
    const model = classifyReplicateModel("owner/edit", modelPayload(
      {
        type: "object",
        properties: {
          prompt: { type: "string" },
          input_images: { type: "array", items: { type: "string", format: "uri" } }
        }
      },
      { type: "string", format: "uri" },
      { description: "Edit images" }
    ));
    expect(model?.image).toEqual({ key: "input_images", many: true });
    expect(buildPredictionInput({ urls: ["https://cdn.example/a.png", "https://cdn.example/b.png"] }, model!)).toEqual({
      input_images: ["https://cdn.example/a.png", "https://cdn.example/b.png"]
    });

    const language = classifyReplicateModel("meta/llama", modelPayload(
      { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, system_prompt: { type: "string" } } },
      { type: "array", items: { type: "string" } },
      { description: "Chat model" }
    ));
    expect(language?.modelType).toBe("language");
    expect(promptText({
      messages: [{ role: "system", content: "be brief" }, { role: "user", content: [{ type: "text", text: "hello" }] }]
    })).toBe("hello");
    expect(buildPredictionInput({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "https://cdn.example/a.png" } }] }
      ]
    }, language!)).toEqual({
      prompt: "hello",
      system_prompt: "be brief"
    });
  });

  it("按描述把视频模型分开，并丢掉 3D 和没有版本的模型", () => {
    const video = classifyReplicateModel("owner/clip", modelPayload(
      {
        type: "object",
        properties: {
          prompt: { type: "string" },
          image: { type: "string", format: "uri" }
        }
      },
      { type: "string", format: "uri" },
      { description: "Generate a short video" }
    ));
    expect(video?.modelType).toBe("video");
    expect(video?.image?.key).toBe("image");

    expect(classifyReplicateModel("owner/mesh", modelPayload(
      { type: "object", properties: { prompt: { type: "string" } } },
      { type: "string", format: "uri" },
      { description: "Generate a 3d mesh" }
    ))).toBeUndefined();
    expect(classifyReplicateModel("owner/empty", { description: "image", latest_version: null })).toBeUndefined();
  });
});
