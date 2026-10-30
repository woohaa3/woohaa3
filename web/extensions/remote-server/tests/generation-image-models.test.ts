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
  modelType: "image" | "video"
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
        : {
            type: "object",
            properties: {
              seconds: { type: "string", title: "时长（秒）", default: "4" },
              size: { type: "string", title: "分辨率", default: "720p" }
            }
          },
    defaultInput: modelType === "image" ? { size: "1024x1024" } : { seconds: "4", size: "720p" },
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

  it("language / audio 不经过家族翻译", () => {
    expect(translateParameters("gpt-4o", "language", { temperature: 0.7 })).toEqual({
      temperature: 0.7
    });
  });
});
