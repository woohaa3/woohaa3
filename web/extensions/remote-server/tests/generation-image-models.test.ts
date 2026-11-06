/**
 * 远端模型的参数家族适配测试（Provider 侧）。
 *
 * 锁住三条边界：
 * 1. **家族判定在扩展，不在 server**：server 只转述 LiteLLM 的目录；
 * 2. **目录**：卡片能对上的模型，schema 由家族给出（不是服务端那份「按类型一份」的通用形状）；
 * 3. **提交**：面板语义必须落成上游认识的字段，否则用户选了也不生效。
 */
import { describe, expect, it } from "vitest";
import type { GenerationModelDefinition } from "@woohaa3/contracts";
import {
  translateParameters,
  withModelFamily
} from "../src/backend/generation/model-families.js";

/** 服务端为任意模型下发的那份通用 schema（修复前 seedream / seedance 看到的就是它）。 */
function serverGenericModel(
  providerModelId: string,
  modelType: "image" | "video" | "audio"
): GenerationModelDefinition {
  return {
    providerId: "remote-server",
    providerModelId,
    modelType,
    title: providerModelId,
    inputSchema:
      modelType === "image"
        ? {
            type: "object",
            properties: { size: { type: "string", title: "尺寸", default: "1024x1024" } }
          }
        : modelType === "audio"
          ? {
              type: "object",
              properties: {
                voice: { type: "string", title: "音色", default: "alloy" },
                response_format: {
                  type: "string",
                  title: "格式",
                  default: "mp3",
                  enum: ["mp3", "wav", "opus"]
                },
                speed: { type: "number", title: "语速", default: 1, minimum: 0.25, maximum: 4 }
              }
            }
          : {
              type: "object",
              properties: {
                seconds: { type: "string", title: "时长（秒）", default: "4" },
                size: { type: "string", title: "分辨率", default: "720p" }
              }
            },
    defaultInput:
      modelType === "image"
        ? { size: "1024x1024" }
        : modelType === "audio"
          ? { voice: "alloy", response_format: "mp3", speed: 1 }
          : { seconds: "4", size: "720p" },
    interaction: { id: "generic-model", version: 1 },
    cancel: "remote",
    promptRequirement: "required",
    taskTimeoutMs: 300000
  };
}

describe("withModelFamily · 图像", () => {
  it("seedream 拿到「图片比例 + 图片分辨率 + 透明背景」，服务端的裸像素 size 被完全替换", () => {
    const model = withModelFamily(serverGenericModel("doubao-seedream-5-0-pro-260628", "image"));
    const properties = model.inputSchema!.properties as Record<string, Record<string, unknown>>;

    // 家族覆盖它认识的键（比例 / 分辨率 / 透明背景）；提示词、参考图与输出格式仍来自类型预设与卡片。
    expect(Object.keys(properties).sort()).toEqual([
      "aspectRatio",
      "background",
      "outputFormat",
      "prompt",
      "referencesImage",
      "resolution"
    ]);
    expect(properties.resolution!["x-pptask-control"]).toBe("resolution");
    expect(properties.aspectRatio!["x-pptask-control"]).toBe("aspect-ratio");
    expect(properties.background!["x-pptask-control"]).toBe("background");
    expect(properties.size).toBeUndefined();
    // 即梦没有 quality / n。
    expect(properties.quality).toBeUndefined();
    expect(properties.n).toBeUndefined();
  });

  it("seedream 4.5 没有透明背景（官方只给 pro / flash）", () => {
    const model = withModelFamily(serverGenericModel("doubao-seedream-4-5-251128", "image"));
    const properties = model.inputSchema!.properties as Record<string, unknown>;
    expect(properties.background).toBeUndefined();
  });

  it("gpt-image 保留 quality / n", () => {
    const model = withModelFamily(serverGenericModel("gpt-image-2.5", "image"));
    const properties = model.inputSchema!.properties as Record<string, unknown>;
    expect(properties.quality).toBeDefined();
    expect(properties.n).toBeDefined();
  });

  it("未识别的图像模型保持服务端 schema 不动", () => {
    const original = serverGenericModel("some-vendor-image-v2", "image");
    expect(withModelFamily(original)).toBe(original);
  });

  it("百炼型号按卡片精确命中：负向提示词与智能改写来自卡片", () => {
    // 网关目录里出现百炼型号时，schema 由卡片给出（不是服务端那份裸 size）。
    const model = withModelFamily(serverGenericModel("qwen-image-2.0-pro", "image"));
    const properties = model.inputSchema!.properties as Record<string, Record<string, unknown>>;

    expect(properties.size).toBeUndefined();
    expect(Object.keys(properties).sort()).toEqual([
      "aspectRatio",
      "negativePrompt",
      "prompt",
      "promptExtend",
      "referencesImage",
      "resolution"
    ]);
    // 参考图上限来自卡片：2.0 系列一次最多三张。
    expect(properties.referencesImage!.maxItems).toBe(3);
    expect(model.defaultInput).toMatchObject({ aspectRatio: "1:1", resolution: "2K" });
  });

  it("百炼的卡片匹配是精确的：未登记的同名系列保持服务端 schema", () => {
    const original = serverGenericModel("qwen-image-9.9-pro", "image");
    expect(withModelFamily(original)).toBe(original);
  });
});

describe("withModelFamily · 视频", () => {
  it("seedance 2.5 拿到「时长 + 比例 + 分辨率」，不再是两个文本框", () => {
    const model = withModelFamily(serverGenericModel("seedance-2.5", "video"));
    const properties = model.inputSchema!.properties as Record<string, Record<string, unknown>>;

    expect(properties.seconds).toBeUndefined();
    expect(properties.size).toBeUndefined();
    expect(properties.durationSeconds).toMatchObject({ minimum: 4, maximum: 30, step: 1 });
    expect(properties.aspectRatio!["x-pptask-control"]).toBe("aspect-ratio");
    expect(properties.resolution!["x-pptask-control"]).toBe("resolution");
  });

  it("不同家族得到不同值域：Veo 只有 4/6/8 秒、720p/1080p", () => {
    const model = withModelFamily(serverGenericModel("veo-3.1-fast", "video"));
    const properties = model.inputSchema!.properties as Record<string, Record<string, unknown>>;
    expect(properties.durationSeconds).toMatchObject({ minimum: 4, maximum: 8, step: 2 });
    expect(
      (properties.resolution!.enum as Array<{ value: string }>).map((entry) => entry.value)
    ).toEqual(["720p", "1080p"]);
  });

  it("卡片约束随目录下发：Seedance 2.5 声明了三类参考的数量与体积", () => {
    const model = withModelFamily(serverGenericModel("seedance-2.5", "video"));
    const limits = model.capabilityFacts?.limits;
    expect(limits?.references?.image?.max).toBe(30);
    expect(limits?.references?.video?.max).toBe(10);
    expect(limits?.combined?.[0]?.max).toBe(30);
  });

  it("卡片的参考绑定覆盖服务端那份按类型通用的绑定", () => {
    // 网关的真实 id 带日期后缀：卡片按家族兜底命中。
    const model = withModelFamily(serverGenericModel("seedance-1-0-pro-250528", "video"));
    const referenceInput = model.capabilities?.referenceInput as
      | { bindings?: Array<{ semantic: string; maxItems: number }> }
      | undefined;
    expect(referenceInput?.bindings?.map((binding) => binding.semantic)).toEqual(["reference-image"]);
    expect(referenceInput?.bindings?.[0]?.maxItems).toBe(2);
  });

  it("未识别的视频模型保持服务端 schema 不动", () => {
    const original = serverGenericModel("some-unknown-video", "video");
    expect(withModelFamily(original)).toBe(original);
  });
});

describe("withModelFamily · 音频", () => {
  it("TTS 卡片替换服务端的语音形状：音色 / 输出格式 / 语速", () => {
    const model = withModelFamily(serverGenericModel("tts-1", "audio"));
    const properties = model.inputSchema!.properties as Record<string, Record<string, unknown>>;

    expect(properties.response_format).toBeUndefined();
    expect(Object.keys(properties).sort()).toEqual(["outputFormat", "prompt", "speed", "voice"]);
    expect((properties.voice!.enum as Array<{ value: string }>).map((entry) => entry.value)).toContain(
      "alloy"
    );
    expect(properties.speed).toMatchObject({ minimum: 0.25, maximum: 4, default: 1 });
    // 卡片声明的输入上限随目录下发。
    expect(model.capabilityFacts?.limits?.promptMaxChars).toBe(4096);
  });

  it("未识别的音频模型保持服务端 schema 不动", () => {
    const original = serverGenericModel("some-vendor-speech", "audio");
    expect(withModelFamily(original)).toBe(original);
  });
});

describe("translateParameters", () => {
  it("图像：比例 + 分辨率落成上游字段", () => {
    const fields = translateParameters("doubao-seedream-5-0-pro-260628", "image", {
      resolution: "2K",
      aspectRatio: "16:9"
    });
    expect(typeof fields.size).toBe("string");
  });

  it("视频：时长按家族步长对齐，比例 + 分辨率落成像素 size", () => {
    expect(translateParameters("veo-3.1-fast", "video", { durationSeconds: 7 }).seconds).toBe(8);
    const fields = translateParameters("seedance-2", "video", {
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "720p"
    });
    expect(fields).toEqual({ seconds: 8, size: "1280x720" });
  });

  it("视频：自适应比例不发 size", () => {
    const fields = translateParameters("seedance-2", "video", {
      durationSeconds: 5,
      aspectRatio: "adaptive",
      resolution: "720p"
    });
    expect(fields.size).toBeUndefined();
    expect(fields.seconds).toBe(5);
  });

  it("未识别家族原样透传", () => {
    const parameters = { seconds: "4", size: "1280x720" };
    expect(translateParameters("some-unknown-video", "video", parameters)).toEqual(parameters);
    expect(translateParameters("some-vendor-image", "image", { size: "1024x1024" })).toEqual({
      size: "1024x1024"
    });
  });

  it("图像：百炼型号落成 `宽*高` 与 watermark，负向提示词按上限截断", () => {
    const fields = translateParameters("qwen-image-2.0-pro", "image", {
      aspectRatio: "16:9",
      resolution: "2K",
      negativePrompt: "低清",
      promptExtend: false
    });
    expect(fields).toEqual({
      size: "2688*1536",
      watermark: false,
      negative_prompt: "低清",
      prompt_extend: false
    });
    // 万相不认这两个开关：面板不会给，旧草稿带来的也不能发出去。
    expect(
      translateParameters("wan2.7-image-pro", "image", {
        aspectRatio: "1:1",
        resolution: "4K",
        negativePrompt: "低清",
        promptExtend: true
      })
    ).toEqual({ size: "4096*4096", watermark: false });
  });

  it("图像：百炼带参考图时档位收窄（万相 Pro 的 4K 只给文生图）", () => {
    // `translateParameters` 只看参数、不看参考图数量：收窄由百炼插件在拼请求体时做，
    // 网关链路没有参考图信息，所以这里按 4K 下发，与 `imageRequestFields` 的默认一致。
    expect(
      translateParameters("wan2.7-image-pro", "image", { aspectRatio: "16:9", resolution: "4K" })
    ).toEqual({ size: "4096*2304", watermark: false });
  });

  it("音频：outputFormat 落成上游的 response_format，语速越界被夹住", () => {
    expect(
      translateParameters("tts-1", "audio", {
        voice: "nova",
        outputFormat: "WAV",
        speed: 9
      })
    ).toEqual({ voice: "nova", response_format: "wav", speed: 4 });
  });

  it("未识别的音频模型原样透传（服务端自己认识它的上游）", () => {
    const parameters = { voice: "alloy", response_format: "mp3", speed: 1 };
    expect(translateParameters("some-vendor-speech", "audio", parameters)).toEqual(parameters);
  });

  it("language 不经过家族翻译", () => {
    expect(translateParameters("gpt-4o", "language", { temperature: 0.7 })).toEqual({
      temperature: 0.7
    });
  });
});
