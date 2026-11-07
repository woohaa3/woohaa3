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
  AUDIO_CARDS,
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
import { ALIBABA_CARDS, alibabaSizePresetFor } from "./cards/image/alibaba/alibaba-cards.js";
import { seedreamSizePresetFor } from "./cards/image/ark/seedream-cards.js";
import { seedreamSupportsTransparentBackground } from "./cards/image/ark/seedream-spec.js";
import { videoFamilyFor, videoFamilyParameters, videoPixelSize, videoRequestFields } from "../video-parameters.js";
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
  it("Seedream 命中家族：比例 / 分辨率 / 透明背景来自家族，没有 quality 与 n", () => {
    const { model, dropped } = composePresetCard(cardById("seedream-5.0-pro"));
    const properties = propertiesOf(model);
    expect(properties).toHaveProperty("aspectRatio");
    expect(properties).toHaveProperty("resolution");
    expect(properties).not.toHaveProperty("quality");
    expect(dropped).toContain("quality");
    expect(dropped).toContain("n");
    // 透明背景的值域由家族给出：opaque（默认）/ transparent，没有类型预设的 auto。
    const background = properties.background as { default?: string; enum: Array<{ value: string }> };
    expect(background.default).toBe("opaque");
    expect(background.enum.map((entry) => entry.value)).toEqual(["opaque", "transparent"]);
  });

  it("百炼命中家族：比例 / 分辨率 / 负向提示词 / 智能改写来自卡片投影", () => {
    const { model, dropped } = composePresetCard(cardById("qwen-image-2.0-pro"));
    const properties = propertiesOf(model);
    expect(properties).toHaveProperty("negativePrompt");
    expect(properties).toHaveProperty("promptExtend");
    // 百炼没有质量、数量、背景与输出格式这几档：类型预设里的键被剪掉。
    for (const key of ["quality", "n", "background", "outputFormat"]) {
      expect(properties, key).not.toHaveProperty(key);
      expect(dropped, key).toContain(key);
    }
    // 比例不带「自适应」：百炼必须落到具体像素。
    const aspectRatio = properties.aspectRatio as { enum: Array<{ value: string }> };
    expect(aspectRatio.enum.map((entry) => entry.value)).not.toContain("auto");
    expect(model.defaultInput).toMatchObject({
      aspectRatio: "1:1",
      resolution: "2K",
      negativePrompt: "",
      promptExtend: true
    });
  });

  it("百炼的智能改写默认值来自卡片：Z-Image 默认关，Qwen 默认开", () => {
    const zImage = propertiesOf(composePresetCard(cardById("z-image-turbo")).model);
    expect(zImage.promptExtend).toMatchObject({ default: false });
    expect(composePresetCard(cardById("z-image-turbo")).model.defaultInput)
      .toMatchObject({ promptExtend: false });
    // Z-Image 只能文生图：卡片不保参考图，面板不会出现上传。
    expect(zImage).not.toHaveProperty("referencesImage");

    for (const id of ["qwen-image-2.0", "qwen-image-2.1-pro", "qwen-image-3.0-pro"]) {
      expect(propertiesOf(composePresetCard(cardById(id)).model).promptExtend, id)
        .toMatchObject({ default: true });
    }
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

describe("音频卡片", () => {
  it("TTS 把音色 / 格式 / 语速收窄到官方值域", () => {
    const { model, dropped } = composePresetCard(cardById("tts-1"));
    const properties = propertiesOf(model);

    expect(dropped).toEqual([]);
    expect(Object.keys(properties).sort()).toEqual(["outputFormat", "prompt", "speed", "voice"]);

    const voice = properties.voice as { enum: Array<{ value: string }>; default?: string };
    expect(voice.default).toBe("alloy");
    expect(voice.enum.map((entry) => entry.value)).toHaveLength(9);
    expect(voice.enum.map((entry) => entry.value)).toContain("alloy");

    const format = properties.outputFormat as { enum: Array<{ value: string }> };
    expect(format.enum.map((entry) => entry.value)).toEqual([
      "mp3",
      "opus",
      "aac",
      "flac",
      "wav",
      "pcm"
    ]);

    // 语速是连续数值，不是枚举：滑块的步长来自类型预设，区间也写在预设里。
    expect(properties.speed).toMatchObject({ minimum: 0.25, maximum: 4, default: 1, step: 0.05 });
    expect(presetLimitsOf(model)?.promptMaxChars).toBe(4096);
    // 约束经 capabilityFacts 往返后仍然可读（前端只拿目录模型也能读到）。
    expect(canvasModelCapabilities(model).limits?.promptMaxChars).toBe(4096);
  });

  it("MiniMax 收窄语速与格式，并列出常用系统音色", () => {
    const { model } = composePresetCard(cardById("minimax-speech-2.8-hd"));
    const properties = propertiesOf(model);

    expect(properties.speed).toMatchObject({ minimum: 0.5, maximum: 2, default: 1 });
    const format = properties.outputFormat as { enum: Array<{ value: string }> };
    expect(format.enum.map((entry) => entry.value)).toEqual(["mp3", "pcm", "flac", "wav", "opus"]);

    // 音色是上游闭集：值用系统音色 id，label 用人读名称，默认取官方示例音色。
    const voice = properties.voice as {
      default?: string;
      "x-pptask-control"?: string;
      enum: Array<{ value: string; label: string }>;
    };
    expect(voice.default).toBe("male-qn-qingse");
    expect(voice.enum).toHaveLength(22);
    expect(voice.enum.find((entry) => entry.value === "male-qn-qingse")?.label).toContain("青涩");
    expect(voice.enum.some((entry) => entry.value === "English_expressive_narrator")).toBe(true);
    expect(voice["x-pptask-control"]).toBe("voice");
  });

  it("通用音频没有家族也没有约束：音色自由文本、格式只有服务端那三档", () => {
    const { model } = composePresetCard(cardById("audio-generic"));
    const properties = propertiesOf(model);

    const voice = properties.voice as { enum?: unknown };
    expect(voice.enum).toBeUndefined();
    const format = properties.outputFormat as { enum: Array<{ value: string }> };
    expect(format.enum.map((entry) => entry.value)).toEqual(["mp3", "wav", "opus"]);
    expect(presetLimitsOf(model)).toBeUndefined();
  });
});

describe("Agnes Video 2.5 参数描述", () => {
  /**
   * 现场失败：`aspectRatio is required`、`resolution is required`、
   * 时长必须大于 4 秒且不超过 12 秒。卡片与家族必须同时给出默认值、允许值与必填。
   */
  it("比例 / 分辨率 / 时长都是必填，并带合法默认值", () => {
    const { model } = composePresetCard(cardById("agnes-video-2.5"));
    const properties = propertiesOf(model);

    expect(model.inputSchema.required).toEqual(
      expect.arrayContaining(["prompt", "aspectRatio", "resolution", "durationSeconds"])
    );
    expect(properties.resolution).toMatchObject({ default: "720p" });
    expect((properties.resolution as { enum: Array<{ value: string }> }).enum.map((entry) => entry.value))
      .toEqual(["720p", "1080p", "2k"]);
    expect(properties.durationSeconds).toMatchObject({ minimum: 5, maximum: 12, default: 5, step: 1 });
    expect(properties.aspectRatio).toMatchObject({ default: "16:9" });
    expect(model.defaultInput).toMatchObject({
      aspectRatio: "16:9",
      resolution: "720p",
      durationSeconds: 5
    });
  });

  it("未拿到卡片、只按家族识别时也保留必填声明", () => {
    const family = videoFamilyParameters("agnes-video-2.5");
    expect(family?.required).toEqual(["aspectRatio", "resolution", "durationSeconds"]);
    expect(family?.defaults).toMatchObject({ aspectRatio: "16:9", resolution: "720p", durationSeconds: 5 });
  });

  it("2k 能换算成偶数像素尺寸", () => {
    expect(videoPixelSize("16:9", "2k")).toBe("2560x1440");
  });

  it("请求保留上游要求的角度比例字段与档位 size", () => {
    expect(
      videoRequestFields("agnes-video-2.5", {
        aspectRatio: "16:9",
        resolution: "720p",
        durationSeconds: 5
      })
    ).toEqual({ seconds: 5, aspect_ratio: "16:9", size: "720P" });
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
  it("modelKey 唯一，图片 / 视频 / 音频各有卡片", () => {
    const keys = BUILTIN_PRESET_CARDS.map((card) => card.providerId + ":" + card.id);
    expect(new Set(keys).size).toBe(keys.length);
    expect(IMAGE_CARDS.length).toBeGreaterThan(0);
    expect(VIDEO_CARDS.length).toBeGreaterThan(0);
    expect(AUDIO_CARDS.length).toBeGreaterThan(0);
  });

  it("按类型筛选与总表一致", () => {
    expect(presetCardsOf(BUILTIN_PRESET_CARDS, "image")).toEqual(IMAGE_CARDS);
    expect(presetCardsOf(BUILTIN_PRESET_CARDS, "video")).toEqual(VIDEO_CARDS);
    expect(presetCardsOf(BUILTIN_PRESET_CARDS, "audio")).toEqual(AUDIO_CARDS);
  });

  it("覆盖网关目录里常见的音频模型", () => {
    const ids = AUDIO_CARDS.map((card) => card.providerModelId.toLowerCase());
    expect(ids).toContain("tts-1");
    expect(ids.some((id) => id.includes("minimax-speech"))).toBe(true);
    expect(ids.some((id) => id.includes("audio-generic"))).toBe(true);
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

  it("覆盖百炼已登记的生图型号（万相 / Qwen-Image / Z-Image）", () => {
    const ids = ALIBABA_CARDS.map((card) => card.providerModelId);
    expect(ids).toEqual([
      "wan2.7-image-pro",
      "wan2.7-image",
      "qwen-image-3.0-pro",
      "qwen-image-2.1-pro",
      "qwen-image-2.1-turbo",
      "qwen-image-2.0-pro",
      "qwen-image-2.0",
      "z-image-turbo"
    ]);
    // 每个型号都能查到像素表：未登记的 id 会让 Provider 发出上游不认的 size。
    for (const card of ALIBABA_CARDS) {
      const spec = alibabaSizePresetFor(card.providerModelId)!;
      for (const ratio of spec.aspectRatios) {
        for (const tier of spec.resolutions) {
          expect(spec.sizes[ratio]?.[tier], `${card.id} ${ratio} ${tier}`).toMatch(/^\d+\*\d+$/);
        }
      }
    }
  });

  it("卡片的 cap 声明与版本表一致：保留 background 的即梦模型必须真的支持透明", () => {
    // 两处各自表达「谁支持透明」——卡片说「接不接这个键」，版本表说「这个版本有没有」。
    // 对不上时 compose 会悄悄退回类型预设的 auto/transparent/opaque，所以在这里钉住。
    for (const card of IMAGE_CARDS.filter((entry) => entry.vendor === "ark")) {
      const preset = seedreamSizePresetFor(card.providerModelId);
      expect(preset, card.id).toBeDefined();
      expect(card.keeps.includes("background"), card.id).toBe(
        seedreamSupportsTransparentBackground(preset!)
      );
    }
  });

  it("百炼卡片的 keeps 与卡片能力一致：不支持的开关不出现", () => {
    // 与即梦的 transparent 那条同一个道理：卡片说「接不接这个键」，厂商块说「这个模型有没有」。
    for (const card of ALIBABA_CARDS) {
      const spec = alibabaSizePresetFor(card.providerModelId);
      expect(spec, card.id).toBeDefined();
      expect(card.keeps.includes("negativePrompt"), card.id).toBe(spec!.supportsNegativePrompt);
      expect(card.keeps.includes("promptExtend"), card.id).toBe(spec!.supportsPromptExtend);
      expect(card.keeps.includes("referencesImage"), card.id).toBe(spec!.maxReferenceImages > 0);
      expect(card.vendor).toBe("alibaba");
      // 参考图上限只存一份：卡片的 limits 就是 spec 的 maxReferenceImages。
      expect(card.limits?.references?.image?.max ?? 0).toBe(spec!.maxReferenceImages);
    }
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
