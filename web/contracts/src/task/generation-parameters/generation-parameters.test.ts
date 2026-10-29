/**
 * 生成参数预设的契约测试。
 *
 * 钉住五条最容易被改坏的事实：
 * 1. 家族 schema **优先于**类型预设（家族知道厂商细节，预设不知道）；
 * 2. 剪枝真的会删键，且被删的键会出现在 `dropped` 里（诊断与界面都要用它）；
 * 3. 约束的生效值是 `min(部署级, 模型级)`，且 `capped` 能指出被谁截断；
 * 4. 约束会经 `capabilityFacts` 往返，前端只拿目录模型也能读到它；
 * 5. 卡片表按「类型 / 厂商 / 模型」组织，覆盖网关目录里常见的那些。
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRESET_CARDS,
  IMAGE_CARDS,
  MB,
  MODEL_TYPE_PRESETS,
  PANEL_OWNED_KEYS,
  PARAMETER_CONTROLS,
  VIDEO_CARDS,
  composePresetCard,
  effectiveModelLimits,
  presetCardsOf,
  presetLimitsOf,
  type PresetCard
} from "./index.js";
import { canvasModelCapabilities } from "../model-capabilities.js";
import { videoFamilyFor, videoPixelSize, videoRequestFields } from "../video-parameters.js";
import type { CanvasTaskCatalogModel } from "../dto.js";

/**
 * 参数表里会出现的键（与前端投影同口径）：去掉面板自己承载的 prompt 与素材数组，
 * 去掉 array / object 类型。这里只做**读 schema**，不复制投影逻辑之外的东西。
 */
function projectParameterKeys(model: CanvasTaskCatalogModel): string[] {
  const properties = model.inputSchema.properties as Record<string, Record<string, unknown>>;
  return Object.entries(properties)
    .filter(([key]) => !PANEL_OWNED_KEYS.includes(key))
    .filter(([, schema]) => schema.type !== "array" && schema.type !== "object")
    .map(([key]) => key)
    .sort();
}

function propertiesOf(model: CanvasTaskCatalogModel): Record<string, Record<string, unknown>> {
  return model.inputSchema.properties as Record<string, Record<string, unknown>>;
}

const DEPLOY = {
  promptMaxChars: 8000,
  totalReferences: 16,
  maxBytesPerItem: 32 * MB
};

function cardById(id: string): PresetCard {
  const card = BUILTIN_PRESET_CARDS.find((entry) => entry.id === id);
  if (card === undefined) throw new Error(`缺少卡片 ${id}`);
  return card;
}

/** 一张只在测试里存在的卡片：用来验证「下限」这条 `inputSchema` 表达不了的规则。 */
const MIN_REFERENCE_CARD: PresetCard = {
  id: "test-min-reference",
  title: "测试 · 至少一张参考图",
  providerId: "test",
  vendor: "generic",
  providerModelId: "veo-3.1-fast",
  docs: "https://ai.google.dev/gemini-api/docs/veo",
  modelType: "video",
  keeps: ["prompt", "referencesImage", "durationSeconds", "aspectRatio", "resolution"],
  limits: {
    promptMaxChars: 500,
    references: { image: { min: 1, max: 3, maxBytesPerItem: 8 * MB } }
  }
};

describe("参数最大集合", () => {
  it("每个控件的键唯一，且都能构造出带 type 的 schema", () => {
    const keys = PARAMETER_CONTROLS.map((control) => control.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const control of PARAMETER_CONTROLS) {
      expect(typeof control.build({}).type).toBe("string");
    }
  });

  it("类型预设引用的键都在最大集合里（防止预设引用不存在的控件）", () => {
    const known = new Set(PARAMETER_CONTROLS.map((control) => control.key));
    for (const preset of Object.values(MODEL_TYPE_PRESETS)) {
      for (const key of preset.keys) expect(known.has(key)).toBe(true);
    }
  });
});

describe("家族优先于类型预设", () => {
  it("Seedream 命中家族：没有 quality / background，只有 size 语义的比例与分辨率", () => {
    const { model, dropped } = composePresetCard(cardById("seedream-5.0-pro"));
    const properties = propertiesOf(model);
    expect(properties).toHaveProperty("aspectRatio");
    expect(properties).toHaveProperty("resolution");
    expect(properties).not.toHaveProperty("quality");
    expect(dropped).toContain("quality");
    expect(dropped).toContain("background");
  });

  it("GPT Image 命中家族：质量档位来自家族，而不是类型预设的 4 档", () => {
    const quality = propertiesOf(composePresetCard(cardById("gpt-image-2.5")).model).quality as {
      enum: Array<{ value: string }>;
    };
    expect(quality.enum.map((entry) => entry.value)).toContain("xhigh");
    expect(quality.enum.map((entry) => entry.value)).toContain("max");
  });

  it("视频家族决定时长步长：Veo 是 2 秒步长的 4–8", () => {
    const duration = propertiesOf(composePresetCard(cardById("veo")).model).durationSeconds as {
      minimum: number;
      maximum: number;
      step: number;
    };
    expect(duration).toMatchObject({ minimum: 4, maximum: 8, step: 2 });
  });

  it("视频家族决定分辨率档位：Seedance 2.5 有三档、Veo 只有两档", () => {
    const seedance = propertiesOf(composePresetCard(cardById("seedance-2.5")).model).resolution as {
      enum: Array<{ value: string }>;
    };
    expect(seedance.enum.map((entry) => entry.value)).toEqual(["480p", "720p", "1080p"]);

    const veo = propertiesOf(composePresetCard(cardById("veo")).model).resolution as {
      enum: Array<{ value: string }>;
    };
    expect(veo.enum.map((entry) => entry.value)).toEqual(["720p", "1080p"]);
  });

  it("未识别家族退回类型预设（通用卡片只有遗留的两个文本框）", () => {
    const { model } = composePresetCard(cardById("video-generic"));
    expect(projectParameterKeys(model)).toEqual(["seconds", "size"]);
  });
});

describe("剪枝", () => {
  it("Seedance 1.0 只保留图 / 时长 / 比例 / 分辨率", () => {
    const { model, dropped } = composePresetCard(cardById("seedance-1.0"));
    expect(projectParameterKeys(model)).toEqual(["aspectRatio", "durationSeconds", "resolution"]);
    expect(dropped).toContain("referencesVideo");
    expect(dropped).toContain("referencesAudio");
    expect(dropped).toContain("generationMode");
  });

  it("剪枝后的参考绑定只剩卡片保留的种类，且上限与约束一致", () => {
    const seedance1 = composePresetCard(cardById("seedance-1.0")).model;
    expect(seedance1.bindings.map((binding) => binding.semantic)).toEqual(["reference-image"]);
    // 卡片声明 `references.image.max = 2`：绑定的 maxItems 必须是同一个数字。
    expect(seedance1.bindings[0]?.maxItems).toBe(2);

    const seedance25 = composePresetCard(cardById("seedance-2.5")).model;
    expect(seedance25.bindings.map((binding) => binding.semantic).sort()).toEqual([
      "reference-audio",
      "reference-image",
      "reference-video"
    ]);
    // 声明 30 张，部署级上限 16：绑定取生效值。
    const image = seedance25.bindings.find((binding) => binding.semantic === "reference-image");
    expect(image?.maxItems).toBe(16);
  });

  it("卡片的联动隐藏叠加在家族 schema 上（家族定值域，卡片定隐藏）", () => {
    const duration = propertiesOf(composePresetCard(cardById("seedance-2.5")).model)
      .durationSeconds as { "x-hidden-when"?: unknown };
    expect(duration["x-hidden-when"]).toEqual([
      { field: "generationMode", equals: "edit_video" }
    ]);
  });
});

describe("约束", () => {
  it("生效值取 min(部署级, 模型级)，并标出被截断的项", () => {
    const effective = effectiveModelLimits(cardById("seedance-2.5").limits, DEPLOY)!;
    // 卡片声明 30，部署只给 16。
    expect(effective.references.image?.max).toBe(16);
    expect(effective.references.image?.capped).toBe(true);
    // 卡片声明 10，没被截断。
    expect(effective.references.video?.max).toBe(10);
    expect(effective.references.video?.capped).toBe(false);
    expect(effective.combined[0]?.max).toBe(30);
  });

  it("未声明约束的卡片返回 null（前端不展示任何提示）", () => {
    expect(effectiveModelLimits(undefined, DEPLOY)).toBeNull();
    expect(effectiveModelLimits(cardById("video-generic").limits, DEPLOY)).toBeNull();
  });

  it("下限能被读到：这是 inputSchema 表达不了的那条规则", () => {
    const { model } = composePresetCard(MIN_REFERENCE_CARD);
    expect(presetLimitsOf(model)?.references?.image?.min).toBe(1);
    expect(canvasModelCapabilities(model).limits?.references?.image?.min).toBe(1);
  });

  it("非法约束形状整块丢弃，不按错误数字禁用主操作", () => {
    const { model } = composePresetCard(MIN_REFERENCE_CARD);
    const broken = {
      ...model,
      capabilityFacts: { limits: { references: { image: { min: 3, max: 1, maxBytesPerItem: 10 } } } }
    };
    expect(canvasModelCapabilities(broken).limits).toBeUndefined();
  });
});

describe("卡片表", () => {
  it("modelKey 唯一，图片与视频各有卡片", () => {
    const keys = BUILTIN_PRESET_CARDS.map((card) => card.providerId + ":" + card.id);
    expect(new Set(keys).size).toBe(keys.length);
    expect(IMAGE_CARDS.length).toBeGreaterThan(0);
    expect(VIDEO_CARDS.length).toBeGreaterThan(0);
  });

  it("按类型筛选与总表一致", () => {
    expect(presetCardsOf(BUILTIN_PRESET_CARDS, "image")).toEqual(IMAGE_CARDS);
    expect(presetCardsOf(BUILTIN_PRESET_CARDS, "video")).toEqual(VIDEO_CARDS);
  });

  it("覆盖网关目录里常见的视频家族", () => {
    const families = new Set(
      VIDEO_CARDS.map((card) => videoFamilyFor(card.providerModelId)?.id).filter(
        (id): id is string => id !== undefined
      )
    );
    for (const expected of ["seedance-2.5", "seedance-2.0", "seedance-1.0", "veo", "minimax-h3"]) {
      expect(families).toContain(expected);
    }
  });

  it("覆盖网关目录里常见的图像家族", () => {
    const ids = IMAGE_CARDS.map((card) => card.providerModelId.toLowerCase());
    expect(ids.some((id) => id.includes("seedream"))).toBe(true);
    expect(ids.some((id) => id.includes("gpt-image"))).toBe(true);
    expect(ids.some((id) => id.includes("gemini"))).toBe(true);
    expect(ids.some((id) => id.includes("nanobanana") || id.includes("nano-banana"))).toBe(true);
  });

  it("每张卡片都声明了厂商与官方文档链接", () => {
    for (const card of BUILTIN_PRESET_CARDS) {
      expect(card.vendor).toBeTruthy();
      // 卡片里的档位与边界都是从这页抄下来的：没有链接就无法判断过期没有。
      expect(card.docs).toMatch(/^https:\/\//);
      const { model } = composePresetCard(card);
      expect(model.modelType).toBe(card.modelType);
      expect(typeof model.inputSchema.type).toBe("string");
    }
  });
});

describe("视频请求字段翻译", () => {
  it("时长按家族步长对齐（就近取整，正中间向上）", () => {
    // 4/6/8 三档：5 正好在中间，向上取 6；7 更靠近 8。
    expect(videoRequestFields("veo-3.1-fast", { durationSeconds: 5 }).seconds).toBe(6);
    expect(videoRequestFields("veo-3.1-fast", { durationSeconds: 7 }).seconds).toBe(8);
    expect(videoRequestFields("veo-3.1-fast", { durationSeconds: 4 }).seconds).toBe(4);
  });

  it("时长被夹进家族区间：Seedance 2.0 选 30 秒 → 15 秒", () => {
    expect(videoRequestFields("seedance-2", { durationSeconds: 30 }).seconds).toBe(15);
  });

  it("比例 + 分辨率收敛成像素 size（偶数边）", () => {
    expect(videoPixelSize("16:9", "720p")).toBe("1280x720");
    expect(videoPixelSize("9:16", "720p")).toBe("720x1280");
    expect(videoRequestFields("seedance-2", { aspectRatio: "16:9", resolution: "720p" }).size).toBe(
      "1280x720"
    );
  });

  it("自适应比例不发 size，交给上游按提示词决定", () => {
    const fields = videoRequestFields("seedance-2", { aspectRatio: "adaptive", resolution: "720p" });
    expect(fields.size).toBeUndefined();
    expect(fields.seconds).toBe(5);
  });

  it("只发上游认识的字段：面板参数里的多余键不会透传", () => {
    const fields = videoRequestFields("seedance-2", {
      durationSeconds: 8,
      aspectRatio: "1:1",
      resolution: "1080p",
      generationMode: "omni_reference",
      seed: 42
    });
    expect(Object.keys(fields).sort()).toEqual(["seconds", "size"]);
  });

  it("未识别家族原样透传（服务端最了解自己的上游）", () => {
    expect(videoRequestFields("some-unknown-video", { seconds: "4", size: "1280x720" })).toEqual({
      seconds: "4",
      size: "1280x720"
    });
  });
});
