/**
 * 远端图像模型的家族适配测试（Provider 侧）。
 *
 * 锁住责任边界：**模型家族判定在扩展，不在 server**。server 只转述 LiteLLM 的目录；
 * 扩展用 `@woohaa3/contracts` 里的共享实现覆盖 schema 并把语义参数翻译成上游字段。
 *
 * 两个断言点分别对应报障现象的两半：
 * 1. 目录 —— seedream-5-pro 必须出「图片比例 + 图片分辨率」，而不是服务端那份通用
 *    `{"size": "1024x1024"}`；
 * 2. 提交 —— 面板语义必须落成即梦唯一认识的 `size` 像素值，否则用户选了尺寸也不生效。
 */
import { describe, expect, it } from "vitest";
import type { GenerationModelDefinition } from "@woohaa3/contracts";
import {
  translateImageParameters,
  withImageParameterFamily
} from "../src/backend/generation/image-models.js";

/** 服务端为任意图像模型下发的那份通用 schema（修复前 seedream 看到的就是它）。 */
function serverGenericImageModel(providerModelId: string): GenerationModelDefinition {
  return {
    providerId: "remote-server",
    providerModelId,
    modelType: "image",
    title: providerModelId,
    inputSchema: {
      type: "object",
      properties: { size: { type: "string", title: "尺寸", default: "1024x1024" } }
    },
    defaultInput: { size: "1024x1024" },
    interaction: { id: "generic-model", version: 1 },
    cancel: "remote",
    promptRequirement: "required",
    taskTimeoutMs: 300000
  };
}

describe("withImageParameterFamily", () => {
  it("seedream-5-pro 拿到「图片比例 + 图片分辨率」，默认 2K 自适应", () => {
    const model = withImageParameterFamily(serverGenericImageModel("seedream-5-pro"));
    const properties = model.inputSchema!.properties as Record<string, Record<string, unknown>>;

    expect(Object.keys(properties).sort()).toEqual(["aspectRatio", "resolution"]);
    expect(properties.resolution!["x-pptask-control"]).toBe("resolution");
    expect(properties.aspectRatio!["x-pptask-control"]).toBe("aspect-ratio");
    // 服务端那份裸像素 size 必须被完全替换掉。
    expect(properties.size).toBeUndefined();
    expect(model.defaultInput).toEqual({ resolution: "2K", aspectRatio: "auto" });
  });

  it("比例项的「自适应」带 x-pptask-adaptive 标记", () => {
    const model = withImageParameterFamily(serverGenericImageModel("seedream-5-pro"));
    const properties = model.inputSchema!.properties as Record<string, Record<string, unknown>>;
    const options = properties.aspectRatio!.enum as Array<Record<string, unknown>>;
    expect(options.some((option) => option.value === "auto" && option["x-pptask-adaptive"] === true)).toBe(true);
    // 即梦没有 quality / n。
    expect(properties.quality).toBeUndefined();
    expect(properties.n).toBeUndefined();
  });

  it("gpt-image 保留 quality / n", () => {
    const model = withImageParameterFamily(serverGenericImageModel("gpt-image-1"));
    const properties = model.inputSchema!.properties as Record<string, unknown>;
    expect(properties.quality).toBeDefined();
    expect(properties.n).toBeDefined();
  });

  it("未识别家族保持服务端 schema 不动", () => {
    const original = serverGenericImageModel("some-vendor-image-v2");
    const model = withImageParameterFamily(original);
    // 未知家族不猜能力：服务端的自描述比按名字编一份更安全。
    expect(model).toBe(original);
    expect(model.inputSchema).toEqual(original.inputSchema);
  });

  it("非图像模型不受影响", () => {
    const language: GenerationModelDefinition = {
      ...serverGenericImageModel("some-chat-model"),
      modelType: "language",
      inputSchema: { type: "object", properties: {} },
      defaultInput: {}
    };
    expect(withImageParameterFamily(language)).toBe(language);
  });
});

describe("translateImageParameters", () => {
  it("seedream：比例 + 档位查成官方像素 size", () => {
    expect(translateImageParameters("seedream-5-pro", { resolution: "2K", aspectRatio: "16:9" }))
      .toEqual({ size: "2848x1600" });
  });

  it("seedream：自适应只发档位，宽高比交给模型", () => {
    expect(translateImageParameters("seedream-5-pro", { resolution: "1K", aspectRatio: "auto" }))
      .toEqual({ size: "1K" });
  });

  it("seedream：不泄漏语义键，也不带 quality/n", () => {
    const fields = translateImageParameters("seedream-5-pro", { resolution: "2K", aspectRatio: "1:1" });
    for (const forbidden of ["resolution", "aspectRatio", "quality", "n"]) {
      expect(fields).not.toHaveProperty(forbidden);
    }
  });

  it("gemini：落成 flat 的 aspect_ratio + image_size", () => {
    expect(translateImageParameters("gemini-3.1-flash-image", { resolution: "2K", aspectRatio: "16:9" }))
      .toEqual({ aspect_ratio: "16:9", image_size: "2K" });
  });

  it("gpt-image：落成像素 size", () => {
    const fields = translateImageParameters("gpt-image-1", { resolution: "1K", aspectRatio: "3:2", quality: "high" });
    expect(fields.size).toBe("1536x1024");
    expect(fields.quality).toBe("high");
  });

  it("未识别家族原样透传（服务端转发给上游的就是这些字段）", () => {
    const parameters = { size: "1024x1024", seed: 7 };
    expect(translateImageParameters("some-vendor-image-v2", parameters)).toEqual(parameters);
  });
});
