import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFalInput, classifyFalModel, falModelDefinitions } from "../src/schema.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"));
}

describe("fal 模型定义", () => {
  it("按 x-fal-metadata.category 认类型，并把 anyOf/enum 收成表单字段", () => {
    const model = classifyFalModel("fal-ai/flux/schnell", fixture("flux-schnell"));
    expect(model?.modelType).toBe("image");
    expect(model?.promptRequirement).toBe("required");
    // 纯文生图没有参考图字段，所以不出现上传槽位。
    expect(model?.image).toBeUndefined();
    const properties = model?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.prompt).toMatchObject({ type: "string", "x-component": "Input.TextArea" });
    // image_size 是「预设字符串 or 自定义宽高对象」，取 enum 分支并保留外层 default。
    expect(properties.image_size).toMatchObject({ "x-component": "Select", default: "landscape_4_3" });
    // 模型专有预设（square_hd / landscape_4_3）不是分辨率档位，不能标成语义控件。
    expect(properties.image_size["x-pptask-control"]).toBeUndefined();
    expect(properties.num_inference_steps).toMatchObject({ "x-component": "NumberPicker", default: 4, minimum: 1, maximum: 12 });
    expect(properties.enable_safety_checker).toMatchObject({ "x-component": "Switch", default: true });
    expect(model?.defaultInput).toMatchObject({ prompt: "", num_inference_steps: 4, output_format: "jpeg", image_size: "landscape_4_3" });
    expect(falModelDefinitions([model!])[0]).toMatchObject({ providerId: "fal", providerModelId: "fal-ai/flux/schnell", modelType: "image", cancel: "remote" });
  });

  it("单图与多图参考字段分别绑定 urls", () => {
    const single = classifyFalModel("fal-ai/flux/dev/image-to-image", fixture("flux-dev-image-to-image"));
    expect(single?.image).toEqual({ key: "image_url", many: false });
    expect(buildFalInput({ prompt: "restyle", urls: ["https://cdn.example/a.png"] }, single!)).toEqual({
      prompt: "restyle",
      image_url: "https://cdn.example/a.png"
    });

    const many = classifyFalModel("fal-ai/nano-banana/edit", fixture("nano-banana-edit"));
    expect(many?.image).toEqual({ key: "image_urls", many: true });
    const manyProperties = many?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(manyProperties.aspect_ratio["x-pptask-control"]).toBe("aspect-ratio");
    expect((manyProperties.aspect_ratio.enum as Array<Record<string, unknown>>)[0]?.["x-pptask-adaptive"]).toBe(true);
    expect(buildFalInput({ prompt: "merge", urls: ["https://cdn.example/a.png", "https://cdn.example/b.png"] }, many!)).toEqual({
      prompt: "merge",
      image_urls: ["https://cdn.example/a.png", "https://cdn.example/b.png"]
    });
  });

  it("视频与文本模型分别给出视频输出与文本提示词", () => {
    const video = classifyFalModel("fal-ai/kling-video/v1.6/standard/text-to-video", fixture("kling-text-to-video"));
    expect(video?.modelType).toBe("video");
    expect(video?.promptRequirement).toBe("required");
    const videoProperties = video?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(videoProperties.aspect_ratio["x-pptask-control"]).toBe("aspect-ratio");

    const llm = classifyFalModel("fal-ai/any-llm", fixture("any-llm"));
    expect(llm?.modelType).toBe("language");
    expect(llm?.promptKey).toBe("prompt");
    expect(llm?.systemKey).toBe("system_prompt");
    const asked = llm?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(asked.model).toMatchObject({ "x-component": "Select" });
    // 语言模型把 user 消息拼成一段 prompt，system 单独走 system_prompt。
    expect(buildFalInput({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "你好" }] }
      ]
    }, llm!)).toEqual({ prompt: "你好", system_prompt: "be brief" });
  });

  it("语音转写这类非生成端点不注册", () => {
    expect(classifyFalModel("fal-ai/whisper", fixture("whisper"))).toBeUndefined();
    expect(classifyFalModel("fal-ai/unknown", {})).toBeUndefined();
  });

  it("image-to-video 的首帧进 image_url，末帧不作为主绑定", () => {
    const model = classifyFalModel("fal-ai/minimax/hailuo-02/standard/image-to-video", fixture("hailuo-image-to-video"));
    expect(model?.modelType).toBe("video");
    expect(model?.image).toEqual({ key: "image_url", many: false });
    expect(buildFalInput({ prompt: "pan", urls: ["https://cdn.example/first.png"] }, model!)).toEqual({
      prompt: "pan",
      image_url: "https://cdn.example/first.png"
    });
  });
});
