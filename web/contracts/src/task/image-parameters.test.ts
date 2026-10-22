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

  it("gemini / gpt-image / generic 分类", () => {
    expect(imageParameterFamily("gemini-3.1-flash-image")).toBe("gemini");
    expect(imageParameterFamily("nano-banana-pro")).toBe("gemini");
    expect(imageParameterFamily("gpt-image-1.5")).toBe("gpt-image");
    expect(imageParameterFamily("dall-e-3")).toBe("generic");
    expect(imageParameterFamily("some-unknown-model")).toBe("generic");
  });
});

describe("imageFamilyParameters", () => {
  it("seedream 只给比例与分辨率，且分辨率默认 2K", () => {
    const family = imageFamilyParameters("seedream-5-pro")!;
    expect(Object.keys(family.properties).sort()).toEqual(["aspectRatio", "resolution"]);
    expect(family.defaults).toEqual({ resolution: "2K", aspectRatio: "auto" });
    // 即梦没有 aspect_ratio / quality 参数，不能声明出来。
    expect(family.properties).not.toHaveProperty("quality");
    expect(family.properties).not.toHaveProperty("n");
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
});

describe("imageRequestFields", () => {
  it("seedream 查官方像素表；自适应只发档位", () => {
    expect(imageRequestFields("seedream-5-pro", { resolution: "2K", aspectRatio: "16:9" }))
      .toEqual({ size: "2848x1600" });
    expect(imageRequestFields("seedream-5-pro", { resolution: "1.5K", aspectRatio: "auto" }))
      .toEqual({ size: "1.5K" });
  });

  it("gemini 发 flat 字段，自适应不下发比例", () => {
    expect(imageRequestFields("gemini-3.1-flash-image", { resolution: "2K", aspectRatio: "16:9" }))
      .toEqual({ aspect_ratio: "16:9", image_size: "2K" });
    expect(imageRequestFields("gemini-3.1-flash-image", { resolution: "2K", aspectRatio: "auto" }))
      .toEqual({ image_size: "2K" });
  });

  it("gpt-image 比例+档位查成像素值；自适应发 auto", () => {
    expect(imageRequestFields("gpt-image-1", { resolution: "1K", aspectRatio: "16:9" }).size)
      .toBe("1536x864");
    expect(imageRequestFields("gpt-image-1", { aspectRatio: "auto" }).size).toBe("auto");
  });
});
