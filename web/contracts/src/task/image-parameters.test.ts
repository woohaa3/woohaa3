/**
 * 图像参数家族与请求字段映射的契约测试（共享实现）。
 *
 * 这份实现同时服务本地插件（extensions/litellm-provider）与远端托管生成
 * （web/extensions/remote-server）。放在这里钉住三条最容易被改坏的事实：
 * 家族判定顺序、面板 schema 的控件语义、以及语义参数到上游字段的翻译。
 */
import { describe, expect, it } from "vitest";
import { imageFamilyParameters, imageParameterFamily, imageRequestFields } from "./image-parameters.js";

describe("imageParameterFamily", () => {
  it("即梦全家（含别名/前缀）先于其它关键字命中", () => {
    expect(imageParameterFamily("seedream-5-pro")).toBe("seedream");
    expect(imageParameterFamily("doubao-seedream-5.0-pro")).toBe("seedream");
    expect(imageParameterFamily("seedream-image-5-lite")).toBe("seedream");
    // 带日期后缀的前缀匹配
    expect(imageParameterFamily("seedream-4-0-250828")).toBe("seedream");
  });

  it("百炼模型按卡片精确命中（不做关键字猜）", () => {
    expect(imageParameterFamily("qwen-image-2.0-pro")).toBe("bailian");
    expect(imageParameterFamily("wan2.7-image-pro")).toBe("bailian");
    expect(imageParameterFamily("z-image-turbo")).toBe("bailian");
    // 未登记的百炼同名系列不吃家族兜底：猜错代际会给出另一个版本的参数能力。
    expect(imageParameterFamily("qwen-image-9.9-pro")).toBe("generic");
    expect(imageParameterFamily("wan9.9-image")).toBe("generic");
  });

  it("gemini / gpt-image / generic 分类", () => {
    expect(imageParameterFamily("gemini-3.1-flash-image")).toBe("gemini");
    expect(imageParameterFamily("nano-banana-pro")).toBe("gemini");
    expect(imageParameterFamily("gpt-image-1.5")).toBe("gpt-image");
    expect(imageParameterFamily("dall-e-3")).toBe("generic");
    expect(imageParameterFamily("some-unknown-model")).toBe("generic");
  });
});

describe("imageFamilyParameters", () => {
  it("seedream 给比例、分辨率与透明背景，且分辨率默认 2K", () => {
    const family = imageFamilyParameters("seedream-5-pro")!;
    expect(Object.keys(family.properties).sort()).toEqual(["aspectRatio", "background", "resolution"]);
    expect(family.defaults).toEqual({ resolution: "2K", aspectRatio: "auto", background: "opaque" });
    // 即梦没有 aspect_ratio / quality 参数，不能声明出来。
    expect(family.properties).not.toHaveProperty("quality");
    expect(family.properties).not.toHaveProperty("n");
  });

  it("透明背景只在 5.0 pro / flash 上，且「透明」联动 PNG 输出", () => {
    const background = imageFamilyParameters("seedream-5-pro")!.properties.background as {
      enum: Array<{ value: string; label: string; "x-pptask-requires"?: Record<string, unknown> }>;
    };
    // 即梦认 opaque 而不是 OpenAI 的 auto：面板不给「自动」这一档。
    expect(background.enum.map((entry) => entry.value)).toEqual(["opaque", "transparent"]);
    expect(background.enum[0]?.label).toBe("不透明");
    expect(background.enum[1]?.["x-pptask-requires"]).toEqual({ outputFormat: "png" });

    expect(imageFamilyParameters("seedream-5-flash")!.properties).toHaveProperty("background");
    // lite / 4.5 / 4.0 官方不支持透明通道：面板不能出现这个控件。
    for (const id of ["seedream-5-lite", "seedream-4.5", "seedream-4.0"]) {
      expect(imageFamilyParameters(id)!.properties).not.toHaveProperty("background");
    }
  });

  it("seedream 网关档位收窄：5.0 pro 只给 1K / 2K，flash 保留 1.5K", () => {
    const pro = imageFamilyParameters("seedream-5-pro")!;
    const proResolution = pro.properties.resolution as { enum: Array<{ value: string }> };
    expect(proResolution.enum.map((item) => item.value)).toEqual(["1K", "2K"]);

    const flash = imageFamilyParameters("seedream-5-flash")!;
    const flashResolution = flash.properties.resolution as { enum: Array<{ value: string }> };
    expect(flashResolution.enum.map((item) => item.value)).toEqual(["1K", "1.5K", "2K"]);
  });

  it("gemini 与 gpt-image 的默认值/取值域随模型代际变化", () => {
    const gemini = imageFamilyParameters("gemini-2.5-flash-image")!;
    expect(gemini.defaults.resolution).toBe("1K");

    const gpt = imageFamilyParameters("gpt-image-2.5")!;
    expect(gpt.defaults.quality).toBe("auto");
    expect(gpt.properties).toHaveProperty("n");
  });

  it("generic 返回 null（调用方保持既有 OpenAI schema）", () => {
    expect(imageFamilyParameters("some-unknown-model")).toBeNull();
  });

  it("bailian：比例 + 分辨率，负向提示词与智能改写按模型给", () => {
    const qwen20 = imageFamilyParameters("qwen-image-2.0-pro")!;
    expect(qwen20.schemaVersion).toBe("bailian-image/v1");
    expect(Object.keys(qwen20.properties).sort())
      .toEqual(["aspectRatio", "negativePrompt", "promptExtend", "resolution"]);
    expect(qwen20.defaults).toEqual({
      aspectRatio: "1:1",
      resolution: "2K",
      negativePrompt: "",
      promptExtend: true,
    });
    // 百炼不接受「自适应画幅」：比例必须落到具体像素。
    const aspectRatio = qwen20.properties.aspectRatio as { enum: Array<{ value: string }> };
    expect(aspectRatio.enum.map((entry) => entry.value))
      .toEqual(["1:1", "16:9", "9:16", "4:3", "3:4"]);

    // 2.1 / 3.0 没有 negative_prompt（文档只给 prompt_extend）。
    for (const id of ["qwen-image-3.0-pro", "qwen-image-2.1-pro", "qwen-image-2.1-turbo"]) {
      expect(imageFamilyParameters(id)!.properties).not.toHaveProperty("negativePrompt");
      expect(imageFamilyParameters(id)!.properties).toHaveProperty("promptExtend");
    }
    // 万相两个都没有（提质走 thinking_mode，不暴露）。
    const wan = imageFamilyParameters("wan2.7-image-pro")!;
    expect(wan.properties).not.toHaveProperty("negativePrompt");
    expect(wan.properties).not.toHaveProperty("promptExtend");
    expect(wan.defaults).toEqual({ aspectRatio: "1:1", resolution: "2K" });
  });

  it("bailian：档位随模型收窄，z-image 的智能改写默认关", () => {
    const tiers = (id: string) =>
      (imageFamilyParameters(id)!.properties.resolution as { enum: Array<{ value: string }> })
        .enum.map((entry) => entry.value);
    expect(tiers("wan2.7-image-pro")).toEqual(["1K", "2K", "4K"]);
    expect(tiers("wan2.7-image")).toEqual(["1K", "2K"]);
    expect(tiers("z-image-turbo")).toEqual(["1K"]);

    // Z-Image 只能文生图：参考图上限 0，卡片不保 referencesImage。
    const zImage = imageFamilyParameters("z-image-turbo")!;
    expect(zImage.maxReferenceImages).toBe(0);
    expect(zImage.defaults.promptExtend).toBe(false);
  });
});

describe("imageRequestFields", () => {
  it("seedream 查官方像素表；自适应只发档位", () => {
    expect(imageRequestFields("seedream-5-pro", { resolution: "2K", aspectRatio: "16:9" }))
      .toEqual({ size: "2848x1600" });
    // flash 的 1.5K 档位官方支持，自适应时原样下发。
    expect(imageRequestFields("seedream-5-flash", { resolution: "1.5K", aspectRatio: "auto" }))
      .toEqual({ size: "1.5K" });
  });

  it("seedream 网关不认的档位按默认档收敛（5.0 pro 的 1.5K 变 2K）", () => {
    // 旧草稿里可能残留 1.5K：网关只放行 1K / 2K，发出去会被上游 400，这里收敛到默认 2K。
    expect(imageRequestFields("seedream-5-pro", { resolution: "1.5K", aspectRatio: "auto" }))
      .toEqual({ size: "2K" });
    expect(imageRequestFields("seedream-5-pro", { resolution: "1.5K", aspectRatio: "16:9" }))
      .toEqual({ size: "2848x1600" });
  });

  it("seedream 透明背景下发 background，并把格式补成 PNG", () => {
    // 官方：透明只在 pro / flash 上有效，且配 output_format=jpeg 会被上游拒绝。
    // 面板会联动切格式，旧草稿 / 批处理绕过面板时由这里兜底。
    expect(imageRequestFields("seedream-5-pro", {
      resolution: "2K",
      aspectRatio: "1:1",
      background: "transparent",
      outputFormat: "jpeg"
    })).toEqual({ size: "2048x2048", background: "transparent", output_format: "png" });
    expect(imageRequestFields("seedream-5-flash", { background: "transparent" }))
      .toEqual({ size: "2K", background: "transparent", output_format: "png" });
    // 不透明是官方默认值：不额外下发，请求形状保持原样。
    expect(imageRequestFields("seedream-5-pro", { background: "opaque" })).toEqual({ size: "2K" });
    // lite / 4.5 没有这个参数，选了也不能发出去。
    expect(imageRequestFields("seedream-5-lite", { background: "transparent" })).toEqual({ size: "2K" });
  });

  it("gemini 发 flat 字段，自适应不下发比例", () => {
    expect(imageRequestFields("gemini-3.1-flash-image", { resolution: "2K", aspectRatio: "16:9" }))
      .toEqual({ aspect_ratio: "16:9", image_size: "2K" });
    expect(imageRequestFields("gemini-3.1-flash-image", { resolution: "2K", aspectRatio: "auto" }))
      .toEqual({ image_size: "2K" });
  });

  it("透明背景强制 PNG：非 png 的旧草稿被提升，JPEG 专属压缩被丢掉", () => {
    // 面板会联动切格式，但旧草稿/批处理可能绕过面板。这里做最后一道保护：
    // 用户要的是透明，悄悄退回不透明会让他看到一张带底色的图。
    expect(imageRequestFields("gpt-image-1", { background: "transparent", outputFormat: "jpeg" }))
      .toMatchObject({ background: "transparent", output_format: "png" });
    const withCompression = imageRequestFields("gpt-image-1", {
      background: "transparent",
      outputFormat: "jpeg",
      outputCompression: 80
    });
    expect(withCompression.output_format).toBe("png");
    expect(withCompression.output_compression).toBeUndefined();
    // 已经是 png 时不改动。
    expect(imageRequestFields("gpt-image-1", { background: "transparent", outputFormat: "png" }).output_format)
      .toBe("png");
  });

  it("bailian 发 `宽*高`（星号），并固定 watermark=false", () => {
    expect(imageRequestFields("qwen-image-2.0-pro", { aspectRatio: "16:9", resolution: "2K" }))
      .toEqual({ size: "2688*1536", watermark: false, prompt_extend: true });
    // 负向提示词按模型上限截断；智能改写按模型默认值补齐。
    expect(imageRequestFields("qwen-image-2.0-pro", {
      aspectRatio: "1:1",
      resolution: "2K",
      negativePrompt: "低清",
      promptExtend: false,
    })).toEqual({ size: "2048*2048", watermark: false, negative_prompt: "低清", prompt_extend: false });
    // 万相不认这两个开关：即使旧草稿里带着也不能发出去。
    expect(imageRequestFields("wan2.7-image-pro", {
      aspectRatio: "1:1",
      resolution: "4K",
      negativePrompt: "低清",
      promptExtend: true,
    })).toEqual({ size: "4096*4096", watermark: false });
  });

  it("bailian 未知比例/档位回落到模型自己的 fallbackSize", () => {
    // 百炼不认档位串，所以任何组合都必须落到具体像素。
    expect(imageRequestFields("qwen-image-2.0-pro", { aspectRatio: "21:9", resolution: "2K" }))
      .toEqual({ size: "2048*2048", watermark: false, prompt_extend: true });
    expect(imageRequestFields("z-image-turbo", { aspectRatio: "2:3", resolution: "1K" }))
      .toEqual({ size: "1024*1536", watermark: false, prompt_extend: false });
  });

  it("gpt-image 比例+档位查成像素值；自适应发 auto", () => {
    expect(imageRequestFields("gpt-image-1", { resolution: "1K", aspectRatio: "16:9" }).size)
      .toBe("1536x864");
    expect(imageRequestFields("gpt-image-1", { aspectRatio: "auto" }).size).toBe("auto");
  });
});
