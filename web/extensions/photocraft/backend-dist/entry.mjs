import { createRequire as __woohaaCreateRequire } from "node:module"; const require = __woohaaCreateRequire(import.meta.url);

// src/backend.ts
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";

// ../../../../client/web/contracts/src/validation.ts
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isBoundedId(value, maxLength = 200) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// ../../../../client/web/contracts/src/task/dto.ts
var DEFAULT_TASK_TIMEOUT_MS = {
  language: 2 * 6e4,
  image: 8 * 6e4,
  audio: 8 * 6e4,
  video: 20 * 6e4
};
var DEFAULT_HTTP_CALL_TIMEOUT_MS = Math.max(...Object.values(DEFAULT_TASK_TIMEOUT_MS));
var CANVAS_TASK_LIMITS = {
  promptMaxChars: 8e3,
  maxReferences: 16,
  maxTextOutputChars: 2e5,
  maxImageOutputBytes: 32 * 1024 * 1024,
  maxAudioOutputBytes: 64 * 1024 * 1024,
  maxVideoOutputBytes: 256 * 1024 * 1024,
  referenceUrlTtlSeconds: 900
};
var NODE_TYPE_TO_TASK_KIND = {
  image: "image-generation",
  text: "text-generation",
  video: "video-generation",
  audio: "audio-generation"
};
var REFERENCE_IMAGE_SEMANTIC = "reference-image";
var REFERENCE_VIDEO_SEMANTIC = "reference-video";
var REFERENCE_AUDIO_SEMANTIC = "reference-audio";
var SEMANTIC_TO_MEDIA_KIND = {
  [REFERENCE_IMAGE_SEMANTIC]: "image",
  [REFERENCE_VIDEO_SEMANTIC]: "video",
  [REFERENCE_AUDIO_SEMANTIC]: "audio"
};

// ../../../../client/web/contracts/src/task/parameter-schema.ts
var PPTASK_PARAMETER_CONTROL = "x-pptask-control";
var PPTASK_PARAMETER_ADAPTIVE = "x-pptask-adaptive";
var PPTASK_PARAMETER_REQUIRES = "x-pptask-requires";
var ADAPTIVE_PARAMETER_VALUE = "auto";
var ADAPTIVE_PARAMETER_LABEL = "\u81EA\u9002\u5E94";
function semanticSelectField(options) {
  const adaptive = normalizeAdaptive(options.adaptive);
  const enumValues2 = [
    ...adaptive ? [{ ...adaptive, [PPTASK_PARAMETER_ADAPTIVE]: true }] : [],
    ...options.options.map(
      (entry) => typeof entry === "string" ? { value: entry, label: entry } : {
        value: entry.value,
        label: entry.label,
        ...entry.requires !== void 0 ? { [PPTASK_PARAMETER_REQUIRES]: entry.requires } : {}
      }
    )
  ];
  return {
    type: "string",
    title: options.title,
    ...options.fallback !== void 0 ? { default: options.fallback } : {},
    "x-component": "Select",
    [PPTASK_PARAMETER_CONTROL]: options.control,
    enum: enumValues2,
    ...options.hiddenWhen && options.hiddenWhen.length > 0 ? { "x-hidden-when": options.hiddenWhen.map((rule) => ({ ...rule })) } : {}
  };
}
function aspectRatioField(options) {
  return semanticSelectField({
    control: "aspect-ratio",
    title: options.title ?? "\u6BD4\u4F8B",
    fallback: options.fallback,
    options: options.ratios,
    adaptive: options.adaptive,
    hiddenWhen: options.hiddenWhen
  });
}
function resolutionField(options) {
  return semanticSelectField({
    control: "resolution",
    title: options.title ?? "\u5206\u8FA8\u7387",
    fallback: options.fallback,
    options: options.tiers,
    hiddenWhen: options.hiddenWhen
  });
}
function normalizeAdaptive(adaptive) {
  if (!adaptive) return void 0;
  if (adaptive === true) return { value: ADAPTIVE_PARAMETER_VALUE, label: ADAPTIVE_PARAMETER_LABEL };
  return {
    value: adaptive.value ?? ADAPTIVE_PARAMETER_VALUE,
    label: adaptive.label ?? ADAPTIVE_PARAMETER_LABEL
  };
}

// ../../../../client/web/contracts/src/task/generation-parameters/card.ts
var MB = 1024 * 1024;
function imageCard(input) {
  return {
    ...input,
    modelType: "image",
    providerId: input.providerId ?? "remote-server"
  };
}
function videoCard(input) {
  return {
    ...input,
    modelType: "video",
    providerId: input.providerId ?? "remote-server"
  };
}
function audioCard(input) {
  return {
    ...input,
    modelType: "audio",
    providerId: input.providerId ?? "remote-server"
  };
}

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/ark/seedream-spec.ts
var SEEDREAM_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "21:9"
];
var SEEDREAM_TIER_SIZE_TABLES = {
  "1K": {
    "1:1": "1024x1024",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1424x800",
    "9:16": "800x1424",
    "3:2": "1248x832",
    "2:3": "832x1248",
    "21:9": "1568x672"
  },
  "1.5K": {
    "1:1": "1536x1536",
    "4:3": "1792x1344",
    "3:4": "1344x1792",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "3:2": "1872x1248",
    "2:3": "1248x1872",
    "21:9": "2352x1008"
  },
  "2K": {
    "1:1": "2048x2048",
    "4:3": "2304x1728",
    "3:4": "1728x2304",
    "16:9": "2848x1600",
    "9:16": "1600x2848",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "21:9": "3136x1344"
  },
  "3K": {
    "1:1": "3072x3072",
    "4:3": "3456x2592",
    "3:4": "2592x3456",
    "16:9": "4096x2304",
    "9:16": "2304x4096",
    "3:2": "3744x2496",
    "2:3": "2496x3744",
    "21:9": "4704x2016"
  },
  "4K": {
    "1:1": "4096x4096",
    "4:3": "4704x3520",
    "3:4": "3520x4704",
    "16:9": "5504x3040",
    "9:16": "3040x5504",
    "3:2": "4992x3328",
    "2:3": "3328x4992",
    "21:9": "6240x2656"
  }
};
function seedreamSizeTable(...tiers) {
  const table = {};
  for (const tier of tiers) table[tier] = SEEDREAM_TIER_SIZE_TABLES[tier];
  return table;
}
var SEEDREAM_UNKNOWN_VERSION = {
  id: "seedream-unknown",
  resolutions: ["1K", "2K", "4K"],
  defaultResolution: "2K",
  sizes: {},
  aspectRatios: [],
  pixelWindow: { minTotalPixels: 921600, maxTotalPixels: 16777216, minAspectRatio: 1 / 16, maxAspectRatio: 16 },
  maxReferenceImages: 14
};

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/ark/seedream-5.0-pro.ts
var seedream50Pro = imageCard({
  id: "seedream-5.0-pro",
  title: "Seedream 5.0 Pro",
  vendor: "ark",
  providerModelId: "doubao-seedream-5-0-pro-260628",
  docs: "https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh",
  note: "\u5373\u68A6\uFF1A\u6CA1\u6709 aspect_ratio / quality\uFF0C\u5BBD\u9AD8\u6BD4\u53EA\u80FD\u5199\u8FDB size\uFF1B\u652F\u6301\u900F\u660E\u80CC\u666F",
  keeps: [
    "prompt",
    "referencesImage",
    "aspectRatio",
    "resolution",
    "background",
    "outputFormat"
  ],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg", "png"] } },
  seedream: {
    aliases: ["seedream-5-pro", "doubao-seedream-5.0-pro", "doubao-seedream-5-0-pro"],
    prefixes: ["seedream-5-pro", "seedream-image-5-pro", "doubao-seedream-5-0-pro"],
    resolutions: ["1K", "1.5K", "2K"],
    gatewayResolutions: ["1K", "2K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("1K", "1.5K", "2K"),
    aspectRatios: SEEDREAM_ASPECT_RATIOS,
    pixelWindow: {
      minTotalPixels: 921600,
      maxTotalPixels: 4624220,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    },
    transparentBackground: true
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 10, maxBytesPerItem: 10 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/ark/seedream-5.0-flash.ts
var seedream50Flash = imageCard({
  id: "seedream-5.0-flash",
  title: "Seedream 5.0 Flash",
  vendor: "ark",
  providerModelId: "doubao-seedream-5-0-flash-260915",
  docs: "https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh",
  note: "\u5373\u68A6 Flash\uFF1A\u6863\u4F4D\u4E0E Pro \u76F8\u540C\uFF0C\u652F\u6301\u900F\u660E\u80CC\u666F",
  keeps: [
    "prompt",
    "referencesImage",
    "aspectRatio",
    "resolution",
    "background",
    "outputFormat"
  ],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg", "png"] } },
  seedream: {
    aliases: ["seedream-5-flash", "doubao-seedream-5.0-flash", "doubao-seedream-5-0-flash"],
    prefixes: ["seedream-5-flash", "seedream-image-5-flash", "doubao-seedream-5-0-flash"],
    resolutions: ["1K", "1.5K", "2K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("1K", "1.5K", "2K"),
    aspectRatios: SEEDREAM_ASPECT_RATIOS,
    pixelWindow: {
      minTotalPixels: 921600,
      maxTotalPixels: 4624220,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    },
    transparentBackground: true
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 10, maxBytesPerItem: 10 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/ark/seedream-5.0-lite.ts
var seedream50Lite = imageCard({
  id: "seedream-5.0-lite",
  title: "Seedream 5.0 Lite",
  vendor: "ark",
  providerModelId: "doubao-seedream-5-0-260128",
  docs: "https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh",
  note: "\u5373\u68A6 Lite\uFF1A\u6863\u4F4D 2K / 3K / 4K\uFF0C\u6CA1\u6709\u900F\u660E\u80CC\u666F",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg", "png"] } },
  seedream: {
    aliases: ["seedream-5-lite", "seedream-image-5-lite", "doubao-seedream-5-0-lite"],
    // 「doubao-seedream-5-0」用于只带日期后缀、没写 pro/flash/lite 的网关 id（更长前缀仍优先）。
    prefixes: ["seedream-5-lite", "seedream-image-5-lite", "doubao-seedream-5-0-lite", "doubao-seedream-5-0"],
    resolutions: ["2K", "3K", "4K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("2K", "3K", "4K"),
    aspectRatios: SEEDREAM_ASPECT_RATIOS,
    pixelWindow: {
      minTotalPixels: 3686400,
      maxTotalPixels: 16777216,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    }
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 10 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/ark/seedream-4.5.ts
var seedream45 = imageCard({
  id: "seedream-4.5",
  title: "Seedream 4.5",
  vendor: "ark",
  providerModelId: "doubao-seedream-4-5-251128",
  docs: "https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh",
  note: "4.5\uFF1A\u6863\u4F4D 2K / 4K\uFF0C\u53EA\u51FA jpeg\uFF0C\u6CA1\u6709\u900F\u660E\u80CC\u666F",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg"] } },
  seedream: {
    aliases: ["seedream-4.5", "seedream-image-4.5", "doubao-seedream-4.5"],
    prefixes: ["seedream-4.5", "seedream-4-5", "seedream-image-4.5", "doubao-seedream-4-5"],
    resolutions: ["2K", "4K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("2K", "4K"),
    aspectRatios: SEEDREAM_ASPECT_RATIOS,
    pixelWindow: {
      minTotalPixels: 3686400,
      maxTotalPixels: 16777216,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    }
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 10 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/ark/seedream-4.0.ts
var seedream40 = imageCard({
  id: "seedream-4.0",
  title: "Seedream 4.0",
  vendor: "ark",
  providerModelId: "doubao-seedream-4-0-250828",
  docs: "https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh",
  note: "4.0\uFF1A\u53EA\u6709\u6863\u4F4D\u3001\u6CA1\u6709\u6BD4\u4F8B\u8868\uFF0C\u5BBD\u9AD8\u6BD4\u4EA4\u7ED9\u63D0\u793A\u8BCD",
  keeps: ["prompt", "referencesImage", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg"] } },
  seedream: {
    aliases: ["seedream-4.0", "seedream-image-4", "doubao-seedream-4.0"],
    prefixes: ["seedream-4", "seedream-image-4", "doubao-seedream-4"],
    resolutions: ["1K", "2K", "4K"],
    defaultResolution: "2K",
    sizes: {},
    aspectRatios: [],
    pixelWindow: {
      minTotalPixels: 921600,
      maxTotalPixels: 16777216,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    }
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 10 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/ark/seedream-cards.ts
function seedreamSpecOfCard(card) {
  const data = card.seedream;
  if (data === void 0) return void 0;
  const providerModelId = card.providerModelId.trim().toLowerCase();
  return {
    ...data,
    id: card.id,
    // 卡片自己的 providerModelId 也是别名：网关上就是拿它发现模型的。
    aliases: providerModelId === "" ? data.aliases : [providerModelId, ...data.aliases ?? []],
    // 参考图上限只存一份：卡片的 `limits`。
    maxReferenceImages: card.limits?.references?.image?.max ?? 14
  };
}
var SEEDREAM_CARDS = [
  seedream50Pro,
  seedream50Flash,
  seedream50Lite,
  seedream45,
  seedream40
];
var SEEDREAM_SPECS = SEEDREAM_CARDS.flatMap(
  (card) => {
    const spec = seedreamSpecOfCard(card);
    return spec === void 0 ? [] : [{ card, spec }];
  }
);
var SEEDREAM_SIZE_PRESETS = SEEDREAM_SPECS.map(
  (entry) => entry.spec
);

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/ark/index.ts
var ARK_IMAGE_CARDS = [
  seedream50Pro,
  seedream50Flash,
  seedream50Lite,
  seedream45,
  seedream40
];

// ../../../../client/web/contracts/src/task/model-presets.ts
var IMAGE_ASPECT_RATIOS_STANDARD = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9"
];
var GEMINI_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9"
];
var GEMINI_FLASH_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9"
];
var GPT_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "21:9"
];
var GPT_IMAGE_RESOLUTIONS = ["1K", "2K", "4K"];
var HY_IMAGE_PRESET = {
  id: "hy-image-v3.5-preview",
  aliases: [
    "hy-image-v3.5-preview",
    "hy-image-v35-preview",
    "hy-image-3.5-preview",
    "hy3.5-preview",
    "hunyuan-image-3.5-preview"
  ],
  aspectRatios: IMAGE_ASPECT_RATIOS_STANDARD,
  adaptiveAspectRatio: true,
  resolutions: ["1K", "1.5K", "2K"],
  defaultResolution: "1.5K"
};
var GEMINI_PRO_PRESET = {
  id: "gemini-3-pro-image",
  aliases: ["gemini-3-pro-image", "vertex-gemini-3-pro-image"],
  aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["1K", "2K", "4K"],
  defaultResolution: "1K"
};
var GEMINI_FLASH_LITE_PRESET = {
  id: "gemini-3.1-flash-lite-image",
  aliases: ["gemini-3.1-flash-lite-image", "vertex-gemini-3.1-flash-lite-image"],
  aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["1K"],
  defaultResolution: "1K"
};
var GEMINI_FLASH_PRESET = {
  id: "gemini-3.1-flash-image",
  aliases: ["gemini-3.1-flash-image", "vertex-gemini-3.1-flash-image"],
  aspectRatios: GEMINI_FLASH_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["512", "1K", "2K", "4K"],
  defaultResolution: "1K"
};
var GEMINI_LEGACY_PRESET = {
  id: "gemini-2.5-flash-image",
  aliases: ["gemini-2.5-flash-image"],
  aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["1K"],
  defaultResolution: "1K"
};
var NANO_BANANA_PRESET = {
  id: "nanobanana-2.1",
  aliases: [
    "nanobanana2.1",
    "nanobanana-2.1",
    "gemini-nano-banana-2.1",
    "nanobanana2",
    "nanobanana-2",
    "gemini-nano-banana-2"
  ],
  aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["1K", "2K", "4K"],
  defaultResolution: "1K"
};
var GPT_IMAGE_PRESET = {
  id: "gpt-image",
  prefixes: ["gpt-image"],
  aspectRatios: GPT_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: GPT_IMAGE_RESOLUTIONS,
  defaultResolution: "1K"
};
function seedreamPreset(spec) {
  return {
    id: spec.id,
    ...spec.aliases ? { aliases: spec.aliases } : {},
    ...spec.prefixes ? { prefixes: spec.prefixes } : {},
    aspectRatios: IMAGE_ASPECT_RATIOS_STANDARD,
    // 即梦官方「方式 1」：只给分辨率档位、宽高比交给模型，因此支持自适应。
    adaptiveAspectRatio: true,
    resolutions: spec.resolutions,
    defaultResolution: spec.defaultResolution
  };
}
var IMAGE_MODEL_PRESETS = [
  HY_IMAGE_PRESET,
  {
    id: "hy-image-v3",
    aliases: ["hy-image-v3", "hy-image-v3.0", "hy-image-3", "hunyuan-image-3"],
    aspectRatios: IMAGE_ASPECT_RATIOS_STANDARD,
    adaptiveAspectRatio: false,
    resolutions: ["1K"],
    defaultResolution: "1K"
  },
  GEMINI_PRO_PRESET,
  GEMINI_FLASH_LITE_PRESET,
  GEMINI_FLASH_PRESET,
  GEMINI_LEGACY_PRESET,
  NANO_BANANA_PRESET,
  GPT_IMAGE_PRESET,
  ...SEEDREAM_SIZE_PRESETS.map(seedreamPreset)
];

// ../../../../client/web/contracts/src/task/image-parameters.ts
var GPT_IMAGE_QUALITIES = [
  { label: "\u81EA\u52A8", value: "auto" },
  { label: "\u4F4E", value: "low" },
  { label: "\u4E2D", value: "medium" },
  { label: "\u9AD8", value: "high" }
];
var GPT_IMAGE_25_QUALITIES = [
  ...GPT_IMAGE_QUALITIES,
  { label: "\u6781\u9AD8", value: "xhigh" },
  { label: "\u6700\u9AD8", value: "max" }
];

// ../../../../client/web/contracts/src/task/generation-parameters/controls.ts
function selectOption(value, label) {
  return { value, label };
}
function enumValues(options) {
  return Array.isArray(options.values) ? options.values.filter((value) => typeof value === "string") : [];
}
function labeledEnumValues(options) {
  const raw = Array.isArray(options.values) ? options.values : [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(selectOption(entry, entry));
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry;
    if (typeof record.value !== "string") continue;
    out.push(selectOption(record.value, typeof record.label === "string" ? record.label : record.value));
  }
  return out;
}
function hiddenWhenOf(options) {
  return options.hiddenWhen === void 0 ? void 0 : options;
}
function referenceControl(key, title, semantic) {
  return {
    key,
    group: "\u901A\u7528",
    label: "\u7D20\u6750\u6570\u7EC4",
    control: "upload",
    build: (options) => ({
      type: "array",
      title,
      maxItems: typeof options.max === "number" ? options.max : 1,
      "x-pptask-semantic": semantic,
      "x-component": "Upload"
    })
  };
}
var PARAMETER_CONTROLS = [
  {
    key: "prompt",
    group: "\u901A\u7528",
    label: "\u6587\u672C\u57DF",
    control: "textarea",
    build: () => ({ type: "string", title: "\u63D0\u793A\u8BCD", "x-component": "Input.TextArea" })
  },
  referenceControl("referencesImage", "\u53C2\u8003\u56FE", "reference-image"),
  referenceControl("referencesVideo", "\u53C2\u8003\u89C6\u9891", "reference-video"),
  referenceControl("referencesAudio", "\u53C2\u8003\u97F3\u9891", "reference-audio"),
  {
    key: "aspectRatio",
    group: "\u901A\u7528",
    label: "\u8BED\u4E49\xB7\u6BD4\u4F8B",
    control: "aspect-ratio",
    build: (options) => aspectRatioField({
      ratios: enumValues(options),
      ...typeof options.default === "string" ? { fallback: options.default } : {},
      ...options.adaptive === true ? { adaptive: true } : {},
      ...hiddenWhenOf(options) ? { hiddenWhen: options.hiddenWhen } : {}
    })
  },
  {
    key: "resolution",
    group: "\u901A\u7528",
    label: "\u8BED\u4E49\xB7\u5206\u8FA8\u7387",
    control: "resolution",
    build: (options) => resolutionField({
      tiers: enumValues(options),
      ...typeof options.default === "string" ? { fallback: options.default } : {},
      title: typeof options.title === "string" ? options.title : "\u5206\u8FA8\u7387",
      ...hiddenWhenOf(options) ? { hiddenWhen: options.hiddenWhen } : {}
    })
  },
  {
    key: "quality",
    group: "\u56FE\u7247",
    label: "\u8BED\u4E49\xB7\u8D28\u91CF",
    control: "quality",
    build: (options) => ({
      type: "string",
      title: "\u8D28\u91CF",
      default: options.default,
      "x-component": "Select",
      "x-pptask-control": "quality",
      enum: enumValues(options).map((value) => selectOption(value, value))
    })
  },
  {
    key: "voice",
    group: "\u97F3\u9891",
    label: "\u679A\u4E3E",
    control: "enum",
    build: (options) => {
      const values = labeledEnumValues(options);
      if (values.length === 0) {
        return { type: "string", title: "\u97F3\u8272", default: options.default };
      }
      return semanticSelectField({
        control: "voice",
        title: "\u97F3\u8272",
        ...typeof options.default === "string" ? { fallback: options.default } : {},
        options: values
      });
    }
  },
  {
    key: "speed",
    group: "\u97F3\u9891",
    label: "\u6570\u503C",
    control: "number",
    build: (options) => ({
      type: "number",
      title: "\u8BED\u901F",
      default: options.default,
      minimum: options.minimum,
      maximum: options.maximum,
      step: options.step
    })
  },
  {
    key: "n",
    group: "\u56FE\u7247",
    label: "\u6570\u91CF",
    control: "number",
    build: (options) => ({
      type: "number",
      title: "\u6570\u91CF",
      default: options.default,
      minimum: 1,
      maximum: options.maximum,
      step: 1,
      "x-component": "NumberPicker"
    })
  },
  {
    key: "background",
    group: "\u56FE\u7247",
    label: "\u679A\u4E3E",
    control: "enum",
    build: (options) => ({
      type: "string",
      title: "\u80CC\u666F",
      default: options.default,
      enum: enumValues(options).map((value) => selectOption(value, value))
    })
  },
  {
    key: "outputFormat",
    group: "\u901A\u7528",
    label: "\u679A\u4E3E",
    control: "enum",
    build: (options) => ({
      type: "string",
      title: "\u8F93\u51FA\u683C\u5F0F",
      default: options.default,
      enum: enumValues(options).map((value) => selectOption(value, value.toUpperCase()))
    })
  },
  {
    key: "generationMode",
    group: "\u89C6\u9891",
    label: "\u679A\u4E3E",
    control: "enum",
    build: (options) => ({
      type: "string",
      title: "\u6A21\u5F0F",
      default: options.default,
      enum: options.enum
    })
  },
  {
    key: "durationSeconds",
    group: "\u89C6\u9891",
    label: "\u6570\u503C",
    control: "number",
    build: (options) => {
      const schema = {
        type: "number",
        title: typeof options.title === "string" ? options.title : "\u65F6\u957F",
        default: options.default,
        minimum: options.minimum,
        maximum: options.maximum,
        step: 1,
        unit: "\u79D2"
      };
      if (options.hiddenWhen !== void 0) schema["x-hidden-when"] = options.hiddenWhen;
      return schema;
    }
  },
  {
    key: "generateAudio",
    group: "\u89C6\u9891",
    label: "\u5E03\u5C14",
    control: "boolean",
    build: (options) => ({
      type: "boolean",
      title: "\u751F\u6210\u97F3\u9891",
      default: options.default !== false,
      "x-component": "Switch"
    })
  },
  {
    key: "seed",
    group: "\u89C6\u9891",
    label: "\u6574\u6570",
    control: "integer",
    build: () => ({ type: "integer", title: "\u968F\u673A\u79CD\u5B50", "x-component": "NumberPicker" })
  },
  {
    key: "cameraFixed",
    group: "\u89C6\u9891",
    label: "\u5E03\u5C14",
    control: "boolean",
    build: () => ({ type: "boolean", title: "\u56FA\u5B9A\u955C\u5934", default: false })
  },
  {
    key: "returnLastFrame",
    group: "\u89C6\u9891",
    label: "\u5E03\u5C14",
    control: "boolean",
    build: () => ({ type: "boolean", title: "\u8FD4\u56DE\u5C3E\u5E27", default: false })
  },
  {
    key: "seconds",
    group: "\u9057\u7559",
    label: "\u9057\u7559\xB7\u6587\u672C",
    control: "textarea",
    build: () => ({ type: "string", title: "\u65F6\u957F\uFF08\u79D2\uFF09", default: "4" })
  },
  {
    key: "size",
    group: "\u9057\u7559",
    label: "\u9057\u7559\xB7\u6587\u672C",
    control: "textarea",
    build: () => ({ type: "string", title: "\u5206\u8FA8\u7387", default: "720p" })
  }
];
var CONTROL_BY_KEY = new Map(
  PARAMETER_CONTROLS.map((control) => [control.key, control])
);

// ../../../../client/web/contracts/src/task/generation-parameters/cards/audio/generic/generic.ts
var genericAudio = audioCard({
  id: "audio-generic",
  title: "\u97F3\u9891\u901A\u7528\uFF08\u6258\u7BA1\u670D\u52A1\u7AEF\uFF09",
  vendor: "generic",
  providerModelId: "audio-generic",
  docs: "https://docs.litellm.ai/docs/providers/openai",
  note: "\u670D\u52A1\u7AEF\u6309\u7C7B\u578B\u5199\u6B7B\u7684\u97F3\u8272 / \u683C\u5F0F / \u8BED\u901F\uFF0C\u6CA1\u6709\u7EA6\u675F\u58F0\u660E",
  keeps: ["prompt", "voice", "outputFormat", "speed"]
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/audio/generic/index.ts
var GENERIC_AUDIO_CARDS = [genericAudio];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/audio/minimax/speech.ts
var MINIMAX_SYSTEM_VOICES = [
  { value: "male-qn-qingse", label: "\u9752\u6DA9\u9752\u5E74\u97F3\u8272\uFF08\u4E2D\u6587\uFF09" },
  { value: "male-qn-jingying", label: "\u7CBE\u82F1\u9752\u5E74\u97F3\u8272\uFF08\u4E2D\u6587\uFF09" },
  { value: "male-qn-badao", label: "\u9738\u9053\u9752\u5E74\u97F3\u8272\uFF08\u4E2D\u6587\uFF09" },
  { value: "male-qn-daxuesheng", label: "\u9752\u5E74\u5927\u5B66\u751F\u97F3\u8272\uFF08\u4E2D\u6587\uFF09" },
  { value: "female-shaonv", label: "\u5C11\u5973\u97F3\u8272\uFF08\u4E2D\u6587\uFF09" },
  { value: "female-yujie", label: "\u5FA1\u59D0\u97F3\u8272\uFF08\u4E2D\u6587\uFF09" },
  { value: "female-chengshu", label: "\u6210\u719F\u5973\u6027\u97F3\u8272\uFF08\u4E2D\u6587\uFF09" },
  { value: "female-tianmei", label: "\u751C\u7F8E\u5973\u6027\u97F3\u8272\uFF08\u4E2D\u6587\uFF09" },
  { value: "Chinese (Mandarin)_Lyrical_Voice", label: "\u6292\u60C5\u7537\u58F0\uFF08\u4E2D\u6587\uFF09" },
  { value: "Chinese (Mandarin)_HK_Flight_Attendant", label: "\u6E2F\u666E\u7A7A\u59D0\uFF08\u4E2D\u6587\uFF09" },
  { value: "English_expressive_narrator", label: "Expressive Narrator\uFF08\u82F1\u6587\uFF09" },
  { value: "English_radiant_girl", label: "Radiant Girl\uFF08\u82F1\u6587\uFF09" },
  { value: "English_Graceful_Lady", label: "Graceful Lady\uFF08\u82F1\u6587\uFF09" },
  { value: "English_Trustworthy_Man", label: "Trustworthy Man\uFF08\u82F1\u6587\uFF09" },
  { value: "English_Aussie_Bloke", label: "Aussie Bloke\uFF08\u82F1\u6587\uFF09" },
  { value: "English_Whispering_girl", label: "Whispering Girl\uFF08\u82F1\u6587\uFF09" },
  { value: "English_Diligent_Man", label: "Diligent Man\uFF08\u82F1\u6587\uFF09" },
  { value: "English_Gentle-voiced_man", label: "Gentle-voiced Man\uFF08\u82F1\u6587\uFF09" },
  { value: "Japanese_IntellectualSenior", label: "Intellectual Senior\uFF08\u65E5\u6587\uFF09" },
  { value: "Japanese_DecisivePrincess", label: "Decisive Princess\uFF08\u65E5\u6587\uFF09" },
  { value: "Cantonese_GentleLady", label: "\u6E29\u67D4\u5973\u58F0\uFF08\u7CA4\u8BED\uFF09" },
  { value: "Cantonese_PlayfulMan", label: "\u6D3B\u6CFC\u7537\u58F0\uFF08\u7CA4\u8BED\uFF09" }
];
var minimaxSpeech = audioCard({
  id: "minimax-speech-2.8-hd",
  title: "MiniMax Speech 2.8 HD",
  vendor: "minimax",
  providerModelId: "minimax-speech-2.8-hd",
  docs: "https://platform.minimax.cn/docs/api-reference/speech-t2a-http",
  note: "\u5E38\u7528\u7CFB\u7EDF\u97F3\u8272\uFF08\u4E2D / \u82F1 / \u65E5 / \u7CA4\uFF09\uFF1B\u8BED\u901F 0.5\u20132\uFF1B\u8F93\u51FA\u683C\u5F0F\u4E0D\u542B aac",
  keeps: ["prompt", "voice", "outputFormat", "speed"],
  narrow: {
    voice: { default: "male-qn-qingse", values: [...MINIMAX_SYSTEM_VOICES] },
    outputFormat: { default: "mp3", values: ["mp3", "pcm", "flac", "wav", "opus"] },
    speed: { default: 1, minimum: 0.5, maximum: 2 }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/audio/minimax/index.ts
var MINIMAX_AUDIO_CARDS = [minimaxSpeech];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/audio/openai/tts.ts
var OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer"
];
var openaiTts = audioCard({
  id: "tts-1",
  title: "TTS\uFF08OpenAI\uFF09",
  vendor: "openai",
  providerModelId: "tts-1",
  docs: "https://platform.openai.com/docs/api-reference/audio/createSpeech",
  note: "\u97F3\u8272 9 \u6863\u3001\u8F93\u51FA\u683C\u5F0F 6 \u79CD\uFF1B\u8BED\u901F 0.25\u20134\uFF0C\u8F93\u5165 \u2264 4096 \u5B57\u7B26",
  keeps: ["prompt", "voice", "outputFormat", "speed"],
  narrow: {
    voice: { default: "alloy", values: [...OPENAI_TTS_VOICES] },
    outputFormat: { default: "mp3", values: ["mp3", "opus", "aac", "flac", "wav", "pcm"] }
  },
  limits: {
    // 官方限制：input 最多 4096 个字符。
    promptMaxChars: 4096
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/audio/openai/index.ts
var OPENAI_AUDIO_CARDS = [openaiTts];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/audio/index.ts
var AUDIO_CARDS = [
  ...OPENAI_AUDIO_CARDS,
  ...MINIMAX_AUDIO_CARDS,
  ...GENERIC_AUDIO_CARDS
];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/openai/gpt-image-2.5.ts
var gptImage25 = imageCard({
  id: "gpt-image-2.5",
  title: "GPT Image 2.5",
  vendor: "openai",
  providerModelId: "gpt-image-2.5",
  // OpenAI 的文档站对爬虫返回 403，但这是图片 API 的权威页；人工访问正常。
  docs: "https://platform.openai.com/docs/api-reference/images",
  note: "\u6BD4\u4F8B + \u5206\u8FA8\u7387\u67E5\u8868\u5F97\u5230\u50CF\u7D20 size\uFF0Cquality \u6709 6 \u6863",
  keeps: [
    "prompt",
    "referencesImage",
    "aspectRatio",
    "resolution",
    "quality",
    "n",
    "background",
    "outputFormat"
  ],
  limits: {
    promptMaxChars: 32e3,
    references: { image: { min: 0, max: 16, maxBytesPerItem: 20 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/openai/gpt-image-2.5-flare.ts
var gptImage25Flare = imageCard({
  id: "gpt-image-2.5-flare",
  title: "GPT Image 2.5 Flare",
  vendor: "openai",
  providerModelId: "gpt-image-2.5-flare",
  docs: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/dall-e",
  note: "\u6700\u5FEB\u7684\u4E00\u6863\uFF1A\u9AD8\u8D28\u91CF\u65E5\u5E38\u51FA\u56FE\uFF0C\u540C\u6837\u652F\u6301\u900F\u660E\u80CC\u666F",
  keeps: [
    "prompt",
    "referencesImage",
    "aspectRatio",
    "resolution",
    "quality",
    "n",
    "background",
    "outputFormat"
  ],
  limits: {
    promptMaxChars: 32e3,
    references: { image: { min: 0, max: 16, maxBytesPerItem: 20 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/openai/gpt-image-2.5-sunburst.ts
var gptImage25Sunburst = imageCard({
  id: "gpt-image-2.5-sunburst",
  title: "GPT Image 2.5 Sunburst",
  vendor: "openai",
  providerModelId: "gpt-image-2.5-sunburst",
  docs: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/dall-e",
  note: "\u6700\u5F3A\u7684\u4E00\u6863\uFF1A\u7F16\u8F91\u7CBE\u5EA6\u6700\u9AD8\uFF0C\u540C\u6837\u652F\u6301\u900F\u660E\u80CC\u666F",
  keeps: [
    "prompt",
    "referencesImage",
    "aspectRatio",
    "resolution",
    "quality",
    "n",
    "background",
    "outputFormat"
  ],
  limits: {
    promptMaxChars: 32e3,
    references: { image: { min: 0, max: 16, maxBytesPerItem: 20 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/openai/index.ts
var OPENAI_IMAGE_CARDS = [
  gptImage25Sunburst,
  gptImage25Flare,
  gptImage25
];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/google/gemini-3.1-flash-image.ts
var gemini31FlashImage = imageCard({
  id: "gemini-3.1-flash-image",
  title: "Gemini 3.1 Flash Image",
  vendor: "google",
  providerModelId: "gemini-3.1-flash-image",
  docs: "https://ai.google.dev/gemini-api/docs/image-generation",
  note: "\u539F\u751F aspect_ratio + image_size\uFF1B\u6CA1\u6709\u8D28\u91CF\u4E0E\u6570\u91CF\u6863\u4F4D",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution"],
  limits: {
    promptMaxChars: 48e3,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 20 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/google/nano-banana-2.ts
var nanoBanana2 = imageCard({
  id: "nano-banana-2",
  title: "Nano Banana 2",
  vendor: "google",
  providerModelId: "nanobanana-2",
  docs: "https://ai.google.dev/gemini-api/docs/image-generation",
  note: "Gemini \u5BB6\u65CF\u7684\u522B\u540D\uFF1A\u6BD4\u4F8B + image_size",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution"],
  limits: {
    promptMaxChars: 48e3,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 20 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/google/index.ts
var GOOGLE_IMAGE_CARDS = [gemini31FlashImage, nanoBanana2];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/generic/generic.ts
var genericImage = imageCard({
  id: "image-generic",
  title: "\u56FE\u7247\u901A\u7528\uFF08\u6258\u7BA1\u670D\u52A1\u7AEF\uFF09",
  vendor: "generic",
  providerModelId: "image-generic",
  docs: "https://docs.litellm.ai/docs/providers/openai",
  note: "\u670D\u52A1\u7AEF\u6309\u7C7B\u578B\u5199\u6B7B\u4E00\u4E2A\u50CF\u7D20 size\uFF0C\u6CA1\u6709\u7EA6\u675F\u58F0\u660E",
  keeps: [],
  adds: ["size"]
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/generic/index.ts
var GENERIC_IMAGE_CARDS = [genericImage];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/image/index.ts
var IMAGE_CARDS = [
  ...ARK_IMAGE_CARDS,
  ...OPENAI_IMAGE_CARDS,
  ...GOOGLE_IMAGE_CARDS,
  ...GENERIC_IMAGE_CARDS
];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/ark/seedance-2.5.ts
var seedance25 = videoCard({
  id: "seedance-2.5",
  title: "Seedance 2.5",
  vendor: "ark",
  providerModelId: "seedance-2.5",
  docs: "https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh",
  note: "\u56FE / \u89C6\u9891 / \u97F3\u9891\u4E09\u7C7B\u53C2\u8003\uFF1B\u7F16\u8F91\u6A21\u5F0F\u9690\u85CF\u65F6\u957F\u4E0E\u6BD4\u4F8B",
  keeps: [
    "prompt",
    "referencesImage",
    "referencesVideo",
    "referencesAudio",
    "generationMode",
    "durationSeconds",
    "aspectRatio",
    "resolution",
    "generateAudio",
    "outputFormat",
    "seed",
    "cameraFixed",
    "returnLastFrame"
  ],
  narrow: {
    durationSeconds: { hiddenWhen: [{ field: "generationMode", equals: "edit_video" }] }
  },
  limits: {
    promptMaxChars: 2e3,
    references: {
      image: { min: 0, max: 30, maxBytesPerItem: 10 * MB },
      video: { min: 0, max: 10, maxBytesPerItem: 50 * MB },
      audio: { min: 0, max: 10, maxBytesPerItem: 15 * MB }
    },
    combined: [{ kinds: ["image", "video"], max: 30, label: "\u53C2\u8003\u56FE + \u53C2\u8003\u89C6\u9891" }]
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/ark/seedance-2.0.ts
var seedance20 = videoCard({
  id: "seedance-2.0",
  title: "Seedance 2.0",
  vendor: "ark",
  providerModelId: "seedance-2",
  docs: "https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh",
  note: "2.0 \u5BB6\u65CF\uFF1A\u65F6\u957F\u4E0A\u9650 15 \u79D2\uFF0C\u56FE + \u89C6\u9891\u53C2\u8003",
  keeps: [
    "prompt",
    "referencesImage",
    "referencesVideo",
    "generationMode",
    "durationSeconds",
    "aspectRatio",
    "resolution",
    "generateAudio",
    "outputFormat"
  ],
  narrow: {
    durationSeconds: { hiddenWhen: [{ field: "generationMode", equals: "edit_video" }] }
  },
  limits: {
    promptMaxChars: 1200,
    references: {
      image: { min: 0, max: 9, maxBytesPerItem: 10 * MB },
      video: { min: 0, max: 3, maxBytesPerItem: 20 * MB }
    },
    combined: [{ kinds: ["image", "video"], max: 9, label: "\u53C2\u8003\u56FE + \u53C2\u8003\u89C6\u9891" }]
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/ark/seedance-1.0.ts
var seedance10 = videoCard({
  id: "seedance-1.0",
  title: "Seedance 1.0",
  vendor: "ark",
  providerModelId: "seedance-1",
  docs: "https://docs.volcengine.com/docs/ark/seedance-1-0-pro-pro-fast?lang=zh",
  note: "1.0 \u5BB6\u65CF\uFF1A\u53EA\u63A5\u53D7\u9996\u5E27\u56FE\uFF0C\u65F6\u957F 2\u201312 \u79D2",
  keeps: ["prompt", "referencesImage", "durationSeconds", "aspectRatio", "resolution"],
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 2, maxBytesPerItem: 10 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/ark/index.ts
var ARK_VIDEO_CARDS = [seedance25, seedance20, seedance10];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/google/veo.ts
var veo = videoCard({
  id: "veo",
  title: "Veo",
  vendor: "google",
  providerModelId: "veo-3.1-fast",
  docs: "https://ai.google.dev/gemini-api/docs/veo",
  note: "\u53EA\u7ED9\u6A2A\u7AD6\u4E24\u79CD\u753B\u5E45\uFF1B\u65F6\u957F\u6309 2 \u79D2\u6B65\u957F\uFF084 / 6 / 8\uFF09",
  keeps: ["prompt", "referencesImage", "durationSeconds", "aspectRatio", "resolution"],
  limits: {
    promptMaxChars: 2e3,
    references: { image: { min: 0, max: 1, maxBytesPerItem: 20 * MB } }
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/google/index.ts
var GOOGLE_VIDEO_CARDS = [veo];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/minimax/h3.ts
var minimaxH3 = videoCard({
  id: "minimax-h3",
  title: "MiniMax H3",
  vendor: "minimax",
  providerModelId: "minimax-h3",
  docs: "https://platform.minimax.io/docs/api-reference/video-generation-v2-create",
  note: "\u6587\u751F / \u56FE\u751F / \u53C2\u8003\u751F\u89C6\u9891\u4E09\u6A21\u5F0F\uFF1B\u56FE\u751F\u4E0E\u53C2\u8003\u4E92\u65A5",
  keeps: [
    "prompt",
    "referencesImage",
    "referencesVideo",
    "referencesAudio",
    "generationMode",
    "durationSeconds",
    "aspectRatio",
    "resolution"
  ],
  limits: {
    // 官方：prompt ≤ 7000 字符。
    promptMaxChars: 7e3,
    references: {
      // 首帧 / 尾帧各 ≤ 1，参考图 ≤ 9；混合输入总计 ≤ 12。
      image: { min: 0, max: 9, maxBytesPerItem: 30 * MB },
      video: { min: 0, max: 3, maxBytesPerItem: 50 * MB },
      audio: { min: 0, max: 3, maxBytesPerItem: 15 * MB }
    },
    total: { max: 12 },
    // 首尾帧与参考素材互斥，所以单类上限不能简单相加：这里按官方「混合输入 ≤ 12」收起。
    combined: [{ kinds: ["image", "video", "audio"], max: 12, label: "\u53C2\u8003\u7D20\u6750\u5408\u8BA1" }]
  }
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/minimax/index.ts
var MINIMAX_VIDEO_CARDS = [minimaxH3];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/generic/generic.ts
var genericVideo = videoCard({
  id: "video-generic",
  title: "\u89C6\u9891\u901A\u7528\uFF08\u6258\u7BA1\u670D\u52A1\u7AEF\uFF09",
  vendor: "generic",
  providerModelId: "video-generic",
  docs: "https://docs.litellm.ai/docs/providers/openai",
  note: "\u670D\u52A1\u7AEF\u6309\u7C7B\u578B\u5199\u6B7B\u7684\u4E24\u4E2A\u6587\u672C\u6846\uFF0C\u6CA1\u6709\u7EA6\u675F\u58F0\u660E",
  keeps: [],
  adds: ["seconds", "size"]
});

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/generic/index.ts
var GENERIC_VIDEO_CARDS = [genericVideo];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/video/index.ts
var VIDEO_CARDS = [
  ...ARK_VIDEO_CARDS,
  ...GOOGLE_VIDEO_CARDS,
  ...MINIMAX_VIDEO_CARDS,
  ...GENERIC_VIDEO_CARDS
];

// ../../../../client/web/contracts/src/task/generation-parameters/cards/index.ts
var BUILTIN_PRESET_CARDS = [
  ...IMAGE_CARDS,
  ...VIDEO_CARDS,
  ...AUDIO_CARDS
];

// ../../../../client/web/contracts/src/media/keys.ts
var DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
var DEFAULT_MAX_OUTPUT_BYTES = {
  image: 32 * 1024 * 1024,
  audio: 64 * 1024 * 1024,
  video: 256 * 1024 * 1024
};

// ../../../../client/web/contracts/src/canvas/render-scene/wire-model.ts
var DEFAULT_MODEL_PREVIEW = {
  azimuth: 0,
  elevation: Math.PI / 6,
  distanceScale: 1,
  targetOffset: [0, 0, 0]
};

// ../../../../client/web/contracts/src/canvas/domain/removed-node-data.ts
var NODE_DATA_REMOVED_FIELDS = ["groupBadgeScale"];

// ../../../../client/web/contracts/src/canvas/domain/core/composite-asset-identity.ts
var COMPOSITE_ASSET_NODE_TYPE = "composite-asset";
var FILM_SET_EXTENSION_ID = "film-set";
var CREATURE_VIDEO_ASSETS_EXTENSION_ID = "creature-video-assets";
var COMPOSITE_ASSET_EXTENSION_IDS = [FILM_SET_EXTENSION_ID, CREATURE_VIDEO_ASSETS_EXTENSION_ID];
function isCompositeAssetNodeType(type) {
  return type === COMPOSITE_ASSET_NODE_TYPE;
}
function readCompositeAssetExtensionId(nodeData) {
  if (typeof nodeData !== "object" || nodeData === null) return null;
  const id2 = nodeData.extensionId;
  return typeof id2 === "string" && COMPOSITE_ASSET_EXTENSION_IDS.includes(id2) ? id2 : null;
}
function isFilmSetNode(type, nodeData) {
  return isCompositeAssetNodeType(type) && readCompositeAssetExtensionId(nodeData) === FILM_SET_EXTENSION_ID && nodeData.compositeAssetRole === void 0;
}

// ../../../../client/web/contracts/src/canvas/domain/core/node-factory.ts
var DEFAULT_NODE_DIMS = { width: 260, height: 195 };
var MIN_NODE_WIDTH = 180;
var MIN_NODE_HEIGHT = 64;

// ../../../../client/web/contracts/src/canvas/domain/core/input-role.ts
function isPureModelNodeType(type, data) {
  return isCompositeAssetNodeType(type) && data?.compositeAssetRole !== "reference-container";
}

// ../../../../client/web/contracts/src/canvas/model-script.ts
var MODEL_SCRIPT_LANGUAGE = "javascript";
var MODEL_SCRIPT_V2_VERSION = "woohaa-model-js-v2";
var MODEL_SCRIPT_SCENE_IR_V2_VERSION = "woohaa-model-scene-ir-v2";
function isSupportedModelScriptVersion(version) {
  return version === MODEL_SCRIPT_V2_VERSION;
}
function sceneIrVersionFor(version) {
  return MODEL_SCRIPT_SCENE_IR_V2_VERSION;
}
function isWritableModelScriptLanguage(language, version) {
  return language === MODEL_SCRIPT_LANGUAGE && isSupportedModelScriptVersion(version);
}

// ../../../../client/web/contracts/src/canvas/model-executor.ts
function runVersionedModelScript(source, makeBuilder, validate) {
  const first = runOnceWith(source, makeBuilder, validate);
  if (!first.ok) return first;
  const second = runOnceWith(source, makeBuilder, validate);
  if (!second.ok) return second;
  if (first.json !== second.json) {
    return {
      ok: false,
      stage: "determinism",
      code: "non-deterministic",
      message: "\u540C\u4E00\u811A\u672C\u4E24\u6B21\u6267\u884C\u4EA7\u751F\u4E0D\u540C\u7684 Scene IR"
    };
  }
  return first;
}
function runOnceWith(source, makeBuilder, validate) {
  let compiled;
  try {
    const body = `${source}
;if (typeof build === "function") build(scene);`;
    compiled = new Function("scene", "rangeNum", body);
  } catch (error) {
    return {
      ok: false,
      stage: "compile",
      code: "syntax-error",
      message: error instanceof Error ? error.message : String(error)
    };
  }
  const builder = makeBuilder();
  try {
    compiled(builder, rangeNum);
  } catch (error) {
    return {
      ok: false,
      stage: "execute",
      code: "runtime-error",
      message: error instanceof Error ? error.message : String(error)
    };
  }
  const validation = validate(builder.raw());
  if (!validation.ok) {
    return {
      ok: false,
      stage: "validate",
      code: validation.code,
      message: validation.message
    };
  }
  return {
    ok: true,
    scene: validation.scene,
    json: validation.json,
    declaredIds: builder.declaredIds?.() ?? /* @__PURE__ */ new Set()
  };
}
function hashModelScript(source) {
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash << 5) + hash + source.charCodeAt(index) | 0;
  }
  return (hash >>> 0).toString(36);
}
function rangeNum(a, b, c) {
  const start = b === void 0 ? 0 : a;
  const end = b === void 0 ? a : b;
  const step = c ?? 1;
  const result = [];
  if (step === 0) return result;
  if (step > 0) {
    for (let value = start; value < end; value += step) result.push(value);
  } else {
    for (let value = start; value > end; value += step) result.push(value);
  }
  return result;
}

// ../../../../client/web/contracts/src/canvas/scene-ir-v2/types.ts
var SCENE_IR_V2_VERSION = MODEL_SCRIPT_SCENE_IR_V2_VERSION;
var SCENE_IR_V2_MAX_MESH_VERTICES = 65e3;
var SCENE_IR_V2_MAX_MESH_FACES = 13e4;
var SCENE_IR_V2_COORD_LIMIT = 1e6;
var SCENE_IR_V2_MIN_SEGMENT_LENGTH = 1e-4;
var CAPSULE_EPSILON = 1e-6;
var SCENE_IR_V2_MAX_EMISSIVE_STRENGTH = 32;
var PRIMITIVE_QUALITY = {
  /** UV 球经线分段。 */
  sphereSectors: 24,
  /** UV 球纬线分段（不含两极）。 */
  sphereRings: 12,
  /** 圆柱/胶囊侧面分段。 */
  capsuleSegments: 24,
  /** 半球纬线分段。 */
  hemisphereRings: 6
};
var QUALITY_VERTEX_COUNTS = {
  sphere: (PRIMITIVE_QUALITY.sphereRings + 1) * (PRIMITIVE_QUALITY.sphereSectors + 1) + 2,
  capsule: (PRIMITIVE_QUALITY.capsuleSegments + 1) * 2 + (PRIMITIVE_QUALITY.hemisphereRings + 1) * (PRIMITIVE_QUALITY.capsuleSegments + 1) * 2,
  cylinder: (PRIMITIVE_QUALITY.capsuleSegments + 1) * 2 + 2,
  box: 8
};
var V2_SHAPE_OPS = /* @__PURE__ */ new Set(["group", "box", "cylinder", "mesh", "sphere", "capsule", "segment"]);
var V2_ANIMATION_OPS = /* @__PURE__ */ new Set(["oscillate", "move", "rotate"]);
var AXES = /* @__PURE__ */ new Set(["x", "y", "z"]);
var MODES = /* @__PURE__ */ new Set(["position", "rotation", "scale"]);
var SEGMENT_SHAPES = /* @__PURE__ */ new Set(["box", "capsule"]);
var ALPHA_MODES = /* @__PURE__ */ new Set(["opaque", "blend"]);
var HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
function fail(code, message) {
  return { ok: false, code, message };
}
function isRecord(input) {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

// ../../../../client/web/contracts/src/canvas/model-transform.ts
var IDENTITY_QUAT = [0, 0, 0, 1];
function quatFromEulerYXZDegrees(rotation) {
  const [x, y, z] = rotation.map((value) => value * Math.PI / 180);
  return quatMul(quatMul(axisAngle([0, 1, 0], y), axisAngle([1, 0, 0], x)), axisAngle([0, 0, 1], z));
}
function axisAngle(axis, radians) {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (length === 0) return [...IDENTITY_QUAT];
  const half = radians / 2;
  const s = Math.sin(half) / length;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}
function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}
function quatRotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx)
  ];
}
function transformOf(local) {
  return {
    translation: [...local.position],
    rotation: quatFromEulerYXZDegrees(local.rotation),
    scale: [...local.scale]
  };
}
function composeTransform(parent, child) {
  const scaledChild = mulVec3(parent.scale, child.translation);
  const rotated = quatRotate(parent.rotation, scaledChild);
  return {
    translation: [
      parent.translation[0] + rotated[0],
      parent.translation[1] + rotated[1],
      parent.translation[2] + rotated[2]
    ],
    rotation: quatMul(parent.rotation, child.rotation),
    scale: mulVec3(parent.scale, child.scale)
  };
}
function transformPoint(transform, point) {
  const scaled = mulVec3(transform.scale, point);
  const rotated = quatRotate(transform.rotation, scaled);
  return [
    rotated[0] + transform.translation[0],
    rotated[1] + transform.translation[1],
    rotated[2] + transform.translation[2]
  ];
}
function aabbOfPoints(points) {
  if (points.length === 0) return null;
  const min = [...points[0]];
  const max = [...points[0]];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return { min, max };
}
function expandAabb(target, other) {
  for (let axis = 0; axis < 3; axis += 1) {
    target.min[axis] = Math.min(target.min[axis], other.min[axis]);
    target.max[axis] = Math.max(target.max[axis], other.max[axis]);
  }
}
function transformAabb(transform, box) {
  const corners = [];
  for (let i = 0; i < 8; i += 1) {
    const corner = [
      i & 1 ? box.max[0] : box.min[0],
      i & 2 ? box.max[1] : box.min[1],
      i & 4 ? box.max[2] : box.min[2]
    ];
    corners.push(transformPoint(transform, corner));
  }
  return aabbOfPoints(corners);
}
function mulVec3(a, b) {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}
function subVec3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function addVec3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scaleVec3(a, factor) {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}
function lengthVec3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function normalizeVec3(v) {
  const length = lengthVec3(v);
  return length === 0 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}
function crossVec3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
var UP = [0, 1, 0];
function quatAlignYTo(direction) {
  let d = normalizeVec3(direction);
  if (lengthVec3(d) === 0) return [...IDENTITY_QUAT];
  if (d[1] < 0 || d[1] === 0 && (d[0] < 0 || d[0] === 0 && d[2] < 0)) {
    d = [-d[0], -d[1], -d[2]];
  }
  const dot = d[1];
  if (dot < -1 + 1e-6) {
    return axisAngle([1, 0, 0], Math.PI);
  }
  if (dot > 1 - 1e-6) return [...IDENTITY_QUAT];
  const axis = normalizeVec3(crossVec3(UP, d));
  return axisAngle(axis, Math.acos(Math.max(-1, Math.min(1, dot))));
}

// ../../../../client/web/contracts/src/canvas/scene-ir-v2/reader.ts
function readMaterial(raw, index, existing) {
  const id2 = readId(raw.id);
  if (!id2) return fail("invalid-material", `\u7B2C ${index} \u4E2A material \u7F3A\u5C11\u5408\u6CD5 id`);
  if (existing.has(id2)) return fail("duplicate-material", `\u91CD\u590D\u7684 material id\uFF1A${id2}`);
  for (const key of Object.keys(raw)) {
    if (!["t", "id", "baseColor", "roughness", "metallic", "emissive", "emissiveStrength", "alphaMode", "doubleSided", "unlit", "opacity", "baseColorTexture"].includes(key)) {
      return fail("invalid-material", `material ${id2} \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
    }
  }
  const baseColor = readRequiredColor(raw.baseColor, "#ffffff", id2, "baseColor");
  if (!baseColor.ok) return baseColor;
  const emissive = readRequiredColor(raw.emissive, "#000000", id2, "emissive");
  if (!emissive.ok) return emissive;
  const roughness = readUnit(raw.roughness, 0.5, id2, "roughness");
  if (!roughness.ok) return roughness;
  const metallic = readUnit(raw.metallic, 0, id2, "metallic");
  if (!metallic.ok) return metallic;
  const strength = readNumber(raw.emissiveStrength, 0);
  if (strength === null || strength < 0 || strength > SCENE_IR_V2_MAX_EMISSIVE_STRENGTH) {
    return fail("invalid-material", `material ${id2} \u7684 emissiveStrength \u975E\u6CD5`);
  }
  const alphaMode = raw.alphaMode ?? "opaque";
  if (typeof alphaMode !== "string" || !ALPHA_MODES.has(alphaMode)) {
    return fail("invalid-material", `material ${id2} \u7684 alphaMode \u975E\u6CD5`);
  }
  if (raw.doubleSided !== void 0 && typeof raw.doubleSided !== "boolean") {
    return fail("invalid-material", `material ${id2} \u7684 doubleSided \u5FC5\u987B\u662F\u5E03\u5C14\u503C`);
  }
  if (raw.unlit !== void 0 && typeof raw.unlit !== "boolean") {
    return fail("invalid-material", `material ${id2} \u7684 unlit \u5FC5\u987B\u662F\u5E03\u5C14\u503C`);
  }
  const blend = alphaMode === "blend";
  let opacity;
  if (raw.opacity !== void 0 && raw.opacity !== null) {
    if (!blend) {
      return fail("invalid-material", `material ${id2} \u7684 opacity \u53EA\u7528\u4E8E alphaMode=blend`);
    }
    const value = readNumber(raw.opacity, null);
    if (value === null || value < 0 || value > 1) {
      return fail("invalid-material", `material ${id2} \u7684 opacity \u5FC5\u987B\u5728 0..1`);
    }
    opacity = value;
  }
  let baseColorTexture;
  if (raw.baseColorTexture !== void 0 && raw.baseColorTexture !== null) {
    const textureId = readTextureId(raw.baseColorTexture);
    if (textureId === null) {
      return fail("invalid-material", `material ${id2} \u7684 baseColorTexture \u975E\u6CD5`);
    }
    baseColorTexture = textureId;
  }
  return {
    ok: true,
    value: {
      t: "material",
      id: id2,
      baseColor: baseColor.value,
      roughness: roughness.value,
      metallic: metallic.value,
      emissive: emissive.value,
      emissiveStrength: strength,
      alphaMode,
      doubleSided: raw.doubleSided === true,
      // 只在显式声明时写入规范 op：旧场景的 Scene IR 与内容身份逐字节不变（D4）。
      ...raw.unlit === true ? { unlit: true } : {},
      ...opacity === void 0 ? {} : { opacity },
      ...baseColorTexture === void 0 ? {} : { baseColorTexture }
    }
  };
}
var TEXTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
function readTextureId(input) {
  return typeof input === "string" && TEXTURE_ID.test(input) ? input : null;
}
function readRequiredColor(raw, fallback, materialId, field) {
  if (raw === void 0 || raw === null) return { ok: true, value: fallback };
  const color = readColor(raw);
  if (!color) return fail("invalid-material", `material ${materialId} \u7684 ${field} \u975E\u6CD5`);
  return { ok: true, value: color };
}
function readUnit(raw, fallback, materialId, field) {
  if (raw === void 0 || raw === null) return { ok: true, value: fallback };
  const value = readNumber(raw, null);
  if (value === null || value < 0 || value > 1) {
    return fail("invalid-material", `material ${materialId} \u7684 ${field} \u5FC5\u987B\u5728 0..1`);
  }
  return { ok: true, value };
}
function readShape(raw, index, t, shapeIds, materialIds, parentOf) {
  const id2 = readId(raw.id);
  if (!id2) return fail("invalid-id", `\u7B2C ${index} \u4E2A op \u7F3A\u5C11\u5408\u6CD5 id`);
  if (shapeIds.has(id2)) return fail("duplicate-id", `\u91CD\u590D\u7684\u5BF9\u8C61 id\uFF1A${id2}`);
  let parent;
  if (raw.parent === void 0 || raw.parent === null) {
    parent = null;
  } else if (typeof raw.parent === "string" && raw.parent !== "") {
    if (!shapeIds.has(raw.parent)) {
      return fail("invalid-parent", `\u5BF9\u8C61 ${id2} \u7684 parent ${raw.parent} \u672A\u5B9A\u4E49\u6216\u540E\u7F6E`);
    }
    parent = raw.parent;
  } else {
    return fail("invalid-parent", `\u5BF9\u8C61 ${id2} \u7684 parent \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6216 null`);
  }
  const position = readVec3(raw.position, [0, 0, 0]);
  if (!position) return fail("invalid-vector", `\u5BF9\u8C61 ${id2} \u7684 position \u975E\u6CD5`);
  const rotation = readVec3(raw.rotation, [0, 0, 0]);
  if (!rotation) return fail("invalid-vector", `\u5BF9\u8C61 ${id2} \u7684 rotation \u975E\u6CD5`);
  const scale = readVec3(raw.scale, [1, 1, 1]);
  if (!scale) return fail("invalid-vector", `\u5BF9\u8C61 ${id2} \u7684 scale \u975E\u6CD5`);
  let material = null;
  let color = null;
  if (raw.material !== void 0 && raw.material !== null) {
    if (typeof raw.material !== "string" || raw.material === "") {
      return fail("missing-material", `\u5BF9\u8C61 ${id2} \u7684 material \u5FC5\u987B\u662F material ID \u5B57\u7B26\u4E32`);
    }
    if (!materialIds.has(raw.material)) {
      return fail("missing-material", `\u5BF9\u8C61 ${id2} \u5F15\u7528\u4E86\u672A\u58F0\u660E\u6216\u540E\u7F6E\u7684 material ${raw.material}`);
    }
    material = raw.material;
  }
  if (raw.color !== void 0 && raw.color !== null) {
    const parsed = readColor(raw.color);
    if (!parsed) return fail("invalid-color", `\u5BF9\u8C61 ${id2} \u7684 color \u975E\u6CD5`);
    color = parsed;
  }
  if (material !== null && color !== null) {
    return fail("invalid-material", `\u5BF9\u8C61 ${id2} \u4E0D\u5F97\u540C\u65F6\u63D0\u4F9B material \u4E0E color`);
  }
  const base = { id: id2, parent, position, rotation, scale, material, color: color ?? (material === null ? "#cccccc" : null) };
  if (t === "group") return { ok: true, value: { t: "group", ...base } };
  if (t === "box") {
    const size = readVec3(raw.size, [1, 1, 1]);
    if (!size || size.some((value) => value <= 0)) return fail("invalid-primitive", `\u5BF9\u8C61 ${id2} \u7684 size \u975E\u6CD5`);
    return { ok: true, value: { t: "box", ...base, size } };
  }
  if (t === "cylinder") {
    const radius = readPositive(raw.radius, 1);
    const height = readPositive(raw.height, 1);
    if (radius === null || height === null) return fail("invalid-primitive", `\u5BF9\u8C61 ${id2} \u7684 cylinder \u534A\u5F84/\u9AD8\u5EA6\u975E\u6CD5`);
    return { ok: true, value: { t: "cylinder", ...base, radius, height } };
  }
  if (t === "sphere") {
    const radius = readPositive(raw.radius, null);
    if (radius === null) return fail("invalid-primitive", `\u5BF9\u8C61 ${id2} \u7684 sphere \u534A\u5F84\u975E\u6CD5`);
    return { ok: true, value: { t: "sphere", ...base, radius } };
  }
  if (t === "capsule") {
    const radius = readPositive(raw.radius, null);
    const height = readPositive(raw.height, null);
    if (radius === null || height === null) return fail("invalid-primitive", `\u5BF9\u8C61 ${id2} \u7684 capsule \u5C3A\u5BF8\u975E\u6CD5`);
    if (height + CAPSULE_EPSILON < radius * 2) {
      return fail("invalid-primitive", `\u5BF9\u8C61 ${id2} \u7684 capsule \u603B\u9AD8\u5EA6\u4E0D\u5F97\u5C0F\u4E8E\u76F4\u5F84`);
    }
    return { ok: true, value: { t: "capsule", ...base, radius, height } };
  }
  if (t === "segment") {
    return readSegment(raw, id2, base);
  }
  const vertices = readVertices(raw.vertices);
  if (!vertices) return fail("invalid-mesh", `\u5BF9\u8C61 ${id2} \u7684 vertices \u975E\u6CD5`);
  if (vertices.length === 0) return fail("invalid-mesh", `\u5BF9\u8C61 ${id2} \u7684 mesh \u9700\u8981\u81F3\u5C11\u4E00\u4E2A\u9876\u70B9`);
  const faces = readFaces(raw.faces, vertices.length);
  if (!faces) return fail("invalid-mesh", `\u5BF9\u8C61 ${id2} \u7684 faces \u975E\u6CD5`);
  if (faces.length === 0) return fail("invalid-mesh", `\u5BF9\u8C61 ${id2} \u7684 mesh \u9700\u8981\u81F3\u5C11\u4E00\u4E2A\u9762`);
  if (vertices.length > SCENE_IR_V2_MAX_MESH_VERTICES) {
    return fail("mesh-too-large", `mesh ${id2} \u9876\u70B9\u6570 ${vertices.length} \u8D85\u8FC7\u4E0A\u9650`);
  }
  if (faces.length > SCENE_IR_V2_MAX_MESH_FACES) {
    return fail("mesh-too-large", `mesh ${id2} \u9762\u6570 ${faces.length} \u8D85\u8FC7\u4E0A\u9650`);
  }
  const attributes = readMeshAttributes(raw, id2, vertices.length);
  if (!attributes.ok) return attributes;
  return { ok: true, value: { t: "mesh", ...base, vertices, faces, ...attributes.value } };
}
function readMeshAttributes(raw, id2, vertexCount) {
  const result = {};
  if (raw.normals !== void 0 && raw.normals !== null) {
    const normals = readNormals(raw.normals);
    if (!normals || normals.length !== vertexCount) {
      return fail("invalid-mesh", `\u5BF9\u8C61 ${id2} \u7684 normals \u6570\u91CF\u5FC5\u987B\u4E0E\u9876\u70B9\u6570\u4E00\u81F4`);
    }
    result.normals = normals;
  }
  if (raw.uvs !== void 0 && raw.uvs !== null) {
    const uvs = readUvs(raw.uvs);
    if (!uvs || uvs.length !== vertexCount) {
      return fail("invalid-mesh", `\u5BF9\u8C61 ${id2} \u7684 uvs \u6570\u91CF\u5FC5\u987B\u4E0E\u9876\u70B9\u6570\u4E00\u81F4`);
    }
    result.uvs = uvs;
  }
  if (raw.colors !== void 0 && raw.colors !== null) {
    const colors = readColors(raw.colors);
    if (!colors || colors.length !== vertexCount) {
      return fail("invalid-mesh", `\u5BF9\u8C61 ${id2} \u7684 colors \u6570\u91CF\u5FC5\u987B\u4E0E\u9876\u70B9\u6570\u4E00\u81F4`);
    }
    result.colors = colors;
  }
  return { ok: true, value: result };
}
function readNormals(input) {
  if (!Array.isArray(input)) return null;
  const normals = [];
  for (const entry of input) {
    const vec = readVec3(entry, null);
    if (!vec || vec.some((value) => value < -1.0001 || value > 1.0001)) return null;
    normals.push(vec);
  }
  return normals;
}
function readUvs(input) {
  if (!Array.isArray(input)) return null;
  const uvs = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const u = readNumber(entry[0], null);
    const v = readNumber(entry[1], null);
    if (u === null || v === null) return null;
    uvs.push([u, v]);
  }
  return uvs;
}
function readColors(input) {
  if (!Array.isArray(input)) return null;
  const colors = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length < 4) return null;
    const values = [];
    for (let index = 0; index < 4; index += 1) {
      const value = readNumber(entry[index], null);
      if (value === null || value < 0 || value > 1) return null;
      values.push(value);
    }
    colors.push([values[0], values[1], values[2], values[3]]);
  }
  return colors;
}
function readSegment(raw, id2, base) {
  const from = readVec3(raw.from, null);
  const to = readVec3(raw.to, null);
  if (!from || !to) return fail("invalid-primitive", `segment ${id2} \u7684 from/to \u975E\u6CD5`);
  if (lengthVec3(subVec3(to, from)) < SCENE_IR_V2_MIN_SEGMENT_LENGTH) {
    return fail("degenerate-segment", `segment ${id2} \u7684 from \u4E0E to \u76F8\u540C\u6216\u8FC7\u8FD1`);
  }
  const width = readPositive(raw.width, null);
  if (width === null) return fail("invalid-primitive", `segment ${id2} \u7684 width \u975E\u6CD5`);
  const depth = raw.depth === void 0 || raw.depth === null ? width : readPositive(raw.depth, null);
  if (depth === null) return fail("invalid-primitive", `segment ${id2} \u7684 depth \u975E\u6CD5`);
  const shape = raw.shape ?? "capsule";
  if (typeof shape !== "string" || !SEGMENT_SHAPES.has(shape)) {
    return fail("invalid-primitive", `segment ${id2} \u7684 shape \u5FC5\u987B\u662F box \u6216 capsule`);
  }
  let overlap = 0;
  if (raw.overlap !== void 0 && raw.overlap !== null) {
    const value = readNumber(raw.overlap, null);
    if (value === null || value < 0) return fail("invalid-primitive", `segment ${id2} \u7684 overlap \u975E\u6CD5`);
    overlap = value;
  }
  return { ok: true, value: { t: "segment", ...base, from, to, width, depth, shape, overlap } };
}
function readAnimation(raw, index, shapeIds) {
  const id2 = readId(raw.id);
  if (!id2) return fail("invalid-id", `\u7B2C ${index} \u4E2A\u52A8\u753B\u7F3A\u5C11\u5408\u6CD5\u76EE\u6807 id`);
  if (!shapeIds.has(id2)) {
    return fail("animation-before-target", `\u7B2C ${index} \u4E2A\u52A8\u753B\u6307\u5411\u672A\u5B9A\u4E49\u6216\u540E\u7F6E\u7684\u5BF9\u8C61 ${id2}`);
  }
  const axis = raw.axis === void 0 ? "y" : raw.axis;
  if (typeof axis !== "string" || !AXES.has(axis)) return fail("invalid-number", `\u52A8\u753B ${id2} \u7684 axis \u975E\u6CD5`);
  const op = { t: raw.t, id: id2, axis };
  if (raw.mode !== void 0) {
    if (typeof raw.mode !== "string" || !MODES.has(raw.mode)) return fail("invalid-number", `\u52A8\u753B ${id2} \u7684 mode \u975E\u6CD5`);
    op.mode = raw.mode;
  }
  for (const key of ["amplitude", "speed", "phase"]) {
    if (raw[key] === void 0) continue;
    const value = readNumber(raw[key], 0);
    if (value === null) return fail("invalid-number", `\u52A8\u753B ${id2} \u7684 ${key} \u975E\u6CD5`);
    op[key] = value;
  }
  if (raw.range !== void 0) {
    if (!Array.isArray(raw.range) || raw.range.length !== 2) return fail("invalid-number", `\u52A8\u753B ${id2} \u7684 range \u975E\u6CD5`);
    const start = readNumber(raw.range[0], 0);
    const end = readNumber(raw.range[1], 0);
    if (start === null || end === null) return fail("invalid-number", `\u52A8\u753B ${id2} \u7684 range \u975E\u6CD5`);
    op.range = [start, end];
  }
  return { ok: true, value: op };
}
function readId(input) {
  if (typeof input !== "string") return null;
  const value = input.trim();
  return value.length > 0 ? value : null;
}
function readVec3(input, fallback) {
  if (input === void 0 || input === null) return fallback ? [...fallback] : null;
  if (!Array.isArray(input) || input.length < 3) return null;
  const values = [];
  for (let i = 0; i < 3; i += 1) {
    const value = readNumber(input[i], null);
    if (value === null) return null;
    values.push(value);
  }
  return [values[0], values[1], values[2]];
}
function readVertices(input) {
  if (!Array.isArray(input)) return null;
  const vertices = [];
  for (const entry of input) {
    const vec = readVec3(entry, null);
    if (!vec) return null;
    vertices.push(vec);
  }
  return vertices;
}
function readFaces(input, vertexCount) {
  if (!Array.isArray(input)) return null;
  const faces = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length < 3) return null;
    const face = [];
    for (const rawIndex of entry) {
      if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= vertexCount) {
        return null;
      }
      face.push(rawIndex);
    }
    faces.push(face);
  }
  return faces;
}
function readNumber(input, fallback) {
  if (input === void 0 || input === null) return fallback;
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  if (Math.abs(input) > SCENE_IR_V2_COORD_LIMIT) return null;
  return input;
}
function readPositive(input, fallback) {
  const value = readNumber(input, fallback);
  return value === null || value <= 0 ? null : value;
}
function readColor(input) {
  if (typeof input !== "string" || !HEX_COLOR.test(input)) return null;
  return normalizeHex(input);
}
function normalizeHex(value) {
  const source = value.replace(/^#/, "").toLowerCase();
  const expanded = source.length === 3 ? source.split("").map((char) => char + char).join("") : source;
  return `#${expanded}`;
}

// ../../../../client/web/contracts/src/canvas/scene-ir-v2/validator.ts
function validateModelSceneIrV2(input) {
  if (!isRecord(input)) return fail("not-object", "Scene IR \u5FC5\u987B\u662F\u5BF9\u8C61");
  if (input.version !== SCENE_IR_V2_VERSION) {
    return fail("version-mismatch", `\u672A\u77E5 Scene IR \u7248\u672C ${String(input.version)}`);
  }
  if (!Array.isArray(input.ops)) return fail("ops-not-array", "ops \u5FC5\u987B\u662F\u6570\u7EC4");
  const ops = [];
  const shapeIds = /* @__PURE__ */ new Set();
  const materialIds = /* @__PURE__ */ new Set();
  const parentOf = /* @__PURE__ */ new Map();
  for (let index = 0; index < input.ops.length; index += 1) {
    const raw = input.ops[index];
    if (!isRecord(raw)) return fail("unknown-op", `\u7B2C ${index} \u4E2A op \u4E0D\u662F\u5BF9\u8C61`);
    const t = raw.t;
    if (typeof t !== "string") return fail("unknown-op", `\u7B2C ${index} \u4E2A op \u7F3A\u5C11\u7C7B\u578B`);
    if (t === "material") {
      const material = readMaterial(raw, index, materialIds);
      if (!material.ok) return material;
      materialIds.add(material.value.id);
      ops.push(material.value);
      continue;
    }
    if (V2_ANIMATION_OPS.has(t)) {
      const animation = readAnimation(raw, index, shapeIds);
      if (!animation.ok) return animation;
      ops.push(animation.value);
      continue;
    }
    if (!V2_SHAPE_OPS.has(t)) return fail("unknown-op", `\u7B2C ${index} \u4E2A op \u7C7B\u578B\u672A\u77E5\uFF1A${t}`);
    const shape = readShape(raw, index, t, shapeIds, materialIds, parentOf);
    if (!shape.ok) return shape;
    const op = shape.value;
    shapeIds.add(op.id);
    parentOf.set(op.id, op.parent);
    ops.push(op);
  }
  for (const id2 of shapeIds) {
    const seen = /* @__PURE__ */ new Set([id2]);
    let cursor = parentOf.get(id2) ?? null;
    while (cursor !== null) {
      if (seen.has(cursor)) return fail("parent-cycle", `\u7236\u5B50\u5173\u7CFB\u5B58\u5728\u73AF\uFF1A${id2}`);
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  return { ok: true, scene: { version: SCENE_IR_V2_VERSION, ops } };
}

// ../../../../client/web/contracts/src/canvas/scene-ir-v2/bounds.ts
function v2SceneAabb(ops) {
  const worldOf = /* @__PURE__ */ new Map();
  let result = null;
  for (const op of ops) {
    if (!isV2ShapeOp(op)) continue;
    const local = localTransformOf(op);
    const parent = op.parent === null ? null : worldOf.get(op.parent) ?? null;
    const world = parent ? composeTransform(parent, local) : local;
    worldOf.set(op.id, world);
    const box = shapeLocalAabb(op);
    if (box === null) continue;
    const transformed = transformAabb(world, box);
    if (result === null) result = transformed;
    else expandAabb(result, transformed);
  }
  return result;
}
function isV2ShapeOp(op) {
  return V2_SHAPE_OPS.has(op.t);
}
function v2ExtentFromAabb(box) {
  if (box === null) return 2;
  let extent = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    extent = Math.max(extent, Math.abs(box.min[axis]), Math.abs(box.max[axis]));
  }
  return Math.max(1, extent * 2);
}
function localTransformOf(op) {
  if (op.t === "segment") {
    const segment = segmentLocalTransform(op);
    if (segment) return segment;
  }
  return transformOf(localOfShape(op));
}
function segmentLocalTransform(op) {
  const direction = subVec3(op.to, op.from);
  if (lengthVec3(direction) <= 1e-4) return null;
  return {
    translation: scaleVec3(addVec3(op.from, op.to), 0.5),
    rotation: quatAlignYTo(direction),
    scale: [...op.scale]
  };
}
function localOfShape(op) {
  return { position: op.position, rotation: op.rotation, scale: op.scale };
}
function shapeLocalAabb(op) {
  switch (op.t) {
    case "group":
      return null;
    case "box":
      return { min: scaleVec3(op.size, -0.5), max: scaleVec3(op.size, 0.5) };
    case "cylinder":
      return { min: [-op.radius, -op.height / 2, -op.radius], max: [op.radius, op.height / 2, op.radius] };
    case "sphere":
      return { min: [-op.radius, -op.radius, -op.radius], max: [op.radius, op.radius, op.radius] };
    case "capsule":
      return { min: [-op.radius, -op.height / 2, -op.radius], max: [op.radius, op.height / 2, op.radius] };
    case "mesh":
      return aabbOfPoints(op.vertices);
    case "segment": {
      const halfLength = lengthVec3(subVec3(op.to, op.from)) / 2 + op.overlap;
      const halfWidth = op.width / 2;
      const halfDepth = op.shape === "capsule" ? halfWidth : op.depth / 2;
      return { min: [-halfWidth, -halfLength, -halfDepth], max: [halfWidth, halfLength, halfDepth] };
    }
    default:
      return null;
  }
}

// ../../../../client/web/contracts/src/canvas/model-executor-v2.ts
var SceneBuilderV2 = class {
  ops = [];
  explicitIds = /* @__PURE__ */ new Set();
  sequence = 0;
  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }
  shape(t, options = {}) {
    const explicit = asExplicitId(options.id);
    const id2 = explicit ?? this.nextId(t);
    if (explicit) this.explicitIds.add(id2);
    const { id: _ignored, ...rest } = options;
    this.ops.push({ ...rest, t, id: id2 });
    return id2;
  }
  material(options = {}) {
    const explicit = asExplicitId(options.id);
    const id2 = explicit ?? this.nextId("material");
    if (explicit) this.explicitIds.add(id2);
    const { id: _ignored, ...rest } = options;
    this.ops.push({ ...rest, t: "material", id: id2 });
    return id2;
  }
  group(options = {}) {
    return this.shape("group", options);
  }
  box(options = {}) {
    return this.shape("box", options);
  }
  cylinder(options = {}) {
    return this.shape("cylinder", options);
  }
  sphere(options = {}) {
    return this.shape("sphere", options);
  }
  capsule(options = {}) {
    return this.shape("capsule", options);
  }
  segment(options = {}) {
    return this.shape("segment", options);
  }
  mesh(options = {}) {
    return this.shape("mesh", options);
  }
  oscillate(id2, options = {}) {
    return this.animation("oscillate", id2, options);
  }
  move(id2, options = {}) {
    return this.animation("move", id2, options);
  }
  rotate(id2, options = {}) {
    return this.animation("rotate", id2, options);
  }
  animation(t, id2, options) {
    const { id: _ignored, ...rest } = options;
    this.ops.push({ ...rest, t, id: id2 });
    return id2;
  }
  /** 原始 op 列表（校验前）。 */
  raw() {
    return [...this.ops];
  }
  /** 作者显式声明的部件 ID 集合（change: 2026-10-06，任务 1.5）。 */
  declaredIds() {
    return this.explicitIds;
  }
};
function executeModelScriptV2(source) {
  return runVersionedModelScript(source, () => new SceneBuilderV2(), (ops) => {
    const validation = validateModelSceneIrV2({ version: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops });
    if (!validation.ok) {
      return { ok: false, code: validation.code, message: validation.message };
    }
    return { ok: true, scene: validation.scene, json: JSON.stringify(validation.scene) };
  });
}
function executeModelScriptVersioned(source, version) {
  if (!isSupportedModelScriptVersion(version)) {
    return {
      ok: false,
      stage: "compile",
      code: "version-mismatch",
      message: `\u4E0D\u652F\u6301\u7684 modelScriptVersion ${String(version)}`
    };
  }
  return executeModelScriptV2(source);
}
function asExplicitId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ../../../../client/web/contracts/src/canvas/content-hash.ts
function fnv1a64Hex(text) {
  let high = 3421674724;
  let low = 2216829733;
  for (let i = 0; i < text.length; i += 1) {
    low = (low ^ text.charCodeAt(i)) >>> 0;
    const product = low * 435;
    high = Math.imul(high, 435) + (low << 8) + Math.floor(product / 4294967296) >>> 0;
    low = product >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

// ../../../../client/web/contracts/src/canvas/prepared-model.ts
var PREPARED_MODEL_RESOURCE_VERSION = "woohaa-prepared-model-resource-v1";
function prepareModelResource(input) {
  const canonical = `${input.sceneVersion}:${JSON.stringify(input.ops)}`;
  const signature = fnv1a64Hex(canonical);
  const aabb = v2SceneAabb(input.ops);
  const extent = v2ExtentFromAabb(aabb);
  const resourceKey = `${input.sceneVersion}:${signature}`;
  const resource = {
    resourceVersion: PREPARED_MODEL_RESOURCE_VERSION,
    sceneVersion: input.sceneVersion,
    signature,
    resourceKey,
    ops: input.ops,
    aabb,
    extent,
    payload: ""
  };
  resource.payload = modelResourcePayload(resource);
  return resource;
}
function modelResourcePayload(resource) {
  return JSON.stringify({
    resourceVersion: resource.resourceVersion,
    resourceKey: resource.resourceKey,
    sceneVersion: resource.sceneVersion,
    signature: resource.signature,
    extent: resource.extent,
    aabb: resource.aabb,
    ops: resource.ops
  });
}

// ../../../../client/web/contracts/src/canvas/film-set-content/types.ts
var MAX_FILM_SET_BYTES = 1 << 20;
var MAX_FILM_SET_TOTAL_SOURCE_BYTES = 1 << 20;
var DEFAULT_FILM_SET_LOCAL_TRANSFORM = {
  offset: { x: 0, y: 0, z: 0 },
  scale: 1,
  yaw: 0
};

// ../../../../client/web/contracts/src/canvas/model-definition.ts
var DEFAULT_MODEL_PLACEMENT = {
  offset: { x: 0, y: 0, z: 0 },
  scale: 1,
  yaw: 0
};
var MODEL_CONTENT_HASH_MAX = 200;
var MODEL_CONTENT_REVISION_MAX = 1e6;
function decodeLocalModelPlacement(input) {
  if (input === void 0 || input === null) return { ok: true, value: clonePlacement(DEFAULT_MODEL_PLACEMENT) };
  if (!isJsonObject(input)) return { ok: false, reason: "modelPlacement \u5FC5\u987B\u662F\u5BF9\u8C61" };
  const rawOffset = input.offset;
  let offset = { x: 0, y: 0, z: 0 };
  if (rawOffset !== void 0 && rawOffset !== null) {
    if (!isJsonObject(rawOffset)) return { ok: false, reason: "modelPlacement.offset \u5FC5\u987B\u662F\u5BF9\u8C61" };
    const { x, y, z } = rawOffset;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
      return { ok: false, reason: "modelPlacement.offset \u5FC5\u987B\u662F\u4E09\u5206\u91CF\u6709\u9650\u6570\u503C" };
    }
    offset = { x, y, z };
  }
  const scale = input.scale === void 0 || input.scale === null ? 1 : input.scale;
  if (!isFiniteNumber(scale) || scale <= 0) {
    return { ok: false, reason: "modelPlacement.scale \u5FC5\u987B\u662F\u6B63\u6709\u9650\u6570\u503C" };
  }
  const yaw = input.yaw === void 0 || input.yaw === null ? 0 : input.yaw;
  if (!isFiniteNumber(yaw)) return { ok: false, reason: "modelPlacement.yaw \u5FC5\u987B\u662F\u6709\u9650\u6570\u503C" };
  return { ok: true, value: { offset, scale, yaw } };
}
function decodeModelContentVersion(input) {
  if (!isJsonObject(input)) return { ok: false, reason: "modelContentVersion \u5FC5\u987B\u662F\u5BF9\u8C61" };
  const { revision, sourceHash, contentHash } = input;
  if (!isNonNegativeInteger(revision) || revision < 1 || revision > MODEL_CONTENT_REVISION_MAX) {
    return { ok: false, reason: "modelContentVersion.revision \u5FC5\u987B\u662F\u6B63\u6574\u6570" };
  }
  if (!isBoundedId(sourceHash, MODEL_CONTENT_HASH_MAX)) {
    return { ok: false, reason: "modelContentVersion.sourceHash \u975E\u6CD5" };
  }
  if (!isBoundedId(contentHash, MODEL_CONTENT_HASH_MAX)) {
    return { ok: false, reason: "modelContentVersion.contentHash \u975E\u6CD5" };
  }
  return { ok: true, value: { revision, sourceHash, contentHash } };
}
function decodeModelDefinition(input) {
  if (!isJsonObject(input)) return { ok: false, reason: "nodeData \u5FC5\u987B\u662F\u5BF9\u8C61" };
  const { modelScript, modelScriptLanguage, modelScriptVersion } = input;
  if (typeof modelScript !== "string") return { ok: false, reason: "modelScript \u5FC5\u987B\u662F\u5B57\u7B26\u4E32" };
  if (!isWritableModelScriptLanguage(modelScriptLanguage, modelScriptVersion)) {
    return { ok: false, reason: `\u4E0D\u652F\u6301\u7684\u6A21\u578B\u811A\u672C\u8BED\u8A00/\u7248\u672C ${String(modelScriptLanguage)} / ${String(modelScriptVersion)}` };
  }
  const contentVersion = decodeModelContentVersion(input.modelContentVersion);
  if (!contentVersion.ok) return contentVersion;
  const placement = decodeLocalModelPlacement(input.modelPlacement);
  if (!placement.ok) return placement;
  return {
    ok: true,
    value: {
      modelScript,
      modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
      modelScriptVersion,
      contentVersion: contentVersion.value,
      placement: placement.value
    }
  };
}
function modelSourceHash(modelScript) {
  return hashModelScript(modelScript);
}
function modelContentHash(input) {
  const canonical = [
    "woohaa-model-content-v1",
    input.modelScriptLanguage,
    input.modelScriptVersion,
    input.modelScript,
    placementKey(input.placement)
  ].join("\0");
  return fnv1a64Hex(canonical);
}
function deriveModelContentVersion(input) {
  return {
    revision: input.revision,
    sourceHash: modelSourceHash(input.modelScript),
    contentHash: modelContentHash(input)
  };
}
function placementKey(placement) {
  const { offset, scale, yaw } = placement;
  return `${offset.x},${offset.y},${offset.z},${scale},${yaw}`;
}
function clonePlacement(placement) {
  return { offset: { ...placement.offset }, scale: placement.scale, yaw: placement.yaw };
}

// ../../../../client/web/contracts/src/canvas/motion-script.ts
var MOTION_SCRIPT_LANGUAGE = "javascript";
var MOTION_SCRIPT_VERSION = "woohaa-motion-js-v1";
var MOTION_REVISION_MAX = 1e6;
var MOTION_HASH_MAX = 200;
function isSupportedMotionScript(language, version) {
  return language === MOTION_SCRIPT_LANGUAGE && version === MOTION_SCRIPT_VERSION;
}
function decodeMotionDefinition(input) {
  if (!isJsonObject(input)) return { ok: false, reason: "nodeData \u5FC5\u987B\u662F\u5BF9\u8C61" };
  const { motionScript, motionScriptLanguage, motionScriptVersion, motionRevision, motionSourceHash } = input;
  if (typeof motionScript !== "string") return { ok: false, reason: "motionScript \u5FC5\u987B\u662F\u5B57\u7B26\u4E32" };
  if (!isSupportedMotionScript(motionScriptLanguage, motionScriptVersion)) {
    return {
      ok: false,
      reason: `\u4E0D\u652F\u6301\u7684 motionScript \u8BED\u8A00/\u7248\u672C ${String(motionScriptLanguage)} / ${String(motionScriptVersion)}`
    };
  }
  if (!isNonNegativeInteger(motionRevision) || motionRevision < 1 || motionRevision > MOTION_REVISION_MAX) {
    return { ok: false, reason: "motionRevision \u5FC5\u987B\u662F\u6B63\u6574\u6570" };
  }
  if (!isBoundedId(motionSourceHash, MOTION_HASH_MAX)) {
    return { ok: false, reason: "motionSourceHash \u975E\u6CD5" };
  }
  const basedOn = decodeBasedOnModelVersion(input.motionBasedOnModelVersion);
  if (!basedOn.ok) return basedOn;
  return {
    ok: true,
    value: {
      motionScript,
      motionScriptLanguage: MOTION_SCRIPT_LANGUAGE,
      motionScriptVersion: MOTION_SCRIPT_VERSION,
      revision: motionRevision,
      sourceHash: motionSourceHash,
      basedOnModelVersion: basedOn.value
    }
  };
}
function decodeBasedOnModelVersion(input) {
  if (!isJsonObject(input)) return { ok: false, reason: "motionBasedOnModelVersion \u5FC5\u987B\u662F\u5BF9\u8C61" };
  const { revision, contentHash } = input;
  if (!isNonNegativeInteger(revision) || revision < 1 || revision > MOTION_REVISION_MAX) {
    return { ok: false, reason: "motionBasedOnModelVersion.revision \u5FC5\u987B\u662F\u6B63\u6574\u6570" };
  }
  if (!isBoundedId(contentHash, MOTION_HASH_MAX)) {
    return { ok: false, reason: "motionBasedOnModelVersion.contentHash \u975E\u6CD5" };
  }
  return { ok: true, value: { revision, contentHash } };
}

// ../../../../client/web/contracts/src/canvas/film-set-content/codec.ts
function cloneFilmSetLocalTransform(transform) {
  return { offset: { ...transform.offset }, scale: transform.scale, yaw: transform.yaw };
}
function decodeFilmSetLocalTransform(input) {
  if (input === void 0 || input === null) {
    return { ok: true, value: cloneFilmSetLocalTransform(DEFAULT_FILM_SET_LOCAL_TRANSFORM) };
  }
  if (!isJsonObject(input)) return { ok: false, reason: "localTransform \u5FC5\u987B\u662F\u5BF9\u8C61" };
  const rawOffset = input.offset;
  let offset = { x: 0, y: 0, z: 0 };
  if (rawOffset !== void 0 && rawOffset !== null) {
    if (!isJsonObject(rawOffset)) return { ok: false, reason: "localTransform.offset \u5FC5\u987B\u662F\u5BF9\u8C61" };
    const { x, y, z } = rawOffset;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
      return { ok: false, reason: "localTransform.offset \u5FC5\u987B\u662F\u4E09\u5206\u91CF\u6709\u9650\u6570\u503C" };
    }
    offset = { x, y, z };
  }
  const scale = input.scale === void 0 || input.scale === null ? 1 : input.scale;
  if (!isFiniteNumber(scale) || scale <= 0) {
    return { ok: false, reason: "localTransform.scale \u5FC5\u987B\u662F\u6B63\u6709\u9650\u6570\u503C" };
  }
  const yaw = input.yaw === void 0 || input.yaw === null ? 0 : input.yaw;
  if (!isFiniteNumber(yaw)) return { ok: false, reason: "localTransform.yaw \u5FC5\u987B\u662F\u6709\u9650\u6570\u503C" };
  return { ok: true, value: { offset, scale, yaw } };
}
function decodeFilmSetPlayback(input, itemId = "") {
  if (input === void 0 || input === null) return { ok: true, value: void 0 };
  if (!isJsonObject(input)) return { ok: false, reason: `\u7247\u573A\u5BF9\u8C61 ${itemId} playback \u5FC5\u987B\u662F\u5BF9\u8C61` };
  const startTime = input.startTime ?? 0;
  if (!isFiniteNumber(startTime) || startTime < 0) {
    return { ok: false, reason: `\u7247\u573A\u5BF9\u8C61 ${itemId} playback.startTime \u5FC5\u987B\u662F\u975E\u8D1F\u6709\u9650\u6570\u503C` };
  }
  const duration = input.duration ?? 0;
  if (!isFiniteNumber(duration) || duration < 0) {
    return { ok: false, reason: `\u7247\u573A\u5BF9\u8C61 ${itemId} playback.duration \u5FC5\u987B\u662F\u975E\u8D1F\u6709\u9650\u6570\u503C` };
  }
  const timeScale = input.timeScale ?? 1;
  if (!isFiniteNumber(timeScale) || timeScale <= 0) {
    return { ok: false, reason: `\u7247\u573A\u5BF9\u8C61 ${itemId} playback.timeScale \u5FC5\u987B\u662F\u6B63\u6709\u9650\u6570\u503C` };
  }
  const loop = input.loop ?? false;
  if (typeof loop !== "boolean") return { ok: false, reason: `\u7247\u573A\u5BF9\u8C61 ${itemId} playback.loop \u5FC5\u987B\u662F\u5E03\u5C14\u503C` };
  return { ok: true, value: { startTime, duration, timeScale, loop } };
}
function decodeFilmSetMotion(input, itemId = "") {
  if (input === void 0 || input === null) return { ok: true, value: void 0 };
  if (!isJsonObject(input)) return { ok: false, reason: `\u7247\u573A\u5BF9\u8C61 ${itemId} motion \u5FC5\u987B\u662F\u5BF9\u8C61` };
  const decoded = decodeMotionDefinition({
    motionScript: input.motionScript,
    motionScriptLanguage: input.motionScriptLanguage,
    motionScriptVersion: input.motionScriptVersion,
    motionRevision: input.revision,
    motionSourceHash: input.sourceHash,
    motionBasedOnModelVersion: input.basedOnModelVersion
  });
  if (!decoded.ok) return { ok: false, reason: `\u7247\u573A\u5BF9\u8C61 ${itemId} motion \u975E\u6CD5\uFF1A${decoded.reason}` };
  return { ok: true, value: decoded.value };
}
var INVALID_COLOR = Symbol("invalid-color");

// ../../../../client/web/contracts/src/canvas/film-set-content/part-identity.ts
function encodeFilmSetPartId(itemId, partId = "") {
  return `${itemId.length}:${itemId}${partId}`;
}

// ../../../../client/web/contracts/src/canvas/composite-asset-scene.ts
function compositeAssetSceneOps(ops, scenePlacement) {
  const decoded = decodeFilmSetLocalTransform(scenePlacement);
  if (!decoded.ok) throw new Error(`\u590D\u5408\u8D44\u4EA7\u6839\u53D8\u6362\u975E\u6CD5\uFF1A${decoded.reason}`);
  const root = decoded.value;
  if (root.scale === 1 && root.yaw === 0 && root.offset.x === 0 && root.offset.y === 0 && root.offset.z === 0) return [...ops];
  const rootId = "\0composite-asset";
  if (ops.some((op) => "id" in op && op.id === rootId)) throw new Error("\u6A21\u578B\u90E8\u4EF6\u5360\u7528\u590D\u5408\u8D44\u4EA7\u4FDD\u7559\u6839\u8EAB\u4EFD");
  return [{ t: "group", id: rootId, parent: null, material: null, color: null, position: [root.offset.x, root.offset.y, root.offset.z], rotation: [0, root.yaw * 180 / Math.PI, 0], scale: [root.scale, root.scale, root.scale] }, ...ops.map((op) => "parent" in op && op.parent ? op : "id" in op && op.t !== "material" ? { ...op, parent: rootId } : op)];
}

// ../../../../client/web/contracts/src/canvas/film-set-group.ts
var FILM_SET_GROUP_FIELD = "filmSetGroup";
var FILM_SET_GROUP_SCHEMA_VERSION = 1;
var FILM_SET_GROUP_MIGRATION_VERSION = 1;
var FILM_SET_GROUP_BINDING_KINDS = ["model3d", "image", "video"];
var ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var finite = (value) => typeof value === "number" && Number.isFinite(value);
var id = (value) => typeof value === "string" && ID_RE.test(value);
var object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function decodeFilmSetGroupTransform(input) {
  if (!object(input)) return null;
  const x = input.x, y = input.y, z = input.z, yaw = input.yaw, scale = input.scale;
  if (![x, y, z, yaw, scale].every(finite) || !(scale > 0) || scale > 1e3) return null;
  return { x, y, z, yaw, scale };
}
function decodeBinding(input) {
  if (!object(input) || !id(input.bindingId) || !id(input.sourceNodeId)) return null;
  if (!FILM_SET_GROUP_BINDING_KINDS.includes(String(input.kind))) return null;
  if (input.name !== void 0 && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80)) return null;
  const transform = decodeFilmSetGroupTransform(input.transform);
  if (!transform || typeof input.visibility !== "boolean" || typeof input.contentKey !== "string" || input.contentKey.length === 0 || input.contentKey.length > 2048) return null;
  let animation;
  if (input.animation !== void 0) {
    if (!object(input.animation) || !object(input.animation.motion) || !object(input.animation.playback)) return null;
    const m = input.animation.motion, p = input.animation.playback;
    const motion = decodeMotionDefinition({ ...m, motionRevision: m.revision, motionSourceHash: m.sourceHash, motionBasedOnModelVersion: m.basedOnModelVersion });
    if (!motion.ok || !finite(p.startTime) || p.startTime < 0 || !finite(p.duration) || p.duration <= 0 || !finite(p.timeScale) || p.timeScale <= 0 || typeof p.loop !== "boolean") return null;
    animation = { motion: motion.value, playback: { startTime: p.startTime, duration: p.duration, timeScale: p.timeScale, loop: p.loop } };
  }
  if (input.detached !== void 0 && typeof input.detached !== "boolean") return null;
  return {
    ...animation ? { animation } : {},
    bindingId: input.bindingId,
    ...typeof input.name === "string" ? { name: input.name } : {},
    sourceNodeId: input.sourceNodeId,
    kind: input.kind,
    transform,
    visibility: input.visibility,
    ...input.detached === true ? { detached: true } : {},
    contentKey: input.contentKey
  };
}
function decodeCamera(input) {
  if (!object(input) || !id(input.id) || !finite(input.azimuth) || !finite(input.elevation) || !finite(input.distance) || input.distance <= 0 || !object(input.focusOffset)) return null;
  const focusOffset = input.focusOffset;
  if (![focusOffset.x, focusOffset.y, focusOffset.z].every(finite)) return null;
  if (input.name !== void 0 && typeof input.name !== "string") return null;
  if (input.aspect !== void 0 && typeof input.aspect !== "string") return null;
  return { id: input.id, ...input.name === void 0 ? {} : { name: input.name }, azimuth: input.azimuth, elevation: input.elevation, distance: input.distance, focusOffset: { x: focusOffset.x, y: focusOffset.y, z: focusOffset.z }, ...input.aspect === void 0 ? {} : { aspect: input.aspect } };
}
function decodeFilmSetGroupClip(input) {
  if (!object(input) || !id(input.id)) return null;
  if (input.name !== void 0 && typeof input.name !== "string") return null;
  if (input.cameraId !== void 0 && !id(input.cameraId)) return null;
  if (input.duration !== void 0 && (!finite(input.duration) || input.duration < 0 || input.duration > 86400)) return null;
  if (input.loop !== void 0 && typeof input.loop !== "boolean") return null;
  const backdrop = readFilmSetBackdrop(input.backdrop);
  const cameraMotion = decodeFilmSetMotion(input.cameraMotion, input.id);
  if (!backdrop.ok || !cameraMotion.ok) return null;
  const bindings = [];
  if (input.bindings !== void 0) {
    if (!Array.isArray(input.bindings)) return null;
    const seen = /* @__PURE__ */ new Set();
    for (const raw of input.bindings) {
      if (!object(raw) || !id(raw.itemId) || seen.has(raw.itemId)) return null;
      const motion = decodeFilmSetMotion(raw.motion, raw.itemId);
      const playback = decodeFilmSetPlayback(raw.playback, raw.itemId);
      if (!motion.ok || !playback.ok || !playback.value) return null;
      seen.add(raw.itemId);
      bindings.push({ itemId: raw.itemId, playback: playback.value, ...motion.value ? { motion: motion.value } : {} });
    }
  }
  if ((input.duration ?? 0) === 0 && (input.loop === true || bindings.some((binding) => binding.playback.duration > 0 || binding.motion?.motionScript.trim()) || cameraMotion.value?.motionScript.trim())) return null;
  return { id: input.id, ...input.name === void 0 ? {} : { name: input.name }, ...input.cameraId === void 0 ? {} : { cameraId: input.cameraId }, ...input.duration === void 0 ? {} : { duration: input.duration }, ...input.loop === void 0 ? {} : { loop: input.loop }, ...backdrop.value ? { backdrop: backdrop.value } : {}, ...cameraMotion.value ? { cameraMotion: cameraMotion.value } : {}, ...input.bindings === void 0 ? {} : { bindings } };
}
function decodeFilmSetGroupMarker(input) {
  if (!object(input)) return { ok: false, reason: "filmSetGroup \u5FC5\u987B\u662F\u5BF9\u8C61" };
  if (input.schemaVersion !== FILM_SET_GROUP_SCHEMA_VERSION) return { ok: false, reason: "\u4E0D\u652F\u6301\u7684 filmSetGroup.schemaVersion" };
  if (!Array.isArray(input.sceneBindings)) return { ok: false, reason: "filmSetGroup.sceneBindings \u5FC5\u987B\u662F\u6570\u7EC4" };
  const seen = /* @__PURE__ */ new Set();
  const sceneBindings = [];
  for (const raw of input.sceneBindings) {
    const binding = decodeBinding(raw);
    if (!binding) return { ok: false, reason: "filmSetGroup.sceneBindings \u5305\u542B\u975E\u6CD5 binding" };
    if (seen.has(binding.bindingId)) return { ok: false, reason: `\u91CD\u590D bindingId\uFF1A${binding.bindingId}` };
    seen.add(binding.bindingId);
    sceneBindings.push(binding);
  }
  const cameras = input.cameras === void 0 ? void 0 : Array.isArray(input.cameras) ? input.cameras.map(decodeCamera) : null;
  if (cameras === null || cameras?.some((entry) => entry === null)) return { ok: false, reason: "filmSetGroup.cameras \u975E\u6CD5" };
  const clips = input.clips === void 0 ? void 0 : Array.isArray(input.clips) ? input.clips.map(decodeFilmSetGroupClip) : null;
  if (clips === null || clips?.some((entry) => entry === null)) return { ok: false, reason: "filmSetGroup.clips \u975E\u6CD5" };
  if (cameras && new Set(cameras.map((camera) => camera.id)).size !== cameras.length) return { ok: false, reason: "filmSetGroup.cameras ID \u91CD\u590D" };
  if (clips && new Set(clips.map((clip) => clip.id)).size !== clips.length) return { ok: false, reason: "filmSetGroup.clips ID \u91CD\u590D" };
  for (const clip of clips ?? []) {
    if (clip.cameraId && !cameras?.some((camera) => camera.id === clip.cameraId)) return { ok: false, reason: "\u955C\u5934\u5F15\u7528\u7684\u76F8\u673A\u4E0D\u5B58\u5728" };
    if (clip.bindings?.some((binding) => !seen.has(binding.itemId))) return { ok: false, reason: "\u955C\u5934\u5F15\u7528\u7684\u5BF9\u8C61\u7ED1\u5B9A\u4E0D\u5B58\u5728" };
  }
  const sceneTransform = input.sceneTransform === void 0 ? void 0 : decodeFilmSetGroupTransform(input.sceneTransform);
  if (sceneTransform === null) return { ok: false, reason: "filmSetGroup.sceneTransform \u975E\u6CD5" };
  let ground;
  if (input.ground !== void 0) {
    if (!object(input.ground) || !finite(input.ground.width) || !finite(input.ground.depth) || input.ground.width <= 0 || input.ground.depth <= 0 || input.ground.width > 1e6 || input.ground.depth > 1e6 || input.ground.color !== void 0 && typeof input.ground.color !== "string") return { ok: false, reason: "filmSetGroup.ground \u975E\u6CD5" };
    const transform = input.ground.transform === void 0 ? void 0 : decodeFilmSetGroupTransform(input.ground.transform);
    if (transform === null) return { ok: false, reason: "filmSetGroup.ground.transform \u975E\u6CD5" };
    ground = { ...transform ? { transform } : {}, width: input.ground.width, depth: input.ground.depth, ...input.ground.color === void 0 ? {} : { color: input.ground.color } };
  }
  if (input.activeClip !== void 0 && input.activeClip !== null && !id(input.activeClip)) return { ok: false, reason: "filmSetGroup.activeClip \u975E\u6CD5" };
  if (typeof input.activeClip === "string" && !clips?.some((clip) => clip.id === input.activeClip)) return { ok: false, reason: "\u6D3B\u52A8\u955C\u5934\u4E0D\u5B58\u5728" };
  let migration;
  if (input.migration !== void 0) {
    if (!object(input.migration) || input.migration.version !== FILM_SET_GROUP_MIGRATION_VERSION || !id(input.migration.commandId) || !id(input.migration.sourceNodeId)) return { ok: false, reason: "filmSetGroup.migration \u975E\u6CD5" };
    migration = { version: FILM_SET_GROUP_MIGRATION_VERSION, commandId: input.migration.commandId, sourceNodeId: input.migration.sourceNodeId };
  }
  return { ok: true, value: { schemaVersion: FILM_SET_GROUP_SCHEMA_VERSION, sceneBindings, ...sceneTransform ? { sceneTransform } : {}, ...cameras ? { cameras } : {}, ...clips ? { clips } : {}, ...ground ? { ground } : {}, ...input.activeClip === void 0 ? {} : { activeClip: input.activeClip }, ...migration ? { migration } : {} } };
}
function isFilmSetGroupNode(node, data) {
  return node?.type === "group" && decodeFilmSetGroupMarker(object(data) ? data[FILM_SET_GROUP_FIELD] : void 0).ok;
}
function isActiveFilmSetBinding(binding) {
  return binding.detached !== true;
}
function activeFilmSetSceneBindings(marker) {
  return marker.sceneBindings.filter(isActiveFilmSetBinding);
}
function readFilmSetGroupMarker(data) {
  const decoded = decodeFilmSetGroupMarker(object(data) ? data[FILM_SET_GROUP_FIELD] : void 0);
  return decoded.ok ? decoded.value : null;
}
function contentKeyForNode(node, data) {
  if (node.type === "model3d") {
    const model = decodeModelDefinition(data);
    return model.ok ? `model3d:${modelContentHash(model.value)}` : null;
  }
  if (node.type === "image" || node.type === "video") {
    const media = data?.mediaContent;
    const payload = media && typeof media === "object" ? media.payload : void 0;
    const mediaId = typeof data?.outputAssetId === "string" ? data.outputAssetId : payload && typeof payload === "object" && typeof payload.assetId === "string" ? payload.assetId : null;
    return mediaId ? `${node.type}:${mediaId}` : null;
  }
  return null;
}
function contentKeyForFilmSetGroupSource(canvas, sourceNodeId) {
  const node = canvas.document.nodes.find((entry) => entry.id === sourceNodeId);
  if (!node) return null;
  const key = contentKeyForNode(node, canvas.nodeData[sourceNodeId]);
  if (!key || node.type === "model3d") return key;
  const data = canvas.nodeData[sourceNodeId];
  const assetId = data?.outputAssetId ?? data?.mediaContent?.payload?.assetId;
  const asset = canvas.assets.find((asset2) => asset2.id === assetId);
  if (!asset || asset.status !== "ready") return null;
  return asset || data?.mediaContent ? `${key}:${fnv1a64Hex(JSON.stringify([asset?.status, asset?.metadata, data?.mediaContent]))}` : key;
}
function prepareFilmSetGroup(canvas, groupId) {
  const group = canvas.document.nodes.find((node) => node.id === groupId);
  const marker = group ? readFilmSetGroupMarker(canvas.nodeData[groupId]) : null;
  if (!group || !marker || group.type !== "group") return null;
  const nodes = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const bindings = [];
  const diagnostics = [];
  for (const binding of activeFilmSetSceneBindings(marker)) {
    const source = nodes.get(binding.sourceNodeId);
    if (!source) {
      diagnostics.push({ bindingId: binding.bindingId, sourceNodeId: binding.sourceNodeId, code: "missing-source", message: "\u6765\u6E90\u8D44\u6E90\u5361\u7247\u4E0D\u5B58\u5728\uFF0C\u7ED1\u5B9A\u5DF2\u4FDD\u7559" });
      continue;
    }
    if (source.type !== binding.kind) {
      diagnostics.push({ bindingId: binding.bindingId, sourceNodeId: binding.sourceNodeId, code: "type-mismatch", message: "\u6765\u6E90\u8282\u70B9\u7C7B\u578B\u4E0E binding \u4E0D\u5339\u914D" });
      continue;
    }
    const contentKey = contentKeyForFilmSetGroupSource(canvas, source.id);
    if (!contentKey) {
      diagnostics.push({ bindingId: binding.bindingId, sourceNodeId: binding.sourceNodeId, code: "content-unavailable", message: "\u6765\u6E90\u8D44\u6E90\u5C1A\u672A\u5C31\u7EEA\uFF0C\u53EF\u7A0D\u540E\u91CD\u8BD5" });
      continue;
    }
    bindings.push({ ...binding, source, contentKey });
  }
  return { groupId, marker, bindings, diagnostics };
}

// ../../../../client/web/contracts/src/canvas/model-focus/canvas-projection.ts
var CANVAS_CAMERA_PITCH = 30 * Math.PI / 180;

// ../../../../client/web/contracts/src/canvas/model-cameras/types.ts
var SHOT_CAMERA_MIN_ELEVATION = -Math.PI / 2;
var SHOT_CAMERA_MAX_ELEVATION = Math.PI / 2;

// ../../../../client/web/contracts/src/canvas/model-cameras/codec.ts
var INVALID_ASPECT = Symbol("invalid-aspect");
var INVALID_ELEVATION = Symbol("invalid-elevation");
var INVALID_FOCUS_OFFSET = Symbol("invalid-focus-offset");

// ../../../../client/web/contracts/src/canvas/film-set-composition.ts
var FILM_SET_SCENE_ROOT_ID = "\0scene";
var GROUND_DEFAULT_COLOR = "#9aa4b2";
var FILM_SET_GROUND_THICKNESS = 0.15;
function composeFilmSetScene(input) {
  const ops = [];
  const itemRoots = {};
  const sceneRoot = FILM_SET_SCENE_ROOT_ID;
  ops.push(groupOp(sceneRoot, null, input.scenePlacement ?? identityTransform()));
  for (const model of input.models ?? []) {
    const rootId = encodeFilmSetPartId(model.itemId, "");
    itemRoots[model.itemId] = rootId;
    ops.push(groupOp(rootId, sceneRoot, model.localTransform));
    if (model.placement) {
      const placementId = encodeFilmSetPartId(model.itemId, "\0placement");
      ops.push(groupOp(placementId, rootId, modelPlacementToLocal(model.placement)));
      ops.push(...remapOps(model.ops, model.itemId, placementId));
    } else {
      ops.push(...remapOps(model.ops, model.itemId, rootId));
    }
  }
  for (const ground of input.grounds ?? []) {
    const rootId = encodeFilmSetPartId(ground.itemId, "");
    itemRoots[ground.itemId] = rootId;
    ops.push(groupOp(rootId, sceneRoot, ground.localTransform));
    ops.push({
      t: "box",
      id: encodeFilmSetPartId(ground.itemId, "surface"),
      parent: rootId,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: null,
      color: ground.color ?? GROUND_DEFAULT_COLOR,
      size: [ground.size.width, FILM_SET_GROUND_THICKNESS, ground.size.depth]
    });
  }
  return { ops, itemRoots, sceneRoot };
}
function groupOp(id2, parent, transform) {
  return {
    t: "group",
    id: id2,
    parent,
    position: [transform.offset.x, transform.offset.y, transform.offset.z],
    rotation: [0, degrees(transform.yaw), 0],
    scale: [transform.scale, transform.scale, transform.scale],
    material: null,
    color: null
  };
}
function identityTransform() {
  return { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
}
function modelPlacementToLocal(placement) {
  if (!placement) return identityTransform();
  return {
    offset: { ...placement.offset },
    scale: placement.scale,
    yaw: placement.yaw * Math.PI / 180
  };
}
function degrees(radians) {
  return radians * 180 / Math.PI;
}
function remapOps(ops, itemId, rootId) {
  const remapped = [];
  for (const op of ops) {
    if (op.t === "material") {
      remapped.push({ ...op, id: encodeFilmSetPartId(itemId, op.id) });
      continue;
    }
    if (op.t === "oscillate" || op.t === "move" || op.t === "rotate") {
      remapped.push({ ...op, id: encodeFilmSetPartId(itemId, op.id) });
      continue;
    }
    const shape = op;
    remapped.push({
      ...shape,
      id: encodeFilmSetPartId(itemId, shape.id),
      parent: shape.parent === null ? rootId : encodeFilmSetPartId(itemId, shape.parent),
      material: shape.material === null ? null : encodeFilmSetPartId(itemId, shape.material)
    });
  }
  return remapped;
}

// ../../../../client/web/contracts/src/canvas/film-set-group-model.ts
var sourceExecutions = /* @__PURE__ */ new Map();
function executeSource(script, version) {
  const key = JSON.stringify([version, script]);
  const cached = sourceExecutions.get(key);
  if (cached) return cached;
  const result = executeModelScriptVersioned(script, version);
  if (sourceExecutions.size >= 128) sourceExecutions.delete(sourceExecutions.keys().next().value);
  sourceExecutions.set(key, result);
  return result;
}
var filmSetGroupModelPreparation = {
  reportsStatus: false,
  executionKey: ({ canvas, data }) => {
    const marker = readFilmSetGroupMarker(data);
    if (!marker) return void 0;
    return JSON.stringify([marker.ground, activeFilmSetSceneBindings(marker).map((binding) => {
      const source = canvas.nodeData[binding.sourceNodeId];
      return [binding.bindingId, binding.sourceNodeId, binding.kind, binding.contentKey, contentKeyForFilmSetGroupSource(canvas, binding.sourceNodeId), source?.modelScript, source?.modelScriptVersion, source?.modelContentVersion, source?.modelPlacement];
    })]);
  },
  prepare: ({ canvas, node }) => {
    const prepared = prepareFilmSetGroup(canvas, node.id);
    if (!prepared) return { status: "fail:compile:invalid-film-set-group" };
    const models = [];
    const failures = prepared.diagnostics.map((diagnostic) => `${diagnostic.bindingId}:${diagnostic.code}`);
    for (const binding of prepared.bindings) {
      if (binding.kind !== "model3d") continue;
      const model = decodeModelDefinition(canvas.nodeData[binding.sourceNodeId]);
      if (!model.ok) {
        failures.push(`${binding.bindingId}:${model.reason}`);
        continue;
      }
      const execution = executeSource(model.value.modelScript, model.value.modelScriptVersion);
      if (!execution.ok) {
        failures.push(`${binding.bindingId}:${execution.code}`);
        continue;
      }
      models.push({ itemId: binding.bindingId, ops: execution.scene.ops, placement: model.value.placement, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } });
    }
    const ready = new Set(models.map((model) => model.itemId));
    const missingSources = new Set(prepared.diagnostics.filter((diagnostic) => diagnostic.code === "missing-source").map((diagnostic) => diagnostic.bindingId));
    for (const binding of activeFilmSetSceneBindings(prepared.marker)) {
      if (missingSources.has(binding.bindingId)) continue;
      const failed = prepared.diagnostics.some((diagnostic) => diagnostic.bindingId === binding.bindingId) || binding.kind === "model3d" && !ready.has(binding.bindingId);
      if (!failed) continue;
      models.push({
        itemId: binding.bindingId,
        localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
        ops: [{ t: "box", id: "resource-unavailable", parent: null, position: [0, 0.4, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#c67d42", size: [0.8, 0.8, 0.8] }]
      });
    }
    const ground = prepared.marker.ground;
    const composition = composeFilmSetScene({ models, grounds: ground ? [{ itemId: "film-set-ground", localTransform: ground.transform ? { offset: { x: ground.transform.x, y: ground.transform.y, z: ground.transform.z }, scale: ground.transform.scale, yaw: ground.transform.yaw } : { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: ground.width, depth: ground.depth }, ...ground.color ? { color: ground.color } : {} }] : [] });
    return { ...failures.length ? { diagnostic: failures.join("\uFF1B") } : {}, status: failures.length ? `ok:partial:${failures.join(";")}` : "ok", resource: prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: composition.ops }) };
  }
};

// ../../../../client/web/contracts/src/canvas/group-appearance.ts
var GROUP_APPEARANCE_SCHEMA_VERSION = 1;
var DEFAULT_GROUP_APPEARANCE_SCRIPT = `scene.group({ id: "group-root" });
scene.material({ id: "group-folder-shell", baseColor: "#65b7c6", roughness: 0.55, metallic: 0.08 });
scene.material({ id: "group-folder-inner", baseColor: "#4f93a3", roughness: 0.62, metallic: 0.04 });
scene.material({ id: "group-folder-paper", baseColor: "#e0edf5", roughness: 0.7 });
scene.box({ id: "group-folder-back", parent: "group-root", position: [0, 0.58, -0.09], size: [2.4, 1.16, 0.18], material: "group-folder-inner" });
scene.box({ id: "group-folder-tab", parent: "group-root", position: [-0.72, 1.28, -0.09], size: [0.96, 0.24, 0.18], material: "group-folder-inner" });
scene.box({ id: "group-folder-paper-back", parent: "group-root", position: [0.03, 0.55, 0.03], size: [1.9, 1.0, 0.06], material: "group-folder-paper" });
scene.box({ id: "group-folder-paper-front", parent: "group-root", position: [-0.05, 0.47, 0.1], size: [1.72, 0.88, 0.06], material: "group-folder-paper" });
scene.box({ id: "group-folder-pocket", parent: "group-root", position: [0, 0.35, 0.27], rotation: [-6, 0, 0], size: [2.52, 0.66, 0.16], material: "group-folder-shell" });`;
function modelFromScript(modelScript, revision = 1) {
  const normalized = deriveModelContentVersion({
    modelScript,
    modelScriptLanguage: "javascript",
    modelScriptVersion: MODEL_SCRIPT_V2_VERSION,
    placement: DEFAULT_MODEL_PLACEMENT,
    revision
  });
  return {
    modelScript,
    modelScriptLanguage: "javascript",
    modelScriptVersion: MODEL_SCRIPT_V2_VERSION,
    contentVersion: normalized,
    placement: { ...DEFAULT_MODEL_PLACEMENT, offset: { ...DEFAULT_MODEL_PLACEMENT.offset } }
  };
}
var cachedDefault;
function defaultGroupAppearance() {
  cachedDefault ??= { schemaVersion: GROUP_APPEARANCE_SCHEMA_VERSION, model: modelFromScript(DEFAULT_GROUP_APPEARANCE_SCRIPT) };
  const model = cachedDefault.model;
  return {
    schemaVersion: GROUP_APPEARANCE_SCHEMA_VERSION,
    model: {
      ...model,
      contentVersion: { ...model.contentVersion },
      placement: { ...model.placement, offset: { ...model.placement.offset } }
    }
  };
}
function decodeGroupAppearance(input) {
  if (!isJsonObject(input)) return { ok: false, reason: "groupAppearance \u5FC5\u987B\u662F\u5BF9\u8C61" };
  if (input.schemaVersion !== GROUP_APPEARANCE_SCHEMA_VERSION) {
    return { ok: false, reason: "\u4E0D\u652F\u6301\u7684 groupAppearance.schemaVersion" };
  }
  if (!isJsonObject(input.model)) return { ok: false, reason: "groupAppearance.model \u5FC5\u987B\u662F\u5BF9\u8C61" };
  const allowedModelKeys = /* @__PURE__ */ new Set(["modelScript", "modelScriptLanguage", "modelScriptVersion", "contentVersion", "placement"]);
  if (Object.keys(input.model).some((key) => !allowedModelKeys.has(key))) {
    return { ok: false, reason: "groupAppearance.model \u4E0D\u5F97\u5305\u542B\u5916\u90E8\u8D44\u6E90\u6216\u8FD0\u884C\u65F6\u5B57\u6BB5" };
  }
  const decoded = decodeModelDefinition({
    ...input.model,
    modelContentVersion: input.model.contentVersion,
    modelPlacement: input.model.placement
  });
  if (!decoded.ok) return { ok: false, reason: `groupAppearance.model\uFF1A${decoded.reason}` };
  return { ok: true, value: { schemaVersion: GROUP_APPEARANCE_SCHEMA_VERSION, model: decoded.value } };
}
function readGroupAppearanceForNode(data) {
  const raw = data?.groupAppearance;
  if (raw === void 0) return { value: defaultGroupAppearance(), source: "default" };
  const decoded = decodeGroupAppearance(raw);
  if (!decoded.ok) return { value: defaultGroupAppearance(), source: "unsupported", diagnostic: decoded.reason };
  return { value: decoded.value, source: "custom" };
}

// ../../../../client/web/contracts/src/canvas/node-minimum-size.ts
function minimumNodeSizeFor(type) {
  return type === COMPOSITE_ASSET_NODE_TYPE ? { width: 200, height: 150 } : { width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT };
}

// ../../../../client/web/contracts/src/canvas/builtin-node-capabilities.ts
var scriptModelPreparation = {
  executionKey: ({ data }) => data?.modelScript ? `${String(data.modelScriptVersion)}:${data.modelScript}` : void 0,
  prepare: ({ data }) => {
    const execution = executeModelScriptVersioned(String(data?.modelScript ?? ""), data?.modelScriptVersion);
    if (!execution.ok) return { status: `fail:${execution.stage}:${execution.code}` };
    if (!isSupportedModelScriptVersion(data?.modelScriptVersion)) return { status: "fail:compile:version-mismatch" };
    return { status: "ok", resource: prepareModelResource({ sceneVersion: sceneIrVersionFor(data.modelScriptVersion), ops: execution.scene.ops }) };
  }
};
var savedCompositePreparation = {
  executionKey: (context) => `saved:${JSON.stringify(context.data?.scenePlacement)}:${scriptModelPreparation.executionKey(context) ?? ""}`,
  prepare: async (context) => {
    const result = await scriptModelPreparation.prepare(context);
    if (result.resource) result.resource = prepareModelResource({ sceneVersion: result.resource.sceneVersion, ops: compositeAssetSceneOps(result.resource.ops, context.data?.scenePlacement) });
    return result;
  }
};
function defaultModelPreview() {
  return { ...DEFAULT_MODEL_PREVIEW, elevation: CANVAS_CAMERA_PITCH };
}
var orbitModelPreview = {
  project: (_context, view) => ({ ...defaultModelPreview(), ...view })
};
var groupAppearancePreparation = {
  reportsStatus: false,
  executionKey: (context) => {
    if (isFilmSetGroupNode(context.node, context.data)) return filmSetGroupModelPreparation.executionKey(context);
    const { data } = context;
    const appearance = readGroupAppearanceForNode(data);
    return `group:${appearance.source}:${String(appearance.value.model.modelScriptVersion)}:${appearance.value.model.modelScript}`;
  },
  prepare: (context) => {
    if (isFilmSetGroupNode(context.node, context.data)) return filmSetGroupModelPreparation.prepare(context);
    const { data } = context;
    const model = readGroupAppearanceForNode(data).value.model;
    const execution = executeModelScriptVersioned(model.modelScript, model.modelScriptVersion);
    if (!execution.ok) return { status: `fail:${execution.stage}:${execution.code}` };
    if (!isSupportedModelScriptVersion(model.modelScriptVersion)) return { status: "fail:compile:version-mismatch" };
    return {
      status: "ok",
      resource: prepareModelResource({ sceneVersion: sceneIrVersionFor(model.modelScriptVersion), ops: execution.scene.ops })
    };
  }
};
var modelWorkspaceFocus = { kind: () => "model" };
var nodeActionContributions = { accepts: () => true };
var rectangularNodeResize = { mode: "rect", minimum: () => ({ width: 180, height: 64 }) };
var modelResourceDemand = { channel: "model", previewSlot: true, contentKey: (context) => context.modelResourceKey };
var rich = { width: 248, height: 232 };
var compact = { width: 196, height: 64 };
function builtinNodeImplementations() {
  const entries = /* @__PURE__ */ new Map();
  for (const type of ["text", "image", "audio", "video"]) entries.set(type, {
    appearance: { palette: type, defaultSize: rich },
    resize: rectangularNodeResize,
    ...type !== "text" ? { actions: nodeActionContributions } : {},
    connections: { endpoints: () => "ordinary" },
    ...type === "image" || type === "video" ? { resources: { channel: type, previewSlot: false, contentKey: (context) => context.assetContentKey } } : {}
  });
  entries.set("model3d", {
    appearance: { palette: "model", defaultSize: rich, cardLabel: "3D \u6A21\u578B" },
    modelPreparation: scriptModelPreparation,
    modelPreview: orbitModelPreview,
    resources: modelResourceDemand,
    focus: modelWorkspaceFocus,
    actions: nodeActionContributions,
    connections: { endpoints: () => "ordinary" },
    resize: { mode: "rect", legacyPreviewHeight: 116, minimum: () => ({ width: 180, height: 160 }) }
  });
  entries.set("composite-asset", {
    appearance: { palette: "model", defaultSize: { width: 260, height: 195 } },
    modelPreparation: savedCompositePreparation,
    scope: { shape: () => "isometric-diamond" },
    resources: { ...modelResourceDemand, contentKey: (context) => context.modelResourceKey ?? `${context.canvas.id}:composite:${context.node.id}` },
    focus: { kind: (context) => isFilmSetNode(context.node.type, context.data) ? "model" : "extension" },
    actions: nodeActionContributions,
    connections: { endpoints: (context) => isPureModelNodeType(context.node.type, context.data) ? "none" : "ordinary" },
    resize: { ...rectangularNodeResize, mode: "scope", minimum: (context) => minimumNodeSizeFor(context.node.type) }
  });
  entries.set("group", {
    appearance: { palette: "group", defaultSize: compact },
    modelPreparation: groupAppearancePreparation,
    container: { project: ({ data }, counts) => ({ title: typeof data?.title === "string" ? data.title : "", ...counts }) },
    // 组保留结构容器身份，其自身展示模型与普通模型共用 payload lease；模型直接绘制在画布
    // 世界，不创建离屏预览相机，因此只占模型 payload、不占预览槽。
    resources: { channel: "model", previewSlot: false, contentKey: (context) => context.modelResourceKey },
    focus: { kind: (context) => isFilmSetGroupNode(context.node, context.data) ? "model" : "extension" },
    connections: { endpoints: () => "aggregate" },
    actions: nodeActionContributions,
    resize: { mode: "rect", minimum: ({ canvas, node }) => {
      const min = getGroupRequiredMinSize(canvas.document.nodes.map((entry) => ({ ...entry, data: {} })), node.id);
      return { width: min.minWidth, height: min.minHeight };
    } }
  });
  return entries;
}
var builtins = builtinNodeImplementations();
function builtinNodeCapabilitiesForType(type) {
  return builtins.get(type) ?? {};
}

// ../../../../client/web/contracts/src/canvas/node-dimensions.ts
var COMPACT_NODE_SIZE = { width: 196, height: 64 };
var MODEL_PREVIEW_MIN_HEIGHT = 160;
function dimension(value, fallback, minimum) {
  return Math.max(
    minimum,
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
  );
}
function effectiveCanvasNodeSize(node, override, capabilities = builtinNodeCapabilitiesForType(node.type)) {
  const preview = !!capabilities.modelPreview;
  const fallback = capabilities.appearance?.defaultSize ?? COMPACT_NODE_SIZE;
  const legacyPreview = capabilities.resize?.legacyPreviewHeight !== void 0 && (node.height ?? COMPACT_NODE_SIZE.height) <= capabilities.resize.legacyPreviewHeight;
  const base = override ?? (legacyPreview ? fallback : node);
  const group = !!capabilities.container;
  return {
    width: dimension(base.width, fallback.width, group ? 0 : minimumNodeSizeFor(node.type).width),
    height: dimension(
      base.height,
      fallback.height,
      group ? 0 : preview ? MODEL_PREVIEW_MIN_HEIGHT : minimumNodeSizeFor(node.type).height
    )
  };
}

// ../../../../client/web/contracts/src/canvas/domain/core/group-geometry.ts
var groupPadding = 40;
var groupBottomPadding = 80;
function requiredSize(children, sizeOf2) {
  if (!children.length) return { minWidth: DEFAULT_NODE_DIMS.width, minHeight: DEFAULT_NODE_DIMS.height };
  const minLeft = Math.min(...children.map((child) => child.position.x));
  const minTop = Math.min(...children.map((child) => child.position.y));
  const right = Math.max(...children.map((child) => child.position.x + sizeOf2(child).width));
  const bottom = Math.max(...children.map((child) => child.position.y + sizeOf2(child).height));
  return {
    minWidth: Math.max(DEFAULT_NODE_DIMS.width, right + groupPadding, right - minLeft + groupPadding * 2),
    minHeight: Math.max(DEFAULT_NODE_DIMS.height, bottom + groupBottomPadding, bottom - minTop + groupPadding + groupBottomPadding)
  };
}
function contentSize(children, sizeOf2) {
  if (!children.length) return { minWidth: DEFAULT_NODE_DIMS.width, minHeight: DEFAULT_NODE_DIMS.height };
  const right = Math.max(...children.map((child) => child.position.x + sizeOf2(child).width));
  const bottom = Math.max(...children.map((child) => child.position.y + sizeOf2(child).height));
  return {
    minWidth: Math.max(DEFAULT_NODE_DIMS.width, right),
    // 底部页脚（徽标与成员之间的间隔）仍保留；左右/上不再预留装饰留白。
    minHeight: Math.max(DEFAULT_NODE_DIMS.height, bottom + groupBottomPadding)
  };
}
function getGroupLayoutSizes(nodes, overrides) {
  const children = /* @__PURE__ */ new Map();
  for (const node of nodes) if (node.parentId) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const sizes = /* @__PURE__ */ new Map();
  const visiting = /* @__PURE__ */ new Set();
  const sizeOf2 = (node) => {
    const cached = sizes.get(node.id);
    if (cached) return cached;
    const size = effectiveCanvasNodeSize(node, overrides?.get(node.id));
    if (node.type !== "group" || visiting.has(node.id)) return size;
    if (overrides?.has(node.id)) {
      sizes.set(node.id, size);
      return size;
    }
    visiting.add(node.id);
    const members = children.get(node.id) ?? [];
    const content = members.length ? contentSize(members, sizeOf2) : { minWidth: size.width, minHeight: size.height };
    const contained = size.width >= content.minWidth && size.height >= content.minHeight;
    const min = contained || !members.length ? content : requiredSize(members, sizeOf2);
    const result = { width: Math.max(size.width, min.minWidth), height: Math.max(size.height, min.minHeight) };
    visiting.delete(node.id);
    sizes.set(node.id, result);
    return result;
  };
  for (const node of nodes) if (node.type === "group") sizeOf2(node);
  return sizes;
}
function getGroupRequiredMinSize(nodes, groupId) {
  const sizes = getGroupLayoutSizes(nodes);
  return requiredSize(nodes.filter((node) => node.parentId === groupId), (node) => sizes.get(node.id) ?? effectiveCanvasNodeSize(node));
}

// ../../../../client/web/contracts/src/canvas/domain/core/mention-token.ts
var WOOHAA3_CANVAS_MENTION_TYPES = [
  "input_image",
  "input_video",
  "input_audio",
  "input_text"
];
var TYPE_SET = new Set(WOOHAA3_CANVAS_MENTION_TYPES);

// ../../../../client/web/contracts/src/video/video-edit.ts
var VIDEO_EDIT_LIMITS = {
  maxIntents: 32,
  maxShapesPerIntent: 64,
  maxPointsPerShape: 2048,
  maxPromptChars: 2e3,
  minRangeSeconds: 0.05,
  maxFrameDimension: 8192,
  maxSerializedBytes: 256 * 1024
};
var VIDEO_EDIT_ALLOWED_COLORS = ["#ff8a1f", "#ff3b30", "#ffd23f", "#2f80ff", "#ffffff"];
var VIDEO_EDIT_ALLOWED_STROKE_WIDTHS = [1, 2, 3];
var ALLOWED_COLOR_SET = new Set(VIDEO_EDIT_ALLOWED_COLORS);
var ALLOWED_STROKE_SET = new Set(VIDEO_EDIT_ALLOWED_STROKE_WIDTHS);

// ../../../../client/web/contracts/src/canvas/model-focus/types.ts
var MODEL_FOCUS_FOV = 50 * Math.PI / 180;
var MODEL_FOCUS_PITCH_LIMIT = 89 * Math.PI / 180;

// ../../../../client/web/contracts/src/canvas/shot-camera.ts
var SHOT_CAMERA_ELEVATION_LIMIT = 89 * Math.PI / 180;

// ../../../../client/web/contracts/src/canvas/domain/runtime-node-data.ts
var RUNTIME_MODEL_PLACEMENT_FIELDS = ["offset", "scale", "yaw", "position", "rotation", "scale3"];
var RUNTIME_SHOT_POSE_FIELDS = ["azimuth", "distance", "target"];
var NODE_DATA_LOCAL_ONLY_FIELDS = [
  "jsPath",
  "imagePath",
  "localPath",
  "assetPath",
  "path",
  "filePath",
  "storageKey",
  "blob",
  "base64",
  "basis",
  "transform",
  "shotBasis",
  // 镜头 session-only 状态（change: add-model-editor-gizmo-shot-capture，design D2）：
  // 选中、hover、活动 handle、preview URL 与 capture 状态绝不进入 canonical canvas。
  "selectedCameraId",
  "cameraPreviewUrl",
  "cameraPreview",
  "cameraCapture",
  "cameraCaptureBusy"
];
var NODE_DATA_TRANSIENT_FIELDS = [
  "activeRunId",
  "taskStatus",
  "status",
  "progress",
  "providerTaskId",
  "outputAssetId",
  "error",
  "errorMessage",
  "result",
  "resultPreview",
  "frozenPreview",
  "durationSeconds",
  "resourceKind"
];
var NODE_DATA_TRANSIENT_SET = /* @__PURE__ */ new Set([...NODE_DATA_TRANSIENT_FIELDS, ...NODE_DATA_REMOVED_FIELDS]);
var LOCAL_ONLY_SET = new Set(NODE_DATA_LOCAL_ONLY_FIELDS);
var MODEL_PLACEMENT_SET = new Set(RUNTIME_MODEL_PLACEMENT_FIELDS);
var SHOT_POSE_SET = new Set(RUNTIME_SHOT_POSE_FIELDS);

// ../../../../client/web/contracts/src/canvas/render-scene/composite-asset-scope.ts
var COMPOSITE_ASSET_DIAMOND_EDGE_SLOPE = Math.sin(CANVAS_CAMERA_PITCH);
var COMPOSITE_ASSET_SCOPE_AXIS_X = 0.70710678;
var COMPOSITE_ASSET_SCOPE_AXIS_Y = Math.sin(CANVAS_CAMERA_PITCH) * COMPOSITE_ASSET_SCOPE_AXIS_X;

// ../../../../client/web/contracts/src/theme/schema.ts
var APP_THEME_SCHEMA_VERSION = "woohaa-app-theme-v2";
var APP_THEME_MAX_JSON_BYTES = 16 * 1024;
var APP_THEME_TOKEN_GROUPS = {
  web: [
    "webBackdrop",
    "webSurface",
    "webPanel",
    "webElevated",
    "webSubtle",
    "webTextPrimary",
    "webTextMuted",
    "webTextInverse",
    "webBorder",
    "webBorderStrong",
    "webOverlay",
    "webShadow"
  ],
  interaction: [
    "interactionAccent",
    "interactionAccentHover",
    "interactionAccentPressed",
    "interactionAccentSoft",
    "interactionFocus",
    "interactionOnAccent",
    "interactionDisabled"
  ],
  status: [
    "statusSuccess",
    "statusSuccessSoft",
    "statusSuccessBackground",
    "statusOnSuccess",
    "statusWarning",
    "statusWarningSoft",
    "statusWarningBackground",
    "statusOnWarning",
    "statusDanger",
    "statusDangerSoft",
    "statusDangerBackground",
    "statusOnDanger",
    "statusInfo",
    "statusInfoSoft",
    "statusInfoBackground",
    "statusOnInfo"
  ],
  canvas: [
    "canvasNodeSurface",
    "canvasNodeContent",
    "canvasNodeBorder",
    "canvasNodeBorderSelected",
    "canvasNodeShadow",
    "canvasNodeSelectedHalo",
    "canvasEdgeDefault",
    "canvasEdgeSelected",
    "canvasEdgeDraft",
    "canvasEdgeLabelBackground",
    "canvasEdgeLabelText",
    "canvasPortDefault",
    "canvasPortFill",
    "canvasResizeHandle",
    "canvasResizeHandleStripe",
    "canvasProgressTrack",
    "canvasProgressFill",
    "canvasCloseIcon",
    "canvasBodyText"
  ],
  nodeKind: [
    "nodeTextForeground",
    "nodeTextTint",
    "nodeImageForeground",
    "nodeImageTint",
    "nodeModelForeground",
    "nodeModelTint",
    "nodeAudioForeground",
    "nodeAudioTint",
    "nodeVideoForeground",
    "nodeVideoTint",
    "nodeDefaultForeground",
    "nodeDefaultTint"
  ],
  gizmo: ["gizmoAxisX", "gizmoAxisY", "gizmoAxisZ"],
  grid: ["gridMinor", "gridMajor", "gridSelection", "gridGizmo"],
  mediaDialog: [
    "mediaDialogBackdrop",
    "mediaDialogSurface",
    "mediaDialogText",
    "mediaDialogTextMuted",
    "mediaDialogControl",
    "mediaDialogControlBorder"
  ]
};
var APP_THEME_TOKEN_NAMES = Object.values(
  APP_THEME_TOKEN_GROUPS
).flat();
var TOKEN_NAME_SET = new Set(APP_THEME_TOKEN_NAMES);

// ../../../../client/web/contracts/src/theme/generated-default.ts
var APP_THEME_DEFAULT_TOKENS = {
  // web
  webBackdrop: "#f8f9f7",
  webSurface: "#ffffff",
  webPanel: "#ffffff",
  webElevated: "#ffffff",
  webSubtle: "#f6f8f6",
  webTextPrimary: "#30443a",
  webTextMuted: "#849188",
  webTextInverse: "#ffffff",
  webBorder: "#e2e8e4",
  webBorderStrong: "#7f9389",
  webOverlay: "#141e1a80",
  webShadow: "#2d423933",
  // interaction
  interactionAccent: "#16846c",
  interactionAccentHover: "#12755f",
  interactionAccentPressed: "#0f6553",
  interactionAccentSoft: "#d6ece2",
  interactionFocus: "#16846c",
  interactionOnAccent: "#ffffff",
  interactionDisabled: "#b6c2bb",
  // status
  statusSuccess: "#238569",
  statusSuccessSoft: "#8fd3bf",
  statusSuccessBackground: "#e9f5ef",
  statusOnSuccess: "#ffffff",
  statusWarning: "#a07627",
  statusWarningSoft: "#e7c98a",
  statusWarningBackground: "#fbf3e5",
  statusOnWarning: "#ffffff",
  statusDanger: "#bb5464",
  statusDangerSoft: "#e0a7b0",
  statusDangerBackground: "#f7edef",
  statusOnDanger: "#ffffff",
  statusInfo: "#3b7299",
  statusInfoSoft: "#a9c9dd",
  statusInfoBackground: "#eaf3fa",
  statusOnInfo: "#ffffff",
  // canvas
  canvasNodeSurface: "#ffffff",
  canvasNodeContent: "#f1f5f6",
  canvasNodeBorder: "#d9e1dd",
  canvasNodeBorderSelected: "#16846c",
  canvasNodeShadow: "#e4e9e6",
  canvasNodeSelectedHalo: "#d6ece2",
  canvasEdgeDefault: "#9aaea4",
  canvasEdgeSelected: "#16846c",
  canvasEdgeDraft: "#16846c",
  canvasEdgeLabelBackground: "#f8faf9",
  canvasEdgeLabelText: "#526b5e",
  canvasPortDefault: "#abbdb3",
  canvasPortFill: "#ffffff",
  canvasResizeHandle: "#526b5e",
  canvasResizeHandleStripe: "#ffffff",
  canvasProgressTrack: "#e2e8e7",
  canvasProgressFill: "#16846c",
  canvasCloseIcon: "#8a9a91",
  canvasBodyText: "#526b65",
  // nodeKind
  nodeTextForeground: "#3b7299",
  nodeTextTint: "#eaf3fa",
  nodeImageForeground: "#a45378",
  nodeImageTint: "#fbedf2",
  nodeModelForeground: "#247f71",
  nodeModelTint: "#e9f5ef",
  nodeAudioForeground: "#a07627",
  nodeAudioTint: "#fbf3e5",
  nodeVideoForeground: "#986a44",
  nodeVideoTint: "#faf0e9",
  nodeDefaultForeground: "#526b5e",
  nodeDefaultTint: "#f1f5f3",
  // gizmo
  gizmoAxisX: "#c83b42",
  gizmoAxisY: "#27824b",
  gizmoAxisZ: "#326dd1",
  // grid
  gridMinor: "#e2ead7",
  gridMajor: "#cee0cc",
  gridSelection: "#16846c",
  gridGizmo: "#3b7299",
  // mediaDialog
  mediaDialogBackdrop: "#101814f0",
  mediaDialogSurface: "#101814f0",
  mediaDialogText: "#f1f5f2",
  mediaDialogTextMuted: "#cfdad4",
  mediaDialogControl: "#ffffff",
  mediaDialogControlBorder: "#cbd7cf"
};
var APP_THEME_DEFAULT_ID = "default";
var APP_THEME_DEFAULT_PRESET = {
  id: APP_THEME_DEFAULT_ID,
  version: "woohaa-app-theme-v2",
  tokens: APP_THEME_DEFAULT_TOKENS
};
var APP_THEME_CSS_VARIABLES = {
  webBackdrop: "--app-web-backdrop",
  webSurface: "--app-web-surface",
  webPanel: "--app-web-panel",
  webElevated: "--app-web-elevated",
  webSubtle: "--app-web-subtle",
  webTextPrimary: "--app-web-text-primary",
  webTextMuted: "--app-web-text-muted",
  webTextInverse: "--app-web-text-inverse",
  webBorder: "--app-web-border",
  webBorderStrong: "--app-web-border-strong",
  webOverlay: "--app-web-overlay",
  webShadow: "--app-web-shadow",
  interactionAccent: "--app-interaction-accent",
  interactionAccentHover: "--app-interaction-accent-hover",
  interactionAccentPressed: "--app-interaction-accent-pressed",
  interactionAccentSoft: "--app-interaction-accent-soft",
  interactionFocus: "--app-interaction-focus",
  interactionOnAccent: "--app-interaction-on-accent",
  interactionDisabled: "--app-interaction-disabled",
  statusSuccess: "--app-status-success",
  statusSuccessSoft: "--app-status-success-soft",
  statusSuccessBackground: "--app-status-success-background",
  statusOnSuccess: "--app-status-on-success",
  statusWarning: "--app-status-warning",
  statusWarningSoft: "--app-status-warning-soft",
  statusWarningBackground: "--app-status-warning-background",
  statusOnWarning: "--app-status-on-warning",
  statusDanger: "--app-status-danger",
  statusDangerSoft: "--app-status-danger-soft",
  statusDangerBackground: "--app-status-danger-background",
  statusOnDanger: "--app-status-on-danger",
  statusInfo: "--app-status-info",
  statusInfoSoft: "--app-status-info-soft",
  statusInfoBackground: "--app-status-info-background",
  statusOnInfo: "--app-status-on-info",
  canvasNodeSurface: "--app-canvas-node-surface",
  canvasNodeContent: "--app-canvas-node-content",
  canvasNodeBorder: "--app-canvas-node-border",
  canvasNodeBorderSelected: "--app-canvas-node-border-selected",
  canvasNodeShadow: "--app-canvas-node-shadow",
  canvasNodeSelectedHalo: "--app-canvas-node-selected-halo",
  canvasEdgeDefault: "--app-canvas-edge-default",
  canvasEdgeSelected: "--app-canvas-edge-selected",
  canvasEdgeDraft: "--app-canvas-edge-draft",
  canvasEdgeLabelBackground: "--app-canvas-edge-label-background",
  canvasEdgeLabelText: "--app-canvas-edge-label-text",
  canvasPortDefault: "--app-canvas-port-default",
  canvasPortFill: "--app-canvas-port-fill",
  canvasResizeHandle: "--app-canvas-resize-handle",
  canvasResizeHandleStripe: "--app-canvas-resize-handle-stripe",
  canvasProgressTrack: "--app-canvas-progress-track",
  canvasProgressFill: "--app-canvas-progress-fill",
  canvasCloseIcon: "--app-canvas-close-icon",
  canvasBodyText: "--app-canvas-body-text",
  nodeTextForeground: "--app-node-text-foreground",
  nodeTextTint: "--app-node-text-tint",
  nodeImageForeground: "--app-node-image-foreground",
  nodeImageTint: "--app-node-image-tint",
  nodeModelForeground: "--app-node-model-foreground",
  nodeModelTint: "--app-node-model-tint",
  nodeAudioForeground: "--app-node-audio-foreground",
  nodeAudioTint: "--app-node-audio-tint",
  nodeVideoForeground: "--app-node-video-foreground",
  nodeVideoTint: "--app-node-video-tint",
  nodeDefaultForeground: "--app-node-default-foreground",
  nodeDefaultTint: "--app-node-default-tint",
  gizmoAxisX: "--app-gizmo-axis-x",
  gizmoAxisY: "--app-gizmo-axis-y",
  gizmoAxisZ: "--app-gizmo-axis-z",
  gridMinor: "--app-grid-minor",
  gridMajor: "--app-grid-major",
  gridSelection: "--app-grid-selection",
  gridGizmo: "--app-grid-gizmo",
  mediaDialogBackdrop: "--app-media-dialog-backdrop",
  mediaDialogSurface: "--app-media-dialog-surface",
  mediaDialogText: "--app-media-dialog-text",
  mediaDialogTextMuted: "--app-media-dialog-text-muted",
  mediaDialogControl: "--app-media-dialog-control",
  mediaDialogControlBorder: "--app-media-dialog-control-border"
};
var APP_THEME_CSS_VARIABLE_NAMES = Object.values(APP_THEME_CSS_VARIABLES);

// ../../../../client/web/contracts/src/theme/generated-dark.ts
var APP_THEME_DARK_TOKENS = {
  // web
  webBackdrop: "#101614",
  webSurface: "#151c19",
  webPanel: "#18201c",
  webElevated: "#1d2722",
  webSubtle: "#202a25",
  webTextPrimary: "#e6efe9",
  webTextMuted: "#93a69b",
  webTextInverse: "#f5faf7",
  webBorder: "#2b3731",
  webBorderStrong: "#6b8175",
  webOverlay: "#050908cc",
  webShadow: "#00000066",
  // interaction
  interactionAccent: "#2fb99b",
  interactionAccentHover: "#3fc9ab",
  interactionAccentPressed: "#27a88d",
  interactionAccentSoft: "#173b32",
  interactionFocus: "#2fb99b",
  interactionOnAccent: "#07120e",
  interactionDisabled: "#5d6e66",
  // status
  statusSuccess: "#35a686",
  statusSuccessSoft: "#1e4a3b",
  statusSuccessBackground: "#12332a",
  statusOnSuccess: "#06120e",
  statusWarning: "#d9a93f",
  statusWarningSoft: "#4a3a18",
  statusWarningBackground: "#33270f",
  statusOnWarning: "#1a1305",
  statusDanger: "#d76d7c",
  statusDangerSoft: "#4a2730",
  statusDangerBackground: "#33181f",
  statusOnDanger: "#1f0b10",
  statusInfo: "#6aa6d6",
  statusInfoSoft: "#1f3850",
  statusInfoBackground: "#142739",
  statusOnInfo: "#08141f",
  // canvas
  canvasNodeSurface: "#1b2420",
  canvasNodeContent: "#202b26",
  canvasNodeBorder: "#34443c",
  canvasNodeBorderSelected: "#2fb99b",
  canvasNodeShadow: "#00000055",
  canvasNodeSelectedHalo: "#1d4a3e",
  canvasEdgeDefault: "#546b60",
  canvasEdgeSelected: "#2fb99b",
  canvasEdgeDraft: "#2fb99b",
  canvasEdgeLabelBackground: "#101614",
  canvasEdgeLabelText: "#c5d5cc",
  canvasPortDefault: "#63796e",
  canvasPortFill: "#1b2420",
  canvasResizeHandle: "#c5d5cc",
  canvasResizeHandleStripe: "#101614",
  canvasProgressTrack: "#2b3731",
  canvasProgressFill: "#2fb99b",
  canvasCloseIcon: "#93a69b",
  canvasBodyText: "#c3d2c9",
  // nodeKind
  nodeTextForeground: "#7fb9e8",
  nodeTextTint: "#162b3b",
  nodeImageForeground: "#e08fb0",
  nodeImageTint: "#3a1f2b",
  nodeModelForeground: "#5ecbb8",
  nodeModelTint: "#12312c",
  nodeAudioForeground: "#e0b45e",
  nodeAudioTint: "#3a2d14",
  nodeVideoForeground: "#d99a6c",
  nodeVideoTint: "#3a2619",
  nodeDefaultForeground: "#a9bdb1",
  nodeDefaultTint: "#232f29",
  // gizmo
  gizmoAxisX: "#f3777e",
  gizmoAxisY: "#64cd8d",
  gizmoAxisZ: "#79a9ff",
  // grid
  gridMinor: "#1f2a25",
  gridMajor: "#2b3a32",
  gridSelection: "#2fb99b",
  gridGizmo: "#7fb9e8",
  // mediaDialog
  mediaDialogBackdrop: "#070b09f2",
  mediaDialogSurface: "#070b09f2",
  mediaDialogText: "#eef5f0",
  mediaDialogTextMuted: "#b5c7bc",
  mediaDialogControl: "#18201c",
  mediaDialogControlBorder: "#52685c"
};
var APP_THEME_DARK_ID = "dark";
var APP_THEME_DARK_PRESET = {
  id: APP_THEME_DARK_ID,
  version: "woohaa-app-theme-v2",
  tokens: APP_THEME_DARK_TOKENS
};

// ../../../../client/web/contracts/src/theme/builtins.ts
var APP_THEME_BUILTIN_PRESETS = {
  default: APP_THEME_DEFAULT_PRESET,
  dark: APP_THEME_DARK_PRESET
};
var APP_THEME_BUILTIN_PRESET_IDS = Object.keys(
  APP_THEME_BUILTIN_PRESETS
);

// ../../../../client/web/contracts/src/theme/fixtures.ts
var SENTINEL_OVERRIDES = {
  webBackdrop: "#faf5ff",
  webSurface: "#ffffff",
  webPanel: "#ffffff",
  webElevated: "#fdf8ff",
  webSubtle: "#f3ecff",
  webTextPrimary: "#1b1030",
  webTextMuted: "#5b4b7a",
  webTextInverse: "#ffffff",
  webBorder: "#e4d8f5",
  webBorderStrong: "#8b74b8",
  webOverlay: "#1b103080",
  webShadow: "#3a1d6633",
  interactionAccent: "#6d28d9",
  interactionAccentHover: "#5b21b6",
  interactionAccentPressed: "#4c1d95",
  interactionAccentSoft: "#ede9fe",
  interactionFocus: "#6d28d9",
  interactionOnAccent: "#ffffff",
  interactionDisabled: "#c4b5d8",
  statusSuccess: "#0f7a4d",
  statusSuccessSoft: "#7fd0ad",
  statusSuccessBackground: "#e4f6ee",
  statusOnSuccess: "#ffffff",
  statusWarning: "#8a5a00",
  statusWarningSoft: "#e7c98a",
  statusWarningBackground: "#fdf3df",
  statusOnWarning: "#ffffff",
  statusDanger: "#c0264f",
  statusDangerSoft: "#e0a7b0",
  statusDangerBackground: "#fbe9ee",
  statusOnDanger: "#ffffff",
  statusInfo: "#1d4ed8",
  statusInfoSoft: "#a9c0f0",
  statusInfoBackground: "#e6edfd",
  statusOnInfo: "#ffffff",
  canvasNodeSurface: "#ffffff",
  canvasNodeContent: "#f3ecff",
  canvasNodeBorder: "#d9c9f2",
  canvasNodeBorderSelected: "#6d28d9",
  canvasNodeShadow: "#e7ddf7",
  canvasNodeSelectedHalo: "#ede9fe",
  canvasEdgeDefault: "#a897cc",
  canvasEdgeSelected: "#6d28d9",
  canvasEdgeDraft: "#6d28d9",
  canvasEdgeLabelBackground: "#faf5ff",
  canvasEdgeLabelText: "#4c3a73",
  canvasPortDefault: "#b7a8d8",
  canvasPortFill: "#ffffff",
  canvasResizeHandle: "#4c3a73",
  canvasResizeHandleStripe: "#ffffff",
  canvasProgressTrack: "#e7ddf7",
  canvasProgressFill: "#6d28d9",
  canvasCloseIcon: "#8b74b8",
  canvasBodyText: "#4c3a73",
  nodeTextForeground: "#1d4ed8",
  nodeTextTint: "#e6edfd",
  nodeImageForeground: "#b8308b",
  nodeImageTint: "#fdeaf7",
  nodeModelForeground: "#0f7a72",
  nodeModelTint: "#e2f6f4",
  nodeAudioForeground: "#8a5a00",
  nodeAudioTint: "#fdf3df",
  nodeVideoForeground: "#b0501f",
  nodeVideoTint: "#fdece3",
  nodeDefaultForeground: "#4c3a73",
  nodeDefaultTint: "#f3ecff",
  gizmoAxisX: "#f43f5e",
  gizmoAxisY: "#84cc16",
  gizmoAxisZ: "#8b5cf6",
  gridMinor: "#e7def7",
  gridMajor: "#d3c1ee",
  gridSelection: "#6d28d9",
  gridGizmo: "#1d4ed8",
  mediaDialogBackdrop: "#160b2ef0",
  mediaDialogSurface: "#160b2ef0",
  mediaDialogText: "#f5f0ff",
  mediaDialogTextMuted: "#cbb9ea",
  mediaDialogControl: "#ffffff",
  mediaDialogControlBorder: "#8b74b8"
};
var SENTINEL_THEME_PRESET = {
  id: "sentinel",
  version: APP_THEME_SCHEMA_VERSION,
  tokens: { ...APP_THEME_DEFAULT_TOKENS, ...SENTINEL_OVERRIDES }
};

// ../../../../client/web/contracts/src/canvas/film-set-animations.ts
var FILM_SET_BACKDROP_THEME = "theme";
var BACKDROP_HEX = /^#[0-9a-f]{6}$/;
function readFilmSetBackdrop(input) {
  if (input === void 0 || input === null) return { ok: true, value: void 0 };
  if (typeof input !== "string") return { ok: false, reason: "backdrop \u5FC5\u987B\u662F\u5B57\u7B26\u4E32" };
  if (input === FILM_SET_BACKDROP_THEME) return { ok: true, value: void 0 };
  const normalized = input.trim().toLowerCase();
  if (!BACKDROP_HEX.test(normalized)) {
    return { ok: false, reason: "backdrop \u5FC5\u987B\u662F theme \u6216\u516D\u4F4D\u5341\u516D\u8FDB\u5236\u989C\u8272\uFF08\u5982 #000000\uFF09" };
  }
  return { ok: true, value: normalized };
}

// ../../../../client/web/contracts/src/canvas/edit-command-types.ts
var EDIT_APPLY_LIMITS = {
  /** 单次操作数上限。 */
  maxOperations: 256,
  /** 单次前置条件数上限。 */
  maxPreconditions: 256,
  /** 前置条件引用的节点数上限（delete 保护、恢复集合）。 */
  maxReferencedNodes: 512,
  /** 前置条件引用的边 ID 数上限。 */
  maxReferencedEdges: 512,
  /** 单条 edit.apply 的序列化 JSON 字节上限。 */
  maxPayloadBytes: 256 * 1024
};

// ../../../../client/web/contracts/src/canvas/image-edit.ts
var IMAGE_EDIT_LIMITS = {
  maxShapes: 128,
  maxPointsPerShape: 2048,
  maxSerializedBytes: 256 * 1024,
  minSourceDimension: 1,
  maxSourceDimension: 8192,
  maxSourcePixels: 8192 * 8192,
  minWidthInSourcePixels: 1,
  maxWidthInSourcePixels: 64
};
var IMAGE_PROJECT_LIMITS = {
  maxCanvasSide: 8192,
  maxCanvasPixels: 8192 * 8192,
  maxProjectBytes: 64 * 1024 * 1024,
  maxSourceAssetIds: 64,
  maxSerializedBytes: 256 * 1024
};
var IMAGE_EDIT_ALLOWED_COLORS = [
  "#ff8a1f",
  "#ff3b30",
  "#ffd23f",
  "#2f80ff",
  "#ffffff"
];
var ALLOWED_COLOR_SET2 = new Set(IMAGE_EDIT_ALLOWED_COLORS);

// ../../../../client/web/contracts/src/canvas/agent-node-descriptors.ts
var AGENT_NODE_DESCRIPTORS = [
  descriptor("text", "text", "\u6587\u672C", { task: true, prompt: true, executable: true, sourceLabel: "\u6587\u672C" }),
  descriptor("image", "image", "\u56FE\u7247", { task: true, prompt: true, executable: true, sourceLabel: "\u56FE\u7247" }),
  descriptor("model", "model3d", "\u6A21\u578B", { prompt: true, executable: false, sourceLabel: "\u6A21\u578B" }),
  descriptor("film-set", "group", "\u7247\u573A", { prompt: false, executable: false, sourceLabel: "\u7247\u573A" }),
  descriptor("video", "video", "\u89C6\u9891", { task: true, prompt: true, executable: true, sourceLabel: "" }),
  descriptor("audio", "audio", "\u97F3\u9891", { task: true, prompt: true, executable: true, sourceLabel: "" })
];
function descriptor(kind, canonicalType, label, options) {
  const taskKind = options.task ? NODE_TYPE_TO_TASK_KIND[canonicalType] : void 0;
  return {
    kind,
    canonicalType,
    label,
    defaultSize: effectiveCanvasNodeSize({ type: canonicalType }),
    ...taskKind ? { taskKind, defaultTaskStatus: "idle" } : {},
    supportsPrompt: options.prompt === true,
    executable: options.executable === true,
    ...options.sourceLabel ? { sourceLabel: options.sourceLabel } : {}
  };
}

// ../../../../client/web/contracts/src/canvas/agent-canvas-internal.ts
var AGENT_INTERNAL_BASE_PATH = "/internal/v2/agent-canvas";
var AGENT_INTERNAL_PATHS = {
  list: `${AGENT_INTERNAL_BASE_PATH}/list`,
  graph: `${AGENT_INTERNAL_BASE_PATH}/graph`,
  changes: `${AGENT_INTERNAL_BASE_PATH}/changes`,
  apply: `${AGENT_INTERNAL_BASE_PATH}/apply`,
  run: `${AGENT_INTERNAL_BASE_PATH}/run`,
  runStatus: `${AGENT_INTERNAL_BASE_PATH}/run/status`,
  runCancel: `${AGENT_INTERNAL_BASE_PATH}/run/cancel`,
  output: `${AGENT_INTERNAL_BASE_PATH}/output`
};

// ../../../../client/web/contracts/src/canvas/canvas-script/limits.ts
var DEFAULT_CANVAS_SCRIPT_VERSION = "woohaa-canvas-js-v1";
var CANVAS_SCRIPT_LIMITS = {
  /** 隔离执行 realm 的堆上限（执行器屏障；不是业务额度）。 */
  heapLimitBytes: 256 * 1024 * 1024,
  /** 隔离执行 realm 的调用栈上限（执行器屏障）。 */
  stackLimitBytes: 4 * 1024 * 1024,
  /** 标识符/展示标题的单字段长度约束。 */
  maxIdentifierChars: 200
};

// ../../../../client/web/contracts/src/canvas/canvas-script/api-guide.ts
var CANVAS_SCRIPT_HANDLE_RULES = [
  "handle \u53EA\u5C5E\u4E8E\u672C\u6B21\u6267\u884C\uFF1A\u8282\u70B9\u4E0E\u8FB9 handle \u533A\u5206\u79CD\u7C7B\uFF0C\u8FB9 handle \u4E0D\u80FD\u4F5C\u4E3A\u8282\u70B9\u53C2\u6570\u3002",
  "\u663E\u5F0F key \u5728\u8BA1\u5212\u5185\u552F\u4E00\uFF0C\u8282\u70B9\u4E0E\u8FB9\u5171\u4EAB\u540C\u4E00\u547D\u540D\u7A7A\u95F4\uFF1B\u91CD\u590D key \u62D2\u7EDD\u5E76\u5B9A\u4F4D\u51B2\u7A81\u8C03\u7528\u3002",
  "\u7701\u7565 key \u65F6\u6309\u8C03\u7528\u5E8F\u5217\u7A33\u5B9A\u5206\u914D\uFF1B\u663E\u5F0F key \u4E0E\u81EA\u52A8 key \u51B2\u7A81\u540C\u6837\u62D2\u7EDD\u3002",
  "key \u53EA\u662F plan-local ref\uFF0C\u4E0D\u662F\u8DE8\u6B21 upsert \u6807\u8BC6\uFF1B\u6700\u7EC8 nodeId/edgeId \u7531\u670D\u52A1\u7AEF\u6D3E\u751F\u3002",
  "\u4F2A\u9020\u3001\u8DE8\u6267\u884C\u3001\u524D\u5411\u5F15\u7528\uFF0C\u4EE5\u53CA\u5BF9\u5DF2\u5220\u9664\u8282\u70B9\u7EE7\u7EED\u64CD\u4F5C\u90FD\u88AB\u62D2\u7EDD\u3002"
];
var CANVAS_SCRIPT_PLACEMENT_RULES = [
  "placement.mode \u652F\u6301 absolute/auto/after/before/below\u3002",
  "after/before/below \u7684 anchor \u53EF\u4EE5\u662F published \u65E2\u6709\u8282\u70B9\uFF0C\u4E5F\u53EF\u4EE5\u662F\u672C\u6B21\u8BA1\u5212\u5185\u5DF2\u521B\u5EFA\u6216\u5DF2\u79FB\u52A8\u7684\u8282\u70B9\u3002",
  "\u5C1A\u672A\u521B\u5EFA\u6216\u5DF2\u5728\u540C\u4E00\u8BA1\u5212\u4E2D\u5220\u9664\u7684\u951A\u70B9\u5FC5\u987B\u62D2\u7EDD\uFF0C\u4E0D\u4F7F\u7528\u5360\u4F4D\u5750\u6807\u3002"
];
var CANVAS_SCRIPT_IF_RULES = [
  "\u5C40\u90E8\u6761\u4EF6\u6CBF\u7528\u65E2\u6709\u79CD\u7C7B\uFF1Anode-exists\u3001node-missing\u3001prompt-equals\u3001not-processing\u3002",
  "\u6240\u6709\u5199\u64CD\u4F5C\u53EF\u643A\u5E26 if\uFF1B\u6761\u4EF6\u5728\u6743\u5A01\u961F\u5217\u5185\u6309\u6700\u65B0\u72B6\u6001\u590D\u6838\u3002"
];
var CANVAS_SCRIPT_API_SIGNATURES = [
  {
    name: "node",
    signature: "canvas.node(kind, { key?, title?, prompt?, placement? })",
    description: "\u8BB0\u5F55 create_node\uFF1Bkind \u53D6\u81EA text/image/video/audio/model/film-set\u3002film-set \u521B\u5EFA\u81EA\u5305\u542B\u7247\u573A\u8282\u70B9\uFF0C\u968F\u540E\u7528\u7247\u573A\u5DE5\u5177\u5199\u5165\u5BF9\u8C61\u4E0E\u955C\u5934\u3002\u53EA\u63A5\u53D7\u8BED\u4E49\u5B57\u6BB5\uFF0C\u62D2\u7EDD nodeData/canonical type\u3002",
    returns: "\u672C\u6B21\u6267\u884C\u7684\u8282\u70B9 handle"
  },
  {
    name: "group",
    signature: "canvas.group(members, { key?, title, layout?, placement?, if? })",
    description: "\u521B\u5EFA\u771F\u5B9E\u547D\u540D\u5206\u7C7B\u7EC4\uFF0C\u81F3\u5C11\u4E00\u4E2A\u540C\u76F4\u5C5E parent \u7684\u8282\u70B9\u6216\u7EC4\u3002\u6210\u5458\u5173\u7CFB\u4FDD\u5B58\u4E3A parentId\uFF1B\u652F\u6301\u5D4C\u5957\u3002layout \u4E3A {mode:'grid', columns, gapX?, gapY?, origin?}\u3002",
    returns: "\u672C\u6B21\u6267\u884C\u7684\u7EC4\u8282\u70B9 handle"
  },
  { name: "reparent", signature: "canvas.reparent(nodes, groupOrNull, { if? }?)", description: "\u79FB\u5165\u7EC4\u6216\u79FB\u51FA\u5230\u9876\u5C42\uFF0C\u4FDD\u6301\u4E16\u754C\u4F4D\u7F6E\uFF1B\u62D2\u7EDD\u5FAA\u73AF\u548C\u7956\u5148/\u540E\u4EE3\u6DF7\u9009\u3002", returns: "void" },
  { name: "ungroup", signature: "canvas.ungroup(group, { if? }?)", description: "\u53EA\u79FB\u9664\u7EC4\u5BB9\u5668\uFF0C\u76F4\u5C5E\u6210\u5458\u63D0\u5347\u4E00\u7EA7\uFF0C\u4FDD\u7559\u5185\u5BB9\u548C\u771F\u5B9E\u8FDE\u7EBF\u3002remove(group) \u5219\u7EA7\u8054\u5220\u9664\u3002", returns: "void" },
  { name: "setTitle", signature: "canvas.setTitle(nodeOrGroup, title, { if? }?)", description: "\u4FEE\u6539\u8282\u70B9\u6216\u7EC4\u6807\u9898\uFF0C\u975E\u7A7A\u4E14\u6700\u591A 200 \u5B57\u7B26\u3002", returns: "void" },
  { name: "layout", signature: "canvas.layout(nodes, { mode: 'grid', columns, gapX?, gapY?, origin? }, { if? }?)", description: "\u5BF9\u540C\u5C42\u8282\u70B9\u6216\u7EC4\u6309\u6570\u7EC4\u987A\u5E8F\u7F51\u683C\u6392\u5E03\uFF0Corigin \u4E3A\u4E16\u754C\u5750\u6807\u3002\u7EC4\u6309\u5B8C\u6574\u8FB9\u754C\u6392\u5E03\uFF0C\u79FB\u52A8\u540E\u4EE3\u4E0D\u91CD\u590D\u3002", returns: "void" },
  {
    name: "existing",
    signature: "canvas.existing(nodeId)",
    description: "\u521B\u5EFA\u5DF2\u6709\u8282\u70B9 handle\uFF1B\u5B9E\u9645\u53EF\u89C1\u6027/\u5B58\u5728\u6027\u7531\u6388\u6743\u9886\u57DF\u6821\u9A8C\uFF0C\u4E0D\u89E6\u53D1 IO\u3002",
    returns: "\u6307\u5411\u65E2\u6709 nodeId \u7684\u8282\u70B9 handle"
  },
  {
    name: "connect",
    signature: "canvas.connect(from, to, { key?, label?, if? }?)",
    description: "\u8BB0\u5F55 connect\uFF1Bfrom/to \u5FC5\u987B\u662F\u8282\u70B9 handle\u3002\u8FD4\u56DE\u8FB9 handle\uFF0C\u8FB9 handle \u4E0D\u53EF\u4F5C\u8282\u70B9\u53C2\u6570\u3002",
    returns: "\u672C\u6B21\u6267\u884C\u7684\u8FB9 handle"
  },
  {
    name: "move",
    signature: "canvas.move(node, position, { if? }?)",
    description: "\u8BB0\u5F55 move_node\uFF1Bposition \u4E3A\u753B\u5E03\u4E16\u754C\u5750\u6807 { x, y }\u3002",
    returns: "void"
  },
  {
    name: "setPrompt",
    signature: "canvas.setPrompt(node, prompt, { if? }?)",
    description: "\u8BB0\u5F55 set_prompt\uFF1Bprompt \u662F\u751F\u6210\u8F93\u5165\uFF0C\u4E0D\u662F\u5DF2\u6709\u4F5C\u54C1\u8F93\u51FA\u3002",
    returns: "void"
  },
  {
    name: "remove",
    signature: "canvas.remove(nodeOrNodes, { if? }?)",
    description: "\u8BB0\u5F55 delete\uFF1B\u8282\u70B9\u6216\u8282\u70B9\u6570\u7EC4\uFF0C\u6309\u9886\u57DF\u89C4\u5219\u7EA7\u8054\u5220\u9664\u540E\u4EE3\u4E0E\u5173\u8054\u8FB9\u3002",
    returns: "void"
  }
];
var CANVAS_SCRIPT_GUIDE_EXAMPLE = `const brief = canvas.node("text", {
  key: "brief", title: "\u573A\u666F\u63CF\u8FF0", prompt: "\u96E8\u591C\u91CC\u7684\u57CE\u5E02\u8857\u9053",
  placement: { mode: "absolute", position: { x: 0, y: 0 } }
});
for (let i = 0; i < 3; i++) {
  const shot = canvas.node("image", {
    key: "shot-" + i, title: "\u955C\u5934 " + (i + 1), prompt: "\u7B2C " + (i + 1) + " \u4E2A\u673A\u4F4D",
    placement: { mode: "absolute", position: { x: 400, y: i * 320 } }
  });
  canvas.connect(brief, shot, { key: "edge-" + i });
}`;
var CANVAS_SCRIPT_ORGANIZATION_EXAMPLE = `const categories = [];
for (const [key, title, assets] of [
  ["characters", "\u89D2\u8272", ["\u6F5C\u5165\u8005", "\u5DE1\u903B\u5B88\u536B"]],
  ["architecture", "\u5EFA\u7B51", ["\u5730\u7816", "\u5B89\u5168\u95E8"]],
  ["cover", "\u63A9\u4F53", ["\u7269\u8D44\u7BB1"]],
  ["props", "\u9053\u5177\u673A\u5173", ["\u95E8\u7981\u5361", "\u8B66\u62A5\u5668"]],
  ["markers", "\u63D0\u793A\u6807\u8BB0", ["\u64A4\u79BB\u533A\u57DF"]]
]) {
  const members = assets.map((name, i) => canvas.node("model", {
    key: key + "-" + i, title: name, prompt: "\u4FEF\u89C6\u89D2\u6F5C\u884C\u6E38\u620F\u7D20\u6750\uFF1A" + name
  }));
  categories.push(canvas.group(members, {
    key, title, layout: { mode: "grid", columns: 3, gapX: 60, gapY: 60 },
    placement: { mode: "absolute", position: { x: -2600, y: categories.length * 760 } }
  }));
}`;
var CANVAS_SCRIPT_GUIDE_TEXT = `# Canvas Script API \u6307\u5357\uFF08${DEFAULT_CANVAS_SCRIPT_VERSION}\uFF09

\u63A8\u8350\u6D41\u7A0B\uFF1A\`list_canvases\` -> \`get_canvas_capabilities\` -> \`get_canvas_graph\` -> \`get_canvas_script_api\`
-> \`validate_canvas_script\` -> \`submit_canvas_script\` -> \`run_canvas_node\`\u3002

\u753B\u5E03\u521B\u5EFA\u4E0E\u4FEE\u6539\u4F18\u5148\u4F7F\u7528 Canvas Script\u3002\u540C\u4E00\u4EFB\u52A1\u4E2D\u5DF2\u77E5\u7684\u8282\u70B9\u3001\u8FDE\u7EBF\u548C\u4FEE\u6539\u5E94\u5728\u9884\u7B97\u5185\u5408\u5E76\u4E3A\u4E00\u4E2A\u811A\u672C\uFF0C
\u4E00\u6B21\u9884\u68C0\u3001\u4E00\u6B21\u539F\u5B50\u63D0\u4EA4\uFF1B\u53EA\u6709\u8D85\u51FA\u9884\u7B97\u6216\u4F9D\u8D56\u524D\u6B21\u7ED3\u679C\u65F6\u624D\u62C6\u5206\u3002

\u811A\u672C\u5728\u4E00\u4E2A\u540C\u6B65\u51FD\u6570\u4F53\u5185\u6267\u884C\uFF0C\u6CE8\u5165 \`canvas\` API\u3002\u53EA\u652F\u6301\u53D8\u91CF\u3001\u5FAA\u73AF\u3001\u51FD\u6570\u4E0E\u786E\u5B9A\u6027\u8BA1\u7B97\uFF1B
\u4E0D\u63D0\u4F9B\u7F51\u7EDC\u3001\u6587\u4EF6\u3001\u73AF\u5883\u3001\u51ED\u636E\u3001\u8FDB\u7A0B\u3001\u6A21\u5757\u52A0\u8F7D\u3001\u65F6\u95F4\u3001\u968F\u673A\u6E90\u3001\u52A8\u6001\u4EE3\u7801\u6216\u5F02\u6B65\u4EFB\u52A1\u3002

## API \u7B7E\u540D

${CANVAS_SCRIPT_API_SIGNATURES.map((entry) => `- \`${entry.signature}\` \u2014 ${entry.description}`).join("\n")}

## \u5206\u7C7B\u6574\u7406

\u7D20\u6750\u5E93\u5E94\u6309\u7528\u9014\u521B\u5EFA\u6709\u6807\u9898\u7684\u771F\u5B9E\u5206\u7C7B\u7EC4\uFF0C\u5206\u7C7B\u7EC4\u4FDD\u6301\u5728\u9876\u5C42\uFF08\u753B\u5E03\u4E0D\u652F\u6301\u5D4C\u5957\u7EC4\uFF09\u3002\u53EA\u6709\u4E00\u4E2A\u6210\u5458\u4E5F\u80FD\u6210\u7EC4\u3002
\u6807\u9898\u524D\u7F00\u3001\u6392\u6210\u51E0\u884C\u3001\u6587\u672C\u8BF4\u660E\u4E0D\u80FD\u4EE3\u66FF\u7EC4\u3002\u7EC4\u53EA\u8868\u8FBE\u5F52\u5C5E\uFF0C\u4E0D\u5E94\u4E3A\u4E86\u5206\u7C7B\u800C\u6DFB\u52A0 connect\u3002
connect \u53EA\u8868\u8FBE\u771F\u5B9E\u751F\u6210\u8F93\u5165\u3002canvas.node \u4E0D\u63A5\u53D7 group kind\uFF1B\u4F7F\u7528 canvas.group\u3002
\u9884\u68C0\u68C0\u67E5 organization.groups \u4E2D\u7684 title/memberIds/worldBounds\uFF0C\u518D\u63D0\u4EA4\u5E76\u8BFB\u56DE parentId \u6838\u5BF9\u3002
\u6A21\u578B\u65B0\u5EFA\u5C3A\u5BF8\u4E3A 248\xD7232\u3002\u56FE\u67E5\u8BE2 size/worldBounds\u3001\u76F8\u5BF9\u5B9A\u4F4D\u3001grid \u4E0E\u7EC4\u5305\u56F4\u6846\u90FD\u4F7F\u7528\u548C\u754C\u9762\u4E00\u81F4\u7684\u6709\u6548\u5C3A\u5BF8\uFF1B\u5DF2\u6709 196\xD764 \u6A21\u578B\u5361\u7247\u4E5F\u6309\u5B9E\u9645\u9884\u89C8\u5C3A\u5BF8\u53C2\u4E0E\u5E03\u5C40\uFF0C\u65E0\u9700\u624B\u5DE5\u8865\u507F\u5C3A\u5BF8\u3002
get_canvas_graph \u7684 parentId=null \u67E5\u8BE2\u9876\u5C42\uFF0CparentId=\u7EC4 ID \u5206\u9875\u8BFB\u53D6\u76F4\u5C5E\u6210\u5458\u3002

## handle \u4E0E key \u89C4\u5219

${CANVAS_SCRIPT_HANDLE_RULES.map((rule) => `- ${rule}`).join("\n")}

## placement \u89C4\u5219

${CANVAS_SCRIPT_PLACEMENT_RULES.map((rule) => `- ${rule}`).join("\n")}

## \u5C40\u90E8\u6761\u4EF6\uFF08if\uFF09

${CANVAS_SCRIPT_IF_RULES.map((rule) => `- ${rule}`).join("\n")}

## \u6267\u884C\u8FB9\u754C

\u811A\u672C\u5728\u9694\u79BB\u7684\u6267\u884C\u57DF\u5185\u8FD0\u884C\uFF0C\u53EF\u88AB\u7528\u6237\u968F\u65F6\u505C\u6B62\uFF1B\u6CA1\u6709\u5E94\u7528\u4FA7\u7684\u6E90\u7801\u5B57\u8282\u3001\u6267\u884C\u65F6\u957F\u3001\u64CD\u4F5C\u6570\u6216 API \u8C03\u7528\u6B21\u6570\u4E0A\u9650\u3002

- \u771F\u5B9E\u5185\u5B58\u4E0D\u8DB3\u4F1A\u4F5C\u4E3A\u6267\u884C\u57DF\u7684\u8D44\u6E90\u6545\u969C\u8FD4\u56DE\uFF0C\u4E0D\u5F71\u54CD\u5176\u4ED6\u8BF7\u6C42
- \u76F8\u540C\u811A\u672C\u5728\u72EC\u7ACB\u6267\u884C\u57DF\u5404\u8FD0\u884C\u4E00\u6B21\u4EE5\u6821\u9A8C\u786E\u5B9A\u6027
- \u5927\u811A\u672C/\u5927\u8BA1\u5212\u5B8C\u6574\u8BB0\u5F55\u540E\u7531\u540C\u4E00 planner \u6821\u9A8C\u5E76\u4E00\u6B21\u539F\u5B50\u63D0\u4EA4

## \u793A\u4F8B

\`\`\`js
${CANVAS_SCRIPT_GUIDE_EXAMPLE}
\`\`\`

## \u5206\u7C7B\u7D20\u6750\u5E93\u793A\u4F8B

\`\`\`js
${CANVAS_SCRIPT_ORGANIZATION_EXAMPLE}
\`\`\`

## \u7EA6\u5B9A

- \`prompt\` \u662F\u751F\u6210\u8F93\u5165\uFF0C\u4E0D\u5192\u5145\u5DF2\u6709\u6587\u672C\u4F5C\u54C1\u8F93\u51FA\uFF1B\u8282\u70B9\u6267\u884C\u5FC5\u987B\u5728\u753B\u5E03\u63D0\u4EA4\u6210\u529F\u540E\u7ECF \`run_canvas_node\` \u89E6\u53D1\u3002
- \u63D0\u4EA4\u6210\u529F\u540E\u811A\u672C\u6E90\u7801\u4E0D\u5199\u5165\u753B\u5E03\u3001\u6570\u636E\u5E93\u3001\u5386\u53F2\u6216\u65E5\u5FD7\uFF1B\u91CD\u8BD5\u76F8\u540C\u8EAB\u4EFD\u4E0E\u5185\u5BB9\u8FD4\u56DE\u9996\u6B21\u56DE\u6267\u3002
- model \u79CD\u7C7B\u6620\u5C04\u4E3A\u5408\u6CD5\u81EA\u5305\u542B \`model3d\` \u5360\u4F4D\u6A21\u578B\uFF1B\u5B9E\u9645\u6A21\u578B\u6E90\u7801\u901A\u8FC7\u72EC\u7ACB model authoring \u5DE5\u5177\u63D0\u4EA4\u3002`;

// ../../../../client/web/contracts/src/canvas/film-set-export-profile.ts
var FILM_SET_EXPORT_PROFILE_SPECS = {
  standard: { shortEdge: 720, frameRate: 30, bitrate: 4e6 },
  hd: { shortEdge: 1080, frameRate: 30, bitrate: 8e6 },
  hd60: { shortEdge: 1080, frameRate: 60, bitrate: 12e6 }
};

// ../../../../client/web/contracts/src/canvas/content-recording-port.ts
var NATIVE_RECORDING_FRAME_RATE = FILM_SET_EXPORT_PROFILE_SPECS.standard.frameRate;

// ../../../../client/web/contracts/src/canvas/recording-protocol.ts
var MAX_CONTROL_MESSAGE_BYTES = 8 * 1024 * 1024;
var MAX_RESOURCE_CHUNK_BYTES = 1024 * 1024;

// ../../../../client/web/contracts/src/canvas/glb/parse.ts
var GLB_MAX_FILE_BYTES = 32 * 1024 * 1024;

// ../../../../client/web/contracts/src/canvas/model-api-descriptor.ts
var MODEL_RENDER_BUDGET = {
  /** 单个 primitive 的估算顶点成本（segment 按自身 shape 取 box/capsule）。 */
  vertexCost: {
    box: QUALITY_VERTEX_COUNTS.box,
    cylinder: QUALITY_VERTEX_COUNTS.cylinder,
    sphere: QUALITY_VERTEX_COUNTS.sphere,
    capsule: QUALITY_VERTEX_COUNTS.capsule
  }
};

// ../../../../client/web/contracts/src/canvas/model-api-descriptor-motion.ts
var MOTION_GRAPHICS_SHOWCASE = {
  /** 对象脚本：卡片根淡入 + scale 0.6→1.08→1 弹出；连线沿 X 伸长。 */
  objectScript: `motion.model.tween("root", {
  property: "opacity", from: 0, to: 1,
  startTime: 0, endTime: 0.6, easing: "easeOut"
});
motion.model.keyframes("root", {
  property: "scale",
  frames: [
    { time: 0, value: [0.6, 0.6, 0.6], easing: "easeOut" },
    { time: 0.35, value: [1.08, 1.08, 1.08], easing: "easeOut" },
    { time: 0.6, value: [1, 1, 1], easing: "easeOut" }
  ]
});
motion.model.tween("connector", {
  property: "scale", from: [0.05, 1, 1], to: [1, 1, 1],
  startTime: 1.4, endTime: 2.4, easing: "easeInOut"
});`,
  /** 镜头脚本：distance 从 26 用 easeOut 推到 14（推近画布边缘）。 */
  cameraScript: `motion.camera.tween({
  property: "distance", from: 26, to: 14,
  startTime: 1.2, endTime: 3.2, easing: "easeOut"
});`
};
var MOTION_GRAPHICS_SHOWCASE_TEXT = `\u5BF9\u8C61\u811A\u672C\uFF08\u5199\u5230\u5361\u7247 item \u7684 binding.motion\uFF1B\u540C\u4E00\u811A\u672C\u590D\u7528\u5230\u53E6\u5916\u4E24\u5F20\u5361\u7247\uFF0C\u53EA\u9519\u5F00 playback.startTime\uFF09\uFF1A
${MOTION_GRAPHICS_SHOWCASE.objectScript}

\u955C\u5934\u811A\u672C\uFF08\u5199\u5230\u7247\u573A\u955C\u5934\u7684 cameraMotion\uFF09\uFF1A
${MOTION_GRAPHICS_SHOWCASE.cameraScript}`;

// ../../../../client/web/contracts/src/canvas/mcp-internal/types.ts
var MCP_INTERNAL_BASE_PATH = "/internal/v1/model-mcp";
var MCP_INTERNAL_MAX_BODY_BYTES = 12 * 1024 * 1024;
var MCP_INTERNAL_PATHS = {
  listNodes: `${MCP_INTERNAL_BASE_PATH}/nodes/list`,
  getNode: `${MCP_INTERNAL_BASE_PATH}/nodes/get`,
  submitScript: `${MCP_INTERNAL_BASE_PATH}/scripts/submit`,
  reportScript: `${MCP_INTERNAL_BASE_PATH}/scripts/report`,
  renderPreview: `${MCP_INTERNAL_BASE_PATH}/preview`,
  applyCommands: `${MCP_INTERNAL_BASE_PATH}/commands`,
  mutateCameras: `${MCP_INTERNAL_BASE_PATH}/cameras/mutate`,
  mutateCamerasBatch: `${MCP_INTERNAL_BASE_PATH}/cameras/mutate-batch`,
  /**
   * 模型批量作者（model-script-batch）内部路径
   * （change: 2026-10-13-add-canvas-script-authoring）：批量读取、只校验、校验并提交。
   */
  getModelNodes: `${MCP_INTERNAL_BASE_PATH}/models/nodes`,
  validateModelScripts: `${MCP_INTERNAL_BASE_PATH}/models/validate`,
  submitModelScripts: `${MCP_INTERNAL_BASE_PATH}/models/submit`,
  createFilmSetNode: `${MCP_INTERNAL_BASE_PATH}/film-set/create`,
  commitAnimation: `${MCP_INTERNAL_BASE_PATH}/animation/commit`,
  confirmAdaptation: `${MCP_INTERNAL_BASE_PATH}/animation/confirm-adaptation`,
  importModelSnapshot: `${MCP_INTERNAL_BASE_PATH}/animation/import-model`,
  importFilmSetContent: `${MCP_INTERNAL_BASE_PATH}/film-set/import-content`,
  mutateFilmSetItem: `${MCP_INTERNAL_BASE_PATH}/film-set/item`,
  /** 片场媒体条目受控导入（change: 2026-10-19-extend-film-set-for-motion-graphics，D5）。 */
  addFilmSetMedia: `${MCP_INTERNAL_BASE_PATH}/film-set/media`,
  /** agent 发起显式导出与查询（change 同上，D8）。 */
  exportFilmSetClip: `${MCP_INTERNAL_BASE_PATH}/film-set/export`,
  getFilmSetExport: `${MCP_INTERNAL_BASE_PATH}/film-set/export-status`,
  /**
   * 模型规模统计（与聚焦面板同源；可为候选脚本预检）。
   * change: 2026-10-18-align-model-statistics-with-agent。
   */
  modelStatistics: `${MCP_INTERNAL_BASE_PATH}/models/statistics`
};

// ../../../../client/web/contracts/src/canvas/position-update.ts
var CANVAS_POSITION_MAX_BYTES = 1024 * 1024;

// ../../../../client/web/contracts/src/canvas/node-history/types.ts
var NODE_HISTORY_LIMITS = {
  defaultPageSize: 20,
  maxPageSize: 100,
  /** 单节点版本上限（超过后确定性淘汰最旧且非当前版本）。 */
  maxVersionsPerNode: 50,
  /** 单画布历史记录总数预算。 */
  maxEntriesPerCanvas: 5e3,
  /** 单画布历史元数据字节预算。 */
  maxBytesPerCanvas: 64 * 1024 * 1024,
  /** 模型缩略图缓存字节预算。 */
  thumbnailCacheBytes: 32 * 1024 * 1024
};

// ../../../../client/web/contracts/src/canvas/menu-sections.ts
var CANVAS_MENU_SECTION = {
  basicMaterial: "basic-material",
  creationTools: "creation-tools",
  other: "other"
};
var CANVAS_MENU_SECTION_ORDER = [
  CANVAS_MENU_SECTION.basicMaterial,
  CANVAS_MENU_SECTION.creationTools,
  CANVAS_MENU_SECTION.other
];

// ../../../../client/web/contracts/src/backend/marketplace.ts
var DEFAULT_GITHUB_MARKETPLACE_REPOS = "woohaa3/woohaa3-marketplace";

// ../../../../client/web/contracts/src/settings/index.ts
var SETTING_DEFINITIONS = {
  "storage.primary": {
    kind: "string",
    default: "local",
    reload: "hot",
    label: "\u4E3B\u5B58\u50A8\u540E\u7AEF",
    description: "\u5A92\u4F53\u4E0E\u4EFB\u52A1\u8BFB\u5199\u5B57\u8282\u7684\u540E\u7AEF id\uFF08\u7F3A\u7701 local\uFF09\uFF1B\u540E\u7AEF\u7531\u6269\u5C55\u5C42\u63D2\u4EF6\u6CE8\u518C"
  },
  "exposer.primary": {
    kind: "string",
    default: "",
    reload: "hot",
    label: "\u5BF9\u5916\u5730\u5740\u63D0\u4F9B\u8005",
    description: "\u9700\u8981\u5916\u90E8\u5730\u5740\u65F6\u4F7F\u7528\u7684\u63D0\u4F9B\u8005 id\uFF08\u540E\u7AEF\u81EA\u5E26\u7B7E\u540D\u65F6\u4E5F\u53EF\u76F4\u63A5\u586B\u540E\u7AEF id\uFF09\uFF1B\u7559\u7A7A\u8868\u793A\u4E0D\u9009\u63D0\u4F9B\u8005\u2014\u2014\u6CA1\u6709\u9ED8\u8BA4\u63D0\u4F9B\u8005\uFF0C\u6B64\u65F6\u53EA\u6709\u5F53\u524D\u540E\u7AEF\u81EA\u5E26\u7B7E\u540D\u624D\u6709\u5BF9\u5916\u5730\u5740"
  },
  "storage.expose": {
    kind: "string",
    default: "",
    reload: "hot",
    label: "\u5BF9\u5916\u5B58\u50A8\u540E\u7AEF\uFF08\u65E7\u952E\uFF09",
    description: "\u5DF2\u7531 exposer.primary \u53D6\u4EE3\uFF1B\u4EC5\u5728 exposer.primary \u4E3A\u7A7A\u65F6\u4F5C\u4E3A\u517C\u5BB9\u503C\u8BFB\u53D6"
  },
  "telemetry.local.enabled": {
    kind: "boolean",
    default: true,
    reload: "hot",
    label: "\u672C\u673A\u9065\u6D4B\u8BB0\u5F55",
    description: "\u5728\u672C\u673A\u8BB0\u5F55\u53EF\u590D\u76D8\u7684\u5BA2\u6237\u7AEF\u4E8B\u5B9E\uFF1B\u5173\u95ED\u540E\u65E0\u6CD5\u4E8B\u540E\u590D\u76D8\uFF0C\u6570\u636E\u4E0D\u51FA\u672C\u673A"
  },
  "telemetry.local.retentionDays": {
    kind: "integer",
    default: 7,
    min: 1,
    max: 365,
    reload: "hot",
    label: "\u9065\u6D4B\u4FDD\u7559\u5929\u6570",
    description: "\u8D85\u8FC7\u8BE5\u5929\u6570\u7684\u672C\u673A\u9065\u6D4B\u8BB0\u5F55\u4F1A\u88AB\u6E05\u7406"
  },
  "telemetry.local.maxRows": {
    kind: "integer",
    default: 2e5,
    min: 1e4,
    max: 5e6,
    reload: "hot",
    label: "\u9065\u6D4B\u6700\u591A\u4FDD\u7559\u6761\u6570",
    description: "\u8D85\u8FC7\u8BE5\u6761\u6570\u7684\u6700\u65E7\u8BB0\u5F55\u4F1A\u88AB\u6E05\u7406\uFF1B\u4E0E\u4FDD\u7559\u5929\u6570\u540C\u65F6\u751F\u6548"
  },
  /**
   * 遥测**总开关**：core 只管"发不发"。
   *
   * 「发到哪、用什么凭据」是出口插件自己的配置（例如服务端接入扩展的部署地址与登录），
   * core 不枚举出口、也不给它配置目的地——否则 core 要知道具体扩展的身份，
   * 那既违反 `extension-purity` 的取向，也会造出一个"配了却没人读"的控件。
   * 当前没有安装任何上报扩展时，开关打开也没有出口可投递（页面的状态面会如实说明）。
   */
  "telemetry.export.enabled": {
    kind: "boolean",
    default: false,
    reload: "hot",
    label: "\u5916\u90E8\u4E0A\u62A5\u9065\u6D4B",
    description: "\u603B\u5F00\u5173\uFF1A\u628A\u672C\u673A\u9065\u6D4B\u4EA4\u7ED9\u5DF2\u6CE8\u518C\u7684\u4E0A\u62A5\u51FA\u53E3\u3002\u76EE\u7684\u5730\u4E0E\u51ED\u636E\u7531\u5BF9\u5E94\u6269\u5C55\u81EA\u5DF1\u914D\u7F6E\uFF08\u5982\u670D\u52A1\u7AEF\u63A5\u5165\uFF09\uFF1B\u6CA1\u6709\u5B89\u88C5\u8FD9\u7C7B\u6269\u5C55\u65F6\u6B64\u9879\u4E0D\u4EA7\u751F\u4EFB\u4F55\u5916\u53D1"
  },
  /**
   * 扩展激活 / 释放时限（change: 2026-10-21-harden-extension-fault-isolation，D4）。
   * 超时按失败处理（`activation-timeout`），不自动重试；取值有界，防止设成 0 或无穷。
   */
  "extensions.activationTimeoutMs": {
    kind: "integer",
    default: 3e4,
    min: 1e3,
    max: 6e5,
    reload: "hot",
    label: "\u6269\u5C55\u6FC0\u6D3B\u65F6\u9650\uFF08\u6BEB\u79D2\uFF09",
    description: "\u5355\u4E2A\u6269\u5C55\u542F\u52A8\u6216\u914D\u7F6E\u66F4\u65B0\u540E\u91CD\u542F\u7684\u6700\u957F\u7B49\u5F85\uFF1B\u8D85\u65F6\u89C6\u4E3A\u6FC0\u6D3B\u5931\u8D25\uFF0C\u4E0D\u62D6\u4F4F\u5BBF\u4E3B\u5C31\u7EEA"
  },
  "extensions.disposeTimeoutMs": {
    kind: "integer",
    default: 1e4,
    min: 1e3,
    max: 6e5,
    reload: "hot",
    label: "\u6269\u5C55\u91CA\u653E\u65F6\u9650\uFF08\u6BEB\u79D2\uFF09",
    description: "\u505C\u7528\u6269\u5C55\u65F6\u7B49\u5F85\u5176\u91CA\u653E\u7684\u6700\u957F\u65F6\u95F4\uFF1B\u8D85\u65F6\u540E\u653E\u5F03\u7B49\u5F85\u5E76\u5B8C\u6210\u505C\u7528\uFF0C\u6B8B\u7559\u8D44\u6E90\u7531\u4E0B\u6B21\u91CD\u542F\u56DE\u6536"
  },
  /**
   * 受管扩展的签名信任根（change: 2026-10-21-add-extension-marketplace-point，D2）。
   * 只在本机配置文件里维护；来源返回的任何「已验证」标志都不被信任。
   */
  "extensions.marketplace.trustedKeys": {
    kind: "string",
    default: "",
    reload: "hot",
    label: "\u6269\u5C55\u7B7E\u540D\u4FE1\u4EFB\u6839",
    description: "Ed25519 \u516C\u94A5\u5217\u8868\uFF0C\u9017\u53F7\u5206\u9694\uFF0C\u6BCF\u9879\u4E3A <keyId>=<base64 \u516C\u94A5> \u6216 base64 \u516C\u94A5\uFF1B\u7B7E\u540D\u4E0D\u5728\u6B64\u5217\u8868\u4E2D\u7684\u6269\u5C55\u5305\u62D2\u7EDD\u5B89\u88C5"
  },
  /** D5：只允许 local-file 来源，且仅本机显式开启（开发用）。也可用 WOOHAA3_EXTENSION_ALLOW_UNSIGNED=1。 */
  "extensions.marketplace.allowUnsigned": {
    kind: "boolean",
    default: false,
    reload: "hot",
    label: "\u5141\u8BB8\u672A\u7B7E\u540D\u7684\u672C\u5730\u6269\u5C55\u5305",
    description: "\u4EC5\u7528\u4E8E\u5F00\u53D1\uFF1A\u5141\u8BB8\u4ECE\u672C\u5730\u6587\u4EF6\u5B89\u88C5\u672A\u7B7E\u540D\u7684 .wxt\uFF1B\u5E02\u573A\u6765\u6E90\u7684\u5305\u59CB\u7EC8\u8981\u6C42\u7B7E\u540D\u3002\u672A\u7B7E\u540D\u6269\u5C55\u4E0E\u5BBF\u4E3B\u540C\u8FDB\u7A0B\u8FD0\u884C\uFF0C\u6CA1\u6709\u9694\u79BB"
  },
  /**
   * GitHub Release 市场来源（核心自带，与 local-file 同级）。
   *
   * 缺省开启并指向官方市场仓库：插件面板开箱就能搜索安装。关闭后来源不可用、不发起任何请求。
   * 未配令牌时走 github.com 网页端点（不消耗 REST API 60 次/小时的匿名限额）；配了令牌或
   * 换过 API 基址才走 REST（私有仓库 / GitHub Enterprise Server）。
   */
  "extensions.marketplace.github.enabled": {
    kind: "boolean",
    default: true,
    reload: "hot",
    label: "\u542F\u7528 GitHub \u6269\u5C55\u6765\u6E90",
    description: "\u5141\u8BB8\u4ECE GitHub Release \u5B89\u88C5 .wxt \u6269\u5C55\u5305\u3002\u5F00\u542F\u540E\u672C\u673A\u4F1A\u8BBF\u95EE GitHub\uFF1B\u5173\u95ED\u65F6\u4E0D\u53D1\u8D77\u4EFB\u4F55\u8BF7\u6C42"
  },
  /** GitHub 仓库列表：逗号分隔的 `owner/repo`；每个仓库的 Release 资产都是候选包。 */
  "extensions.marketplace.github.repos": {
    kind: "string",
    default: DEFAULT_GITHUB_MARKETPLACE_REPOS,
    reload: "hot",
    label: "GitHub \u6269\u5C55\u4ED3\u5E93\u5217\u8868",
    description: "\u9017\u53F7\u5206\u9694\u7684 owner/repo \u5217\u8868\uFF0C\u7F3A\u7701\u4E3A\u5B98\u65B9\u5E02\u573A\u4ED3\u5E93\u3002\u5B89\u88C5\u5019\u9009\u6765\u81EA\u8FD9\u4E9B\u4ED3\u5E93 Release \u7684 .wxt \u8D44\u4EA7\uFF0C\u6587\u4EF6\u540D\u987B\u4E3A <extensionId>-<version>.wxt"
  },
  /** GitHub REST API 地址；企业自建 GitHub（GitHub Enterprise Server）可改为 https://<host>/api/v3。 */
  "extensions.marketplace.github.apiBase": {
    kind: "url",
    protocols: ["https:", "http:"],
    default: "https://api.github.com",
    reload: "hot",
    label: "GitHub API \u5730\u5740",
    description: "GitHub REST API \u57FA\u5740\uFF0C\u7F3A\u7701 https://api.github.com\uFF1BGitHub Enterprise Server \u6539\u4E3A https://<host>/api/v3"
  },
  /** GitHub 访问令牌：私有仓库或强制走 REST API 用；只应写在密钥文件，缺省匿名走网页端点。 */
  "extensions.marketplace.github.token": {
    kind: "string",
    default: "",
    reload: "hot",
    secret: true,
    label: "GitHub \u8BBF\u95EE\u4EE4\u724C",
    description: "\u8BBF\u95EE\u79C1\u6709\u4ED3\u5E93\u7528\uFF1B\u586B\u5199\u540E\u6539\u8D70 REST API\uFF08\u79C1\u6709\u4ED3\u5E93\u53EA\u80FD\u8FD9\u6837\uFF09\u3002\u7559\u7A7A\u65F6\u533F\u540D\u8BFB github.com \u7F51\u9875\u7AEF\u70B9\uFF0C\u4E0D\u5360 API \u9650\u989D\u3002\u8BF7\u5199\u5728\u5BC6\u94A5\u6587\u4EF6\uFF08woohaa.secrets.yml\uFF09\uFF0C\u4E0D\u8981\u5199\u8FDB\u666E\u901A\u914D\u7F6E\u6587\u4EF6"
  }
};
var SETTING_KEYS = Object.keys(SETTING_DEFINITIONS);
function parseSettingValue(definition, raw) {
  switch (definition.kind) {
    case "string":
      return typeof raw === "string" ? { ok: true, value: raw } : { ok: false, message: "\u5E94\u4E3A\u5B57\u7B26\u4E32" };
    case "url": {
      if (typeof raw !== "string") return { ok: false, message: "\u5E94\u4E3A URL \u5B57\u7B26\u4E32" };
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        return { ok: false, message: `\u4E0D\u662F\u5408\u6CD5 URL\uFF1A${raw}` };
      }
      if (!definition.protocols.includes(parsed.protocol)) {
        return { ok: false, message: `\u534F\u8BAE\u5FC5\u987B\u662F ${definition.protocols.join(" / ")}` };
      }
      return { ok: true, value: raw.replace(/\/+$/, "") };
    }
    case "integer": {
      const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, message: "\u5E94\u4E3A\u6574\u6570" };
      if (definition.min !== void 0 && value < definition.min) return { ok: false, message: `\u4E0D\u80FD\u5C0F\u4E8E ${definition.min}` };
      if (definition.max !== void 0 && value > definition.max) return { ok: false, message: `\u4E0D\u80FD\u5927\u4E8E ${definition.max}` };
      return { ok: true, value };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true" || raw === "1") return { ok: true, value: true };
      if (raw === "false" || raw === "0") return { ok: true, value: false };
      return { ok: false, message: "\u5E94\u4E3A\u5E03\u5C14\u503C" };
    }
  }
}

// ../../../../client/web/contracts/src/extension/plugin.ts
function defineConfigSchema(fields) {
  return {
    fields,
    "~standard": {
      version: 1,
      vendor: "woohaa3",
      validate(value) {
        const input = value !== null && typeof value === "object" ? value : {};
        const output = {};
        const issues = [];
        for (const [key, field] of Object.entries(fields)) {
          const raw = input[key];
          if (raw === void 0 || raw === null || raw === "") {
            if (field.default !== void 0) output[key] = field.default;
            continue;
          }
          const parsed = parseSettingValue(field, raw);
          if (parsed.ok) output[key] = parsed.value;
          else issues.push({ message: `${key}\uFF1A${parsed.message}`, path: [key] });
        }
        return issues.length > 0 ? { issues } : { value: output };
      }
    }
  };
}

// ../../../../client/web/contracts/src/extension/host/foundation-slots.json
var foundation_slots_default = { known: ["storage", "identity", "access"], required: ["storage"], accessControl: ["identity", "access"] };

// ../../../../client/web/contracts/src/extension/host/bootstrap.ts
var FOUNDATION_SLOTS = Object.freeze(foundation_slots_default.known);
var REQUIRED_FOUNDATION_SLOTS = Object.freeze(foundation_slots_default.required);

// ../../../../client/web/contracts/src/extension/host/http.ts
var APPLICATION_EXTENSION_HANDLER_PURPOSES = ["read", "auth-transaction", "new-work", "work-control"];
var DEFAULT_PLUGIN_STREAM_BUDGET = {
  heartbeatMs: 15e3,
  deadlineMs: 9e5,
  maxEvents: 2e3,
  maxBytes: 8 * 1024 * 1024
};
var PURPOSE_SET = new Set(APPLICATION_EXTENSION_HANDLER_PURPOSES);

// ../../../../client/web/contracts/src/telemetry/event.ts
var TELEMETRY_EVENT_NAMES = [
  "canvas.open",
  "canvas.save",
  "canvas.edit",
  "sync.connect",
  "sync.reconcile",
  "local.validation",
  "task.terminal",
  // 性能事实（change: 2026-10-25-enhance-telemetry-performance-collection，design D2）。
  // 四个名字代替一个 `perf.sample`：`kind` 与 `stage` 的取值集合不同，混在一个名字里
  // 会让 `groupBy` 的分组结果无法解释。
  "perf.startup",
  "perf.interaction",
  "perf.segment",
  "perf.frame",
  /**
   * 一次总览 LOD 采样：当前可见画布上**所有声明总览 LOD 的片场**的档位分布
   * （2026-10-28 片场总览 LOD 遥测采样）。
   *
   * 只记聚合计数，不携带完整节点 ID、标题或任何画布内容：这条事实回答"看画布时片场停在哪档"；
   * dev 构建另带 `owners`（节点 id 末 12 字符摘要）用于把非总览档位的根落到可回查的个体，
   * 以及 `pins`（当前截图 pin 的目标节点摘要）用于回答"是谁把它按在 High"，发布构建不携带。
   */
  "perf.lod",
  /**
   * 扩展贡献在宿主中渲染或回调失败（change: 2026-10-21-harden-extension-fault-isolation）。
   * 只带 `extension`/`slot`/`epoch` 属性与错误类别 `errorCode`，不带错误消息与堆栈。
   */
  "extension.render-failed"
];
var TELEMETRY_RESULTS = ["success", "failure", "cancelled", "rejected"];
var TELEMETRY_ORIGINS = ["browser", "desktop", "local-host"];
var TELEMETRY_SURFACES = ["canvas", "editor", "sync", "local-validation", "task"];
var TELEMETRY_ATTRIBUTE_KEYS = [
  "canvas",
  // 一次画布会话的标识（32 位小写十六进制，管理端只做聚合与关联）。
  // 与 trace_id 的分工：trace 关联一次操作，session 关联“用户这次进入画布后的
  // 全部动作”。没有它，管理端只能按 actor + 时间窗猜会话边界。
  "session",
  "node",
  "provider",
  "model",
  "phase",
  "status",
  "code",
  "source",
  "version",
  // 性能事件的维度与计数（change: 2026-10-25-enhance-telemetry-performance-collection）。
  // `mode` / `kind` / `stage` 是封闭枚举；其余是窗口累计计数（数值型属性）。
  "mode",
  "kind",
  "stage",
  // JS 帧循环执行次数/秒（`perf.frame`）：含输入触发的强制 flush，不是画布出帧率。
  "fps",
  // 画布实际出帧率（`perf.frame`，仅 dev 能读到渲染器计数时携带）：与开发期 FPS 徽标同源，
  // 是 Bevy Render PostCleanup 的完成帧率（不代表 GPU present）。`fps` 高而 `renderFps` 低，
  // 说明瓶颈在渲染侧；两者都低才是更新循环被按住。
  "renderFps",
  "sceneBuilds",
  "sceneSubmits",
  "sceneDedupes",
  "viewportSubmits",
  "positionSubmits",
  "stringify",
  "wasmAcceptMs",
  "frameExecMs",
  "frameExecutions",
  // 每帧 3D 主 pass 的 draw call 记录数（`perf.frame`，仅 dev 可读时携带）：
  // 5 秒级回归里 `fps` 看不出的"画得太多"由这条回答（2026-10-28 片场总览 LOD 修复）。
  "drawCalls",
  // 每帧提交的模型实例数（`perf.frame`，仅 dev）：draw call 少不等于画得少，
  // 一次 instanced draw 可以带上万个实例。AABB 失效/批级剔除漏掉时，`drawCalls`
  // 仍在个位数而这里会顶到几千上万。
  "drawnInstances",
  // 主世界（Update 图）每帧墙钟与其中模型同步系统的每帧墙钟（`perf.frame`，仅 dev）。
  // `frameExecMs` 只覆盖 JS 帧循环、渲染三阶段只覆盖 render sub-app，两者之间的缺口
  // （模型同步、预览准入、LOD、块布局）只有这两项能回答。
  "mainMs",
  "modelMs",
  // 渲染三阶段的每帧平均墙钟（`perf.frame`，仅 dev）：Queue / Prepare / Render。
  // `fps` 掉下来而 `frameExecMs`（JS 帧循环）没涨时，就靠这三个数回答"多出来的时间
  // 花在渲染提交、资源准备，还是根本不在本进程的渲染阶段里"。
  "queueMs",
  "prepareMs",
  "renderMs",
  // 模型卡片预览的规模快照（`perf.frame`，仅 dev）：`d`=延迟队列、`v`=可见、`l`=在途、
  // `r`=就绪、`b`=纹理 MB。`pacing` 只说"还有子系统要连续帧"，这条说"是哪一种、多大"。
  "previews",
  // 帧内最贵的几步（`perf.frame`，仅 dev）：`<步骤>:<每帧 ms>`，按每帧耗时取前三。
  // `frameExecMs` 只说"这一帧花了多少"，这条回答"花在 viewport-notify、image-sync、
  // video-sync 还是 composite-media-sync"——片场相关的逐帧会话同步就在这里露头。
  "steps",
  // 总览 LOD 采样（`perf.lod`）的分布计数：实际已发布档位、准备中数量与最大投影占比。
  // 只做聚合，不引入节点维度；`maxAttributes` 仍能装下一条样本。
  "low",
  "medium",
  "high",
  "preparing",
  "fractionMax",
  // 总览 LOD 的原因分布（`perf.lod`）：`overview=12,offscreen=2` 形式的固定词表计数。
  // 用来区分「同一档位」下的不同成因（屏外未决策 / 高优先消费者 / 退化 bounds），
  // 不含节点身份；词表封闭，长度有界。
  "reasons",
  // 总览 LOD 的非总览根摘要（`perf.lod`，仅 dev 构建）：`<nodeId 末 12 字符>:<原因>`。
  // 回答「到底是哪几个根停在 High」——只给不透明摘要，用于本机回查画布文档，
  // 不含标题/素材/脚本；最多 3 条，超出以 `+N` 收尾。
  "owners",
  // 当前截图 pin 的目标节点摘要（`perf.lod`，仅 dev 构建）：`capture.pins` 里的节点 id 末 12 字符。
  // 与 `owners` 的区别：`owners` 是被 pin 住的根，`pins` 是发起 pin 的截图目标
  // （可能是镜头预览节点），用来区分「整场截图/视频导出」与「镜头参考录制」。最多 3 条 + `+N`。
  "pins",
  // 总览 LOD 采样的画布侧旁证（`perf.lod`，仅 dev 构建）：这一帧激活的离屏预览相机数，
  // 与渲染器持有的模型 mesh 实体数。draw call 是所有视图的合计，这两个数把
  // 「几何多」与「同一份几何被多个离屏相机重复画」区分开。
  "views",
  "entities",
  // 绘制结构的旁证（`perf.lod`，仅 dev 构建）：总部件数、已进入静态批次的部件数、
  // 批次实体数。用来区分「部件太多无法合批」与「合批粒度过细（同材质被网格切片拆开）」。
  "parts",
  "batched",
  "batches",
  // 帧节奏状态（`perf.lod`，仅 dev 构建）：`idle` / `dwell` / `active:<忙碌项列表>`。
  // 静止降频是否真的落在停帧上只能从运行侧读；没生效时这份词表指出是哪一项一直要求连续帧。
  "pacing",
  // 总览片场栅格缓存状态（`perf.lod`，仅 dev）：`sets=N,live=M,high=..,hot=..,pin=..,bounds=..,layer=..`。
  // 用来判读「每个片场一张缓存图」是否真的接管，以及没接管时卡在哪一条件。
  "raster",
  /** 扩展身份（`extension.render-failed`）：宿主盖章的 extensionId，不是用户内容。 */
  "extension",
  /** 宿主 slot 名（`extension.render-failed`）。 */
  "slot",
  /** 扩展装配 epoch（`extension.render-failed`）。 */
  "epoch"
];
var TELEMETRY_PERF_MODES = ["dev", "preview", "production"];
var TELEMETRY_PERF_STARTUP_STAGES = [
  "wasm-module",
  "scene-build",
  "app-scope",
  "canvas-scope",
  "session-open",
  "bevy-runtime"
];
var TELEMETRY_PERF_SEGMENT_STAGES = [
  "hit-query",
  "gesture-begin",
  "gesture-move",
  "gesture-commit",
  "viewport-apply",
  "scene-build",
  "frame-submit"
];
var TELEMETRY_PERF_STAGES = [
  ...TELEMETRY_PERF_STARTUP_STAGES,
  ...TELEMETRY_PERF_SEGMENT_STAGES
];
var TELEMETRY_PERF_INPUT_KINDS = [
  "pan",
  "wheel-pan",
  "zoom",
  "drag",
  "resize",
  "connect",
  "marquee",
  "double-click",
  "context-menu"
];
var TELEMETRY_LIMITS = {
  /**
   * 单条事件最多属性对。
   *
   * 从 8 提到 12：`perf.frame` 要一条装下窗口内的十项计数 + `mode`（design D2/D4）。
   * 从 12 提到 13：`perf.frame` 再带一条 `renderFps`（画布实际出帧率），否则它会被挤掉，
   * 而"画布掉帧"正是 `fps`（JS 帧循环次数）回答不了的那个问题。
   * 从 13 提到 18：帧率掉下来时要能定位到"时间花在哪"——`drawnInstances`（实例数）
   * 把「画得少」与「draw call 少但实例多」分开，`queueMs`/`prepareMs`/`renderMs`
   * 把渲染三阶段拆开，`pacing` 指出还有没有子系统在要求连续帧。
   * 再提到 19：`steps` 直接把帧内最贵的三步写进同一条事实。
   * 再提到 20：`previews` 把预览延迟队列与纹理占用写进同一条事实。
   * 再提到 22：`mainMs`/`modelMs` 补上主世界那一层（JS 与渲染三阶段都没覆盖）。
   * 上限仍在，属性键集合也仍是封闭枚举，所以基数与长度都有界。
   */
  maxAttributes: 22,
  /** 属性值单行最大字符数（按码点截断，中文不会被切坏）。 */
  maxAttributeValueLength: 128,
  /** 属性序列化后最大字节数；超预算按排序确定性丢弃。 */
  maxAttributesBytes: 1024,
  /** 错误码最大长度（与 `[a-z0-9][a-z0-9_.:-]{0,63}` 一致）。 */
  maxErrorCodeLength: 64,
  /** `trace_id` 固定 32 位小写十六进制。 */
  traceIdLength: 32,
  /** 前端版本最大长度（与 proto 的 `frontend_version` 一致）。 */
  maxFrontendVersionLength: 64,
  /** 耗时上限：一天。超过视为坏数据而不是"很慢"。 */
  maxDurationMs: 864e5,
  /** 客户端时钟超前于宿主时钟的可接受窗口；超过即视为不可信时间。 */
  maxClockSkewMs: 5 * 60 * 1e3,
  /** 单批最多事件数（与 proto 的 `ReportEvents` 一致）。 */
  maxBatchEvents: 100,
  /** 单请求体上限。仓库无统一 helper，按 `task-inspection-api.ts` 的 64 KiB。 */
  maxRequestBytes: 64 * 1024
};
var EVENT_NAME_SET = new Set(TELEMETRY_EVENT_NAMES);
var RESULT_SET = new Set(TELEMETRY_RESULTS);
var ORIGIN_SET = new Set(TELEMETRY_ORIGINS);
var SURFACE_SET = new Set(TELEMETRY_SURFACES);
var ATTRIBUTE_KEY_SET = new Set(TELEMETRY_ATTRIBUTE_KEYS);
var PERF_MODE_SET = new Set(TELEMETRY_PERF_MODES);
var PERF_STAGE_SET = new Set(TELEMETRY_PERF_STAGES);
var PERF_INPUT_KIND_SET = new Set(TELEMETRY_PERF_INPUT_KINDS);

// ../../../../client/web/contracts/src/telemetry/query.ts
var TELEMETRY_WINDOW_MS = {
  "1h": 60 * 60 * 1e3,
  "6h": 6 * 60 * 60 * 1e3,
  "24h": 24 * 60 * 60 * 1e3,
  "7d": 7 * 24 * 60 * 60 * 1e3
};
var TELEMETRY_BUCKET_MS = {
  "1m": 60 * 1e3,
  "5m": 5 * 60 * 1e3,
  "1h": 60 * 60 * 1e3
};

// ../../../../client/web/contracts/src/canvas/scene-package.ts
var SCENE_PACKAGE_LIMITS = { compressedBytes: 256 * 1024 * 1024, unpackedBytes: 512 * 1024 * 1024, decodedImageBytes: 512 * 1024 * 1024, entries: 4096, nodes: 5e4, edges: 2e5 };

// ../project-verifier/src/project-verification.ts
import { inflateRawSync } from "node:zlib";

// ../protocol/src/image-edit.ts
var SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS = [1];
var IMAGE_PROJECT_CONTENT_TYPE = "application/vnd.woohaa.photocraft-project";
var IMAGE_PROJECT_LIMITS2 = {
  /** 单个编辑画布/置入图单边上限。 */
  maxCanvasSide: 8192,
  /** 画布/置入图像素总量上限。 */
  maxCanvasPixels: 8192 * 8192,
  /** 文档层数上限（含背景、文字与调整层）。 */
  maxLayers: 64,
  /** 图案资源数量、单边及累计像素上限。 */
  maxPatterns: 64,
  maxPatternSide: 1024,
  maxPatternPixels: 4 * 1024 * 1024,
  /** 单工程压缩字节上限（64 MiB）；部署限制更低时取更低值。 */
  maxProjectBytes: 64 * 1024 * 1024,
  /** 工程解压后资源字节上限（256 MiB）。 */
  maxDecompressedResourceBytes: 256 * 1024 * 1024,
  /** 工程结构条目上限。 */
  maxEntries: 4096,
  /** 文档层级上限。 */
  maxDocumentDepth: 16,
  /** 单条目解压后上限。 */
  maxEntryDecompressedBytes: 128 * 1024 * 1024,
  /** 可引用的来源资产数量上限。 */
  maxSourceAssetIds: 64,
  /** 选区羽化范围（源像素）。 */
  maxFeatherSourcePixels: 100,
  /** 笔刷尺寸范围（源像素）。 */
  minBrushSizeSourcePixels: 1,
  maxBrushSizeSourcePixels: 512,
  /** 工程定义序列化字节上限。 */
  maxSerializedBytes: 256 * 1024,
  /**
   * PSD 交换预算（change: 2026-10-22-complete-photocraft-webui-editing，任务 1.4 / design D6）。
   *
   * 原始输入与单次导出各限 64 MiB；候选工程仍须满足既有保存预算。
   */
  maxPsdInputBytes: 64 * 1024 * 1024,
  maxPsdOutputBytes: 64 * 1024 * 1024,
  /** 跨文档图层载荷（`LayerTransferBundle`）原始字节与层数预算（design D5）。 */
  maxLayerTransferBytes: 64 * 1024 * 1024,
  maxLayerTransferLayers: 64,
  /** ABR／笔刷库预算（design D4）：单文件、单次导入、库总数、笔尖单边、累计像素与解码字节。 */
  maxAbrFileBytes: 32 * 1024 * 1024,
  maxAbrPresetsPerImport: 256,
  maxBrushLibraryPresets: 256,
  maxBrushTipSide: 1024,
  maxBrushResourcePixels: 16 * 1024 * 1024,
  maxBrushDecodedBytes: 128 * 1024 * 1024,
  /** 参数滤镜与选区修改的半径上限（源像素）。 */
  maxFilterRadius: 1e3,
  maxSelectionRadius: 500,
  /** 直方图采样像素上限（与画布像素上限同量级，避免额外大分配）。 */
  maxHistogramSamples: 8192 * 8192,
  /** 工作区同时打开的文档数（含子文档）；运行政策，不写入工程格式。 */
  maxOpenDocuments: 8,
  /**
   * 矢量载荷预算（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
   *
   * 与 `rust/project-limits.json` 同名同值，由 `contract-fixture.test.ts` 与
   * `limits_agree.rs` 双向核对；**解码前**按 manifest 计数累计，超限整份拒绝。
   */
  maxVectorSavedPaths: 256,
  maxVectorSubpaths: 4096,
  maxVectorKnotsPerSubpath: 4096,
  maxVectorPathPoints: 32768
};

// ../protocol/src/features/layers/content.ts
var IMAGE_PROJECT_BLEND_MODES = ["normal", "dissolve", "darken", "multiply", "color-burn", "linear-burn", "darker-color", "lighten", "screen", "color-dodge", "linear-dodge", "lighter-color", "overlay", "soft-light", "hard-light", "vivid-light", "linear-light", "pin-light", "hard-mix", "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity", "pass-through"];
function isSupportedImageProjectEffects(input, patterns) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const effects = input;
  if (typeof effects.enabled !== "boolean" || !Array.isArray(effects.items) || effects.items.length > 64 || effects.psd_raw != null) return false;
  if (effects.reference != null && (!Array.isArray(effects.reference) || effects.reference.length !== 2 || !effects.reference.every((value) => typeof value === "number" && Number.isFinite(value)))) return false;
  const kinds = ["DropShadow", "InnerShadow", "OuterGlow", "InnerGlow", "Stroke", "ColorOverlay", "GradientOverlay", "PatternOverlay", "Satin", "BevelEmboss"];
  let budget = 8192;
  const references = [];
  const bounded = (value, depth, key = "") => {
    if (depth > 16 || budget-- <= 0) return false;
    if (value === null) return key === "texture" || key === "contour";
    if (typeof value === "boolean") return true;
    if (typeof value === "number") {
      const range = { opacity: [0, 1], spread: [0, 1], range: [0, 1], jitter: [0, 1], noise: [0, 1], size: [0, 2048], soften: [0, 2048], distance: [0, 2048], depth: [0, 10], "texture-depth": [-10, 10], scale: [0.01, 10], angle: [-360, 360], altitude: [0, 90] };
      const [min, max] = range[key] ?? [-1e6, 1e6];
      return Number.isFinite(value) && value >= min && value <= max;
    }
    if (typeof value === "string") return value.length <= 200;
    if (Array.isArray(value)) return value.length <= 256 && (!["stops", "opacity_stops"].includes(key) || value.every((stop) => Array.isArray(stop) && stop.length === 2 && typeof stop[0] === "number" && Number.isFinite(stop[0]) && stop[0] >= 0 && stop[0] <= 1 && (key !== "opacity_stops" || typeof stop[1] === "number" && Number.isFinite(stop[1]) && stop[1] >= 0 && stop[1] <= 1))) && value.every((item) => bounded(item, depth + 1));
    if (typeof value !== "object" || !value) return false;
    const entries = Object.entries(value);
    if (["Pattern", "PatternOverlay", "texture"].includes(key)) {
      const p = value;
      if (typeof p.id !== "string" || !p.id.trim() || typeof p.name !== "string" || !p.name.trim() || typeof p.scale !== "number" || !Number.isFinite(p.scale) || p.scale < 0.01 || p.scale > 10 || p.phase !== void 0 && (!Array.isArray(p.phase) || p.phase.length !== 2)) return false;
      references.push({ id: p.id, name: p.name });
    }
    if ("Custom" in value) {
      const custom = value.Custom;
      if (!custom || typeof custom !== "object" || Array.isArray(custom)) return false;
      const { points, corners } = custom;
      if (!Array.isArray(points) || points.length < 2 || points.length > 256) return false;
      let previous = -1;
      if (!points.every((point) => {
        if (!point || typeof point !== "object" || Array.isArray(point)) return false;
        const { input: input2, output } = point;
        if (typeof input2 !== "number" || typeof output !== "number" || !Number.isFinite(input2) || !Number.isFinite(output) || input2 < 0 || input2 > 1 || output < 0 || output > 1 || input2 <= previous) return false;
        previous = input2;
        return true;
      })) return false;
      if (corners !== void 0 && (!Array.isArray(corners) || corners.length > points.length || !corners.every((corner) => typeof corner === "boolean"))) return false;
    }
    return entries.length <= 64 && entries.every(([field, item]) => (field !== "blend" || typeof item === "string" && IMAGE_PROJECT_BLEND_MODES.some((mode) => mode !== "pass-through" && mode.replace(/-/g, "") === item.toLowerCase())) && bounded(item, depth + 1, field === "depth" && key === "texture" ? "texture-depth" : field));
  };
  const shape = effects.items.every((item) => item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 1 && kinds.includes(Object.keys(item)[0]) && bounded(item, 0));
  return shape && (patterns === void 0 || references.every((ref) => patterns.some((p) => !!p && typeof p === "object" && p.id === ref.id && p.name === ref.name)));
}
function isSupportedImageProjectPatterns(value) {
  if (value === void 0) return true;
  if (!Array.isArray(value) || value.length > IMAGE_PROJECT_LIMITS2.maxPatterns) return false;
  const ids = /* @__PURE__ */ new Set();
  let pixels = 0;
  const object2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  return value.every((p) => {
    if (!object2(p) || !isNonEmptyShortString(p.id, 200) || !p.id.trim() || ids.has(p.id) || !isNonEmptyShortString(p.name, 200) || !p.name.trim() || !isFinitePositiveInteger(p.width) || !isFinitePositiveInteger(p.height) || p.width > IMAGE_PROJECT_LIMITS2.maxPatternSide || p.height > IMAGE_PROJECT_LIMITS2.maxPatternSide) return false;
    ids.add(p.id);
    pixels += p.width * p.height;
    if (pixels > IMAGE_PROJECT_LIMITS2.maxPatternPixels) return false;
    const s = p.surface;
    if (!object2(s) || !object2(s.format)) return false;
    const f = s.format;
    if (f.mode !== "Rgb" || f.sample !== "U8" || typeof f.alpha !== "boolean" || typeof s.default !== "string" || s.default.length !== (f.alpha ? 8 : 6) || !/^[a-f0-9]+$/i.test(s.default) || !Array.isArray(s.tiles) || s.tiles.length > 16) return false;
    const width = p.width, height = p.height;
    const coords = /* @__PURE__ */ new Set();
    return s.tiles.every((t) => {
      if (!object2(t) || typeof t.tx !== "number" || typeof t.ty !== "number" || !Number.isInteger(t.tx) || !Number.isInteger(t.ty) || t.tx < 0 || t.ty < 0 || t.tx >= Math.ceil(width / 256) || t.ty >= Math.ceil(height / 256)) return false;
      const key = `${t.tx},${t.ty}`;
      if (coords.has(key)) return false;
      coords.add(key);
      return true;
    });
  });
}

// ../protocol/src/features/shared/content.ts
function isFinitePositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isNonEmptyShortString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

// ../protocol/src/features/vectors/params.ts
var VECTOR_LIMITS = {
  /** 多边形/星形边数范围。 */
  minSides: 3,
  maxSides: 100,
  /** 星形内外比例范围（不含 1）。 */
  minStarRatio: 0.01,
  maxStrokeWidth: 1e6,
  /** 单条路径子路径数上限。 */
  maxSubpaths: IMAGE_PROJECT_LIMITS2.maxVectorSubpaths,
  /** 已存命名路径数量上限。 */
  maxSavedPaths: IMAGE_PROJECT_LIMITS2.maxVectorSavedPaths,
  /** 单个子路径的锚点数量上限。 */
  maxKnotsPerSubpath: IMAGE_PROJECT_LIMITS2.maxVectorKnotsPerSubpath,
  /** 一份工程内所有矢量路径的锚点累计上限（解码前预算）。 */
  maxPathPoints: IMAGE_PROJECT_LIMITS2.maxVectorPathPoints,
  /** 自定形状条目上限。 */
  maxCustomShapes: 256,
  /** 预设名称字符上限。 */
  maxPresetName: 200,
  /** 预设快照字节上限。 */
  maxSnapshotBytes: 1 << 20,
  /** 坐标可保存范围：画布单边 × 8（与内核 `point_in_canvas` 同口径）。 */
  coordLimit: IMAGE_PROJECT_LIMITS2.maxCanvasSide * 8
};

// ../protocol/src/features/vectors/index.ts
var feature = {
  id: "vectors",
  capabilities: [
    { stage: "P7", order: 7, id: "vector.path" },
    { stage: "P7", order: 8, id: "vector.shape" },
    { stage: "P7", order: 9, id: "vector.mask" }
  ]
};

// ../protocol/src/features/files/document-spec.ts
var NEW_DOCUMENT_LIMITS = {
  maxSide: 8192,
  maxPixels: 8192 * 8192,
  minResolution: 1,
  maxResolution: 3e4,
  maxNameChars: 255,
  /** 预设数量上限（与引擎 `document_preset_cmds::MAX_PRESETS` 一致）。 */
  maxPresets: 256,
  /** 最近设置条目上限（与引擎一致）。 */
  maxRecent: 20
};

// ../protocol/src/features/files/metadata.ts
var FILE_INFO_LIMITS = {
  maxFieldChars: 4096,
  maxKeywords: 256,
  maxKeywordChars: 256,
  maxTotalChars: 64 * 1024
};

// ../protocol/src/features/files/recent-files.ts
var MAX_RECENT_FILE_BYTES = IMAGE_PROJECT_LIMITS2.maxProjectBytes;
var MAX_RECENT_TOTAL_BYTES = 3 * IMAGE_PROJECT_LIMITS2.maxProjectBytes;

// ../protocol/src/features/files/index.ts
var feature2 = {
  id: "files",
  capabilities: []
};

// ../protocol/src/features/io/index.ts
var feature3 = {
  id: "io",
  capabilities: [
    { stage: "P2", order: 3, id: "file.place-image" },
    { stage: "P3", order: 0, id: "format.psd-import" },
    { stage: "P3", order: 1, id: "format.psd-export" },
    { stage: "P3", order: 2, id: "format.psd-loss-report" }
  ]
};
var OPEN_RASTER_EXTENSIONS = [
  // 可编辑打开
  "png",
  "apng",
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "tif",
  "tiff",
  "webp",
  "gif",
  "bmp",
  "dib",
  "tga",
  "icb",
  "vda",
  "vst",
  "ico",
  "qoi",
  "pnm",
  "pbm",
  "pgm",
  "ppm",
  "pam",
  "pfm",
  // 只读打开（可建成可编辑文档，但不写回该扩展名）
  "pcx",
  "xpm",
  "dds"
];
var OPEN_RASTER_MIMES = [
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/x-tga",
  "image/x-icon",
  "image/qoi",
  "image/x-portable-anymap",
  "image/x-pcx",
  "image/x-xpixmap",
  "image/vnd-ms.dds"
];
var OPEN_RASTER_ACCEPT = [
  ...OPEN_RASTER_MIMES,
  ...OPEN_RASTER_EXTENSIONS.map((extension) => `.${extension}`)
].join(",");

// ../protocol/src/features/selections/index.ts
var feature4 = {
  id: "selections",
  capabilities: [
    { stage: "P0", order: 11, id: "selection.rect" },
    { stage: "P0", order: 12, id: "selection.lasso" },
    { stage: "P0", order: 13, id: "selection.feather" },
    { stage: "P0", order: 14, id: "mask.pixel" },
    { stage: "P5", order: 5, id: "selection.magic-wand" },
    { stage: "P5", order: 6, id: "selection.quick-select" },
    { stage: "P5", order: 7, id: "selection.color-range" },
    { stage: "P5", order: 8, id: "selection.modify" },
    { stage: "P5", order: 9, id: "selection.refine-edge" },
    { stage: "P7", order: 10, id: "selection.from-path" }
  ]
};

// ../protocol/src/features/channels/index.ts
var feature5 = {
  id: "channels",
  capabilities: [
    { stage: "P7", order: 38, id: "channel.panel" },
    { stage: "P7", order: 39, id: "channel.color-target" },
    { stage: "P7", order: 40, id: "channel.alpha" },
    { stage: "P7", order: 41, id: "channel.spot" },
    { stage: "P7", order: 42, id: "channel.split-merge" },
    { stage: "P7", order: 43, id: "channel.apply-image" },
    { stage: "P7", order: 44, id: "channel.calculations" },
    { stage: "P7", order: 45, id: "channel.luminosity-selection" }
  ]
};

// ../protocol/src/features/painting/index.ts
var feature6 = {
  id: "painting",
  capabilities: [
    { stage: "P0", order: 15, id: "paint.brush" },
    { stage: "P0", order: 16, id: "paint.eraser" },
    { stage: "P1a", order: 0, id: "brush.presets" },
    { stage: "P1a", order: 1, id: "brush.tip-shape" },
    { stage: "P1a", order: 2, id: "brush.dynamics.basic" },
    { stage: "P1a", order: 3, id: "brush.pressure" },
    { stage: "P1a", order: 4, id: "brush.smoothing" },
    { stage: "P1b", order: 0, id: "brush.external-abr" },
    { stage: "P1b", order: 1, id: "brush.tip-sampled" },
    { stage: "P1b", order: 2, id: "brush.dynamics.shape" },
    { stage: "P1b", order: 3, id: "brush.dynamics.scatter" },
    { stage: "P1b", order: 4, id: "brush.dynamics.texture" },
    { stage: "P1b", order: 5, id: "brush.dynamics.color" },
    { stage: "P1b", order: 6, id: "brush.dynamics.transfer" },
    { stage: "P1b", order: 7, id: "brush.paint-blend-modes" },
    { stage: "P1b", order: 8, id: "paint.pencil" },
    { stage: "P1b", order: 9, id: "paint.color-replacement" },
    { stage: "P1b", order: 10, id: "paint.gradient" },
    { stage: "P1b", order: 11, id: "paint.bucket" },
    { stage: "P1b", order: 12, id: "paint.magic-eraser" },
    { stage: "P1b", order: 13, id: "paint.background-eraser" },
    { stage: "P1b", order: 14, id: "paint.symmetry" },
    { stage: "P1b", order: 15, id: "paint.eyedropper" },
    { stage: "P1b", order: 16, id: "paint.swatches" },
    { stage: "P1b", order: 17, id: "paint.gradient-presets" },
    { stage: "P1b", order: 18, id: "paint.tool-presets" }
  ]
};

// ../protocol/src/features/retouch/index.ts
var feature7 = {
  id: "retouch",
  capabilities: [
    { stage: "P6", order: 0, id: "tool.clone" },
    { stage: "P6", order: 1, id: "tool.healing" },
    { stage: "P6", order: 2, id: "tool.retouch-brush" },
    // U37：区域命令与移除。
    { stage: "P6", order: 40, id: "retouch.patch" },
    { stage: "P6", order: 41, id: "retouch.content-aware-move" },
    { stage: "P6", order: 42, id: "retouch.remove" },
    { stage: "P6", order: 43, id: "retouch.red-eye" },
    // U38：图案图章与历史画笔。
    { stage: "P6", order: 44, id: "retouch.pattern-stamp" },
    { stage: "P6", order: 45, id: "retouch.history-brush" },
    // U39：逐工具参数与多仿制源。
    { stage: "P6", order: 46, id: "retouch.tool-options" },
    { stage: "P6", order: 47, id: "retouch.clone-sources" }
  ]
};

// ../protocol/src/features/adjustments/index.ts
var feature8 = {
  id: "adjustments",
  capabilities: [
    { stage: "P0", order: 18, id: "adjust.brightness-contrast" },
    { stage: "P0", order: 19, id: "adjust.hue-saturation" },
    { stage: "P0", order: 20, id: "adjust.curves" },
    { stage: "P5", order: 0, id: "adjust.levels" },
    { stage: "P5", order: 1, id: "adjust.channel-curves" },
    { stage: "P5", order: 2, id: "adjust.vibrance" },
    { stage: "P5", order: 3, id: "adjust.black-white" },
    { stage: "P5", order: 4, id: "analysis.histogram" },
    // U41/U42 的高级持久选项（输出端点、铅笔/平滑、六色域、Tint）。
    { stage: "P5", order: 10, id: "adjust.levels-output" },
    { stage: "P5", order: 11, id: "adjust.curve-pencil" },
    { stage: "P5", order: 12, id: "adjust.hue-ranges" },
    { stage: "P5", order: 13, id: "adjust.black-white-tint" },
    // U43：九类新增逐类调整（直接调整 + 调整层）。
    { stage: "P5", order: 14, id: "adjust.exposure" },
    { stage: "P5", order: 15, id: "adjust.color-balance" },
    { stage: "P5", order: 16, id: "adjust.photo-filter" },
    { stage: "P5", order: 17, id: "adjust.channel-mixer" },
    { stage: "P5", order: 18, id: "adjust.invert" },
    { stage: "P5", order: 19, id: "adjust.posterize" },
    { stage: "P5", order: 20, id: "adjust.threshold" },
    { stage: "P5", order: 21, id: "adjust.gradient-map" },
    { stage: "P5", order: 22, id: "adjust.selective-color" },
    // U44：自动校正与匹配/替换颜色。
    { stage: "P5", order: 23, id: "adjust.auto-tone" },
    { stage: "P5", order: 24, id: "adjust.auto-contrast" },
    { stage: "P5", order: 25, id: "adjust.auto-color" },
    { stage: "P5", order: 26, id: "adjust.desaturate" },
    { stage: "P5", order: 27, id: "adjust.equalize" },
    { stage: "P5", order: 28, id: "adjust.shadows-highlights" },
    { stage: "P5", order: 29, id: "adjust.replace-color" },
    { stage: "P5", order: 30, id: "adjust.match-color" }
  ]
};

// ../protocol/src/features/modes/index.ts
var feature9 = {
  id: "modes",
  capabilities: [
    { stage: "P7", order: 40, id: "image.modes" },
    { stage: "P7", order: 41, id: "image.color-table" },
    { stage: "P7", order: 42, id: "image.duotone" }
  ]
};

// ../protocol/src/features/filters/index.ts
var feature10 = {
  id: "filters",
  capabilities: [
    { stage: "P6", order: 3, id: "filter.blur-gaussian" },
    { stage: "P6", order: 4, id: "filter.sharpen-usm" }
  ]
};

// ../protocol/src/features/composition/index.ts
var feature11 = {
  id: "composition",
  capabilities: [
    { stage: "P0", order: 10, id: "compose.transform" },
    // U50–U56 的构图能力。`order` 在 P7 内使用本域专属区间（40–64），与各域共同贡献时排序稳定。
    { stage: "P7", order: 0, id: "image.crop" },
    { stage: "P7", order: 1, id: "image.image-size" },
    { stage: "P7", order: 2, id: "image.canvas-size" },
    { stage: "P7", order: 11, id: "image.perspective-crop" },
    { stage: "P7", order: 12, id: "image.trim" },
    { stage: "P7", order: 13, id: "image.reveal-all" },
    { stage: "P7", order: 14, id: "image.rotation.arbitrary" },
    { stage: "P7", order: 15, id: "transform.again" },
    { stage: "P7", order: 16, id: "transform.warp" },
    { stage: "P7", order: 17, id: "transform.warp-grid" },
    { stage: "P7", order: 18, id: "transform.perspective-warp" },
    { stage: "P7", order: 19, id: "transform.puppet-warp" },
    { stage: "P7", order: 20, id: "fill.arbitrary" },
    { stage: "P7", order: 21, id: "fill.content-aware" },
    { stage: "P7", order: 22, id: "fill.content-aware-scale" },
    { stage: "P7", order: 23, id: "fill.stroke" },
    { stage: "P7", order: 24, id: "edit.fade" },
    { stage: "P7", order: 25, id: "photo.auto-align" },
    { stage: "P7", order: 26, id: "photo.auto-blend" },
    { stage: "P7", order: 27, id: "photo.photomerge" },
    { stage: "P7", order: 28, id: "photo.merge-hdr" },
    { stage: "P7", order: 29, id: "photo.crop-and-straighten" },
    { stage: "P7", order: 30, id: "structure.artboard" },
    { stage: "P7", order: 31, id: "structure.frame" },
    { stage: "P7", order: 32, id: "structure.slice" }
  ]
};

// ../protocol/src/features/layers/index.ts
var feature12 = {
  id: "layers",
  capabilities: [
    { stage: "P0", order: 0, id: "layers.composite" },
    { stage: "P0", order: 1, id: "layers.fill-opacity" },
    { stage: "P0", order: 2, id: "layers.styles.resource-free" },
    { stage: "P0", order: 3, id: "layers.styles.patterns" },
    { stage: "P0", order: 4, id: "layers.groups" },
    { stage: "P0", order: 5, id: "layers.blend.pass-through" },
    { stage: "P0", order: 6, id: "layers.blend.photoshop" },
    { stage: "P0", order: 7, id: "layers.blend.normal" },
    { stage: "P0", order: 8, id: "layers.blend.multiply" },
    { stage: "P0", order: 9, id: "layers.blend.screen" },
    { stage: "P0", order: 21, id: "layers.fill" },
    { stage: "P0", order: 22, id: "layers.links-and-labels" },
    { stage: "P0", order: 23, id: "layers.stamp-and-background" },
    { stage: "P0", order: 24, id: "layers.paste-into-outside" },
    { stage: "P0", order: 25, id: "layers.advanced-blending" },
    { stage: "P0", order: 26, id: "layers.style-presets" },
    { stage: "P0", order: 27, id: "layers.matting" },
    { stage: "P0", order: 28, id: "layers.layer-comps" },
    { stage: "P2", order: 0, id: "edit.layer-transfer" },
    { stage: "P2", order: 1, id: "edit.workspace-clipboard" },
    { stage: "P2", order: 2, id: "edit.paste-in-place" },
    { stage: "P7", order: 5, id: "layer.filter-list" }
  ]
};

// ../protocol/src/features/smart/index.ts
var feature13 = {
  id: "smart",
  capabilities: [
    { stage: "P4", order: 0, id: "layer.smart-object" },
    { stage: "P4", order: 1, id: "layer.smart-object.child-document" },
    { stage: "P4", order: 2, id: "layer.smart-object.replace" },
    { stage: "P4", order: 3, id: "layer.smart-object.copy-independent" }
  ]
};

// ../protocol/src/features/type/index.ts
var feature14 = {
  id: "type",
  capabilities: [
    { stage: "P0", order: 17, id: "text.horizontal" },
    { stage: "P7", order: 6, id: "type.typography" }
  ]
};

// ../protocol/src/features/views/index.ts
var feature15 = {
  id: "views",
  capabilities: [
    { stage: "P7", order: 3, id: "view.guides" },
    { stage: "P7", order: 4, id: "view.grid-snap" },
    // 逐项工作流接通后开放（U71/U73）；`view.rotate-navigator` 仍关闭（旋转的像素呈现缺宿主端口）。
    { stage: "P7", order: 11, id: "view.guide-layout" },
    { stage: "P7", order: 12, id: "view.analysis" }
  ]
};

// ../protocol/src/features/customization/index.ts
var feature16 = {
  id: "customization",
  capabilities: []
};

// ../protocol/src/features/history/index.ts
var feature17 = {
  id: "history",
  capabilities: [
    { stage: "P7", order: 73, id: "history.snapshots" },
    { stage: "P7", order: 74, id: "history.new-from-state" },
    { stage: "P7", order: 75, id: "history.purge" },
    { stage: "P7", order: 76, id: "actions.recording" },
    { stage: "P7", order: 77, id: "actions.atn" },
    { stage: "P7", order: 78, id: "actions.shortcuts" },
    { stage: "P7", order: 79, id: "data.variables" },
    { stage: "P7", order: 80, id: "data.data-sets" },
    { stage: "P7", order: 81, id: "automation.batch" },
    { stage: "P7", order: 82, id: "automation.contact-sheet" },
    { stage: "P7", order: 83, id: "automation.load-stack" },
    { stage: "P7", order: 84, id: "automation.scripts" }
  ]
};

// ../protocol/src/features/animation/index.ts
var feature18 = {
  id: "animation",
  capabilities: [
    { stage: "P7", order: 11, id: "animation.timeline" },
    { stage: "P7", order: 12, id: "animation.video-layers" },
    { stage: "P7", order: 13, id: "animation.frame-import" },
    { stage: "P7", order: 14, id: "animation.frame-delivery" }
  ]
};

// ../protocol/src/features/index.ts
var PROTOCOL_FEATURES = [feature2, feature3, feature, feature4, feature5, feature6, feature7, feature8, feature9, feature10, feature11, feature12, feature13, feature14, feature15, feature16, feature17, feature18];
function featureCapabilitiesForStage(stage) {
  return PROTOCOL_FEATURES.flatMap((feature19) => [...feature19.capabilities]).filter((entry) => entry.stage === stage).sort((a, b) => a.order - b.order).map((entry) => entry.id);
}

// ../protocol/src/image-project-editor.ts
var PHOTOCRAFT_STAGES = ["P0", "P1a", "P1b", "P2", "P3", "P4", "P5", "P6", "P7"];
var PHOTOCRAFT_DELIVERED_STAGES = ["P0", "P1a", "P1b", "P2", "P3", "P4", "P5", "P6", "P7"];
var PHOTOCRAFT_STAGE_CAPABILITIES = {
  P0: featureCapabilitiesForStage("P0"),
  P1a: featureCapabilitiesForStage("P1a"),
  P1b: featureCapabilitiesForStage("P1b"),
  P2: featureCapabilitiesForStage("P2"),
  P3: featureCapabilitiesForStage("P3"),
  P4: featureCapabilitiesForStage("P4"),
  P5: featureCapabilitiesForStage("P5"),
  P6: featureCapabilitiesForStage("P6"),
  P7: featureCapabilitiesForStage("P7")
};
var PHOTOCRAFT_CAPABILITIES = PHOTOCRAFT_DELIVERED_STAGES.flatMap(
  (stage) => PHOTOCRAFT_STAGE_CAPABILITIES[stage]
);
var PHOTOCRAFT_NON_GOALS = [
  "format.psb",
  "filter.liquify",
  "selection.ai-subject",
  "selection.hair-refine",
  "adjust.lut",
  "color.icc",
  "color.cmyk",
  "color.hdr",
  "type.path",
  "type.vertical",
  "brush.dual",
  "brush.wet-edges",
  "brush.mixer",
  "layer.smart-filter",
  "file.smart-object.linked",
  "print",
  "plugin",
  "automation.mcp",
  "batch.background",
  "file.open-external",
  "file.export-local"
];
var PHOTOCRAFT_UNDELIVERED_CAPABILITIES = PHOTOCRAFT_STAGES.filter(
  (stage) => !PHOTOCRAFT_DELIVERED_STAGES.includes(stage)
).flatMap((stage) => PHOTOCRAFT_STAGE_CAPABILITIES[stage]);
var CAPABILITY_SET = new Set(PHOTOCRAFT_CAPABILITIES);
var NON_GOAL_SET = new Set(PHOTOCRAFT_NON_GOALS);
var STAGE_OF = /* @__PURE__ */ new Map();
for (const stage of PHOTOCRAFT_STAGES) {
  for (const id2 of PHOTOCRAFT_STAGE_CAPABILITIES[stage]) STAGE_OF.set(id2, stage);
}

// ../protocol/src/features/painting/workflow.ts
var MAX_TOOL_PRESET_OPTIONS_BYTES = 64 * 1024;

// ../project-verifier/src/project-verification.ts
var ProjectVerificationError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ProjectVerificationError";
    this.code = code;
  }
};
var ZIP_LOCAL_SIG = 67324752;
var ZIP_CENTRAL_SIG = 33639248;
var ZIP_EOCD_SIG = 101010256;
var EOCD_MIN_BYTES = 22;
var MAX_COMMENT_BYTES = 65535;
var ALLOWED_OBJECT_KINDS = /* @__PURE__ */ new Set(["raster", "adjustment", "text", "group", "fill"]);
var ALLOWED_ADJUSTMENT_VARIANTS = /* @__PURE__ */ new Set([
  "BrightnessContrast",
  "HueSaturation",
  "Curves",
  "Levels",
  "Vibrance",
  "BlackWhite",
  "Exposure",
  "ColorBalance",
  "PhotoFilter",
  "ChannelMixer",
  "Invert",
  "Posterize",
  "Threshold",
  "GradientMap",
  "SelectiveColor"
]);
var REJECTED_OBJECT_KINDS = /* @__PURE__ */ new Set(["smart", "shape"]);
var ANIMATION_MAX_FRAMES = 120;
var ANIMATION_MAX_CUMULATIVE_FRAME_PIXELS = 16777216;
var ANIMATION_MAX_FPS = 1e3;
var ANIMATION_MAX_FRAME_TILES = 4096;
var ANIMATION_MAX_TILE_INDEX = 8388608;
var TILE_SIZE = 256;
function verifyPhotocraftProject(bytes, options = {}) {
  return inspectProject(bytes, options, false);
}
function inspectEmbeddedPhotocraftProject(bytes, options = {}) {
  return inspectProject(bytes, options, true);
}
function inspectProject(bytes, options, embeddedSmart) {
  const maxCompressed = Math.min(options.maxBytes ?? IMAGE_PROJECT_LIMITS2.maxProjectBytes, IMAGE_PROJECT_LIMITS2.maxProjectBytes);
  if (bytes.byteLength === 0) throw new ProjectVerificationError("not-a-zip", "\u5DE5\u7A0B\u5185\u5BB9\u4E3A\u7A7A");
  if (bytes.byteLength > maxCompressed) {
    throw new ProjectVerificationError("compressed-too-large", `\u5DE5\u7A0B\u538B\u7F29\u5B57\u8282\u8D85\u8FC7\u4E0A\u9650\uFF1A${bytes.byteLength} > ${maxCompressed}`);
  }
  const entries = readCentralDirectory(bytes);
  if (entries.length > IMAGE_PROJECT_LIMITS2.maxEntries) {
    throw new ProjectVerificationError("too-many-entries", `\u5DE5\u7A0B\u6761\u76EE\u8D85\u8FC7 ${IMAGE_PROJECT_LIMITS2.maxEntries}`);
  }
  const byName = /* @__PURE__ */ new Map();
  let declaredTotal = 0;
  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    if (byName.has(entry.name)) continue;
    byName.set(entry.name, entry);
    if (entry.flags & 1) throw new ProjectVerificationError("encrypted-entry", `\u5DE5\u7A0B\u5305\u542B\u52A0\u5BC6\u6761\u76EE\uFF1A${entry.name}`);
    if (entry.compression !== 0 && entry.compression !== 8) {
      throw new ProjectVerificationError("unsupported-compression", `\u5DE5\u7A0B\u5305\u542B\u4E0D\u652F\u6301\u7684\u538B\u7F29\u65B9\u6CD5\uFF1A${entry.name}`);
    }
    if (entry.uncompressedSize > IMAGE_PROJECT_LIMITS2.maxEntryDecompressedBytes) {
      throw new ProjectVerificationError("entry-too-large", `\u5DE5\u7A0B\u5355\u6761\u76EE\u89E3\u538B\u540E\u8D85\u8FC7\u4E0A\u9650\uFF1A${entry.name}`);
    }
    declaredTotal += entry.uncompressedSize;
  }
  if (declaredTotal > IMAGE_PROJECT_LIMITS2.maxDecompressedResourceBytes) {
    throw new ProjectVerificationError(
      "decompressed-too-large",
      `\u5DE5\u7A0B\u89E3\u538B\u540E\u8D44\u6E90\u5B57\u8282\u8D85\u8FC7\u4E0A\u9650\uFF1A${declaredTotal} > ${IMAGE_PROJECT_LIMITS2.maxDecompressedResourceBytes}`
    );
  }
  const manifestEntry = byName.get("manifest.json");
  if (!manifestEntry) throw new ProjectVerificationError("missing-manifest", "\u5DE5\u7A0B\u7F3A\u5C11 manifest.json");
  const manifestBytes = readEntry(bytes, manifestEntry, {
    maxBytes: IMAGE_PROJECT_LIMITS2.maxEntryDecompressedBytes
  });
  const manifest = parseManifest(manifestBytes);
  const summary = inspectManifest(manifest, embeddedSmart);
  assertResourcesPresent(byName, manifest);
  return {
    ...summary,
    entryCount: entries.length,
    decompressedBytes: declaredTotal
  };
}
function assertSafeEntryName(name) {
  if (name.length === 0 || name.length > 1024) throw new ProjectVerificationError("corrupt-container", "\u5DE5\u7A0B\u6761\u76EE\u540D\u975E\u6CD5");
  if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) {
    throw new ProjectVerificationError("path-traversal", `\u5DE5\u7A0B\u6761\u76EE\u4F7F\u7528\u7EDD\u5BF9\u8DEF\u5F84\uFF1A${name}`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new ProjectVerificationError("path-traversal", `\u5DE5\u7A0B\u6761\u76EE\u5305\u542B\u8DEF\u5F84\u7A7F\u8D8A\uFF1A${name}`);
  }
  if (name.includes("\\")) throw new ProjectVerificationError("path-traversal", `\u5DE5\u7A0B\u6761\u76EE\u5305\u542B\u53CD\u659C\u6760\u8DEF\u5F84\uFF1A${name}`);
}
function readCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.byteLength - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  let eocd = -1;
  for (let offset = bytes.byteLength - EOCD_MIN_BYTES; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIG) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ProjectVerificationError("not-a-zip", "\u5DE5\u7A0B\u4E0D\u662F\u5408\u6CD5\u7684 ZIP \u5BB9\u5668");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const centralSize = view.getUint32(eocd + 12, true);
  if (entryCount === 65535 || centralOffset === 4294967295) {
    throw new ProjectVerificationError("corrupt-container", "\u4E0D\u652F\u6301 ZIP64 \u5DE5\u7A0B");
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    throw new ProjectVerificationError("corrupt-container", "\u5DE5\u7A0B\u4E2D\u592E\u76EE\u5F55\u8D8A\u754C");
  }
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.byteLength) throw new ProjectVerificationError("corrupt-container", "\u5DE5\u7A0B\u4E2D\u592E\u76EE\u5F55\u88AB\u622A\u65AD");
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_SIG) {
      throw new ProjectVerificationError("corrupt-container", "\u5DE5\u7A0B\u4E2D\u592E\u76EE\u5F55\u6761\u76EE\u7B7E\u540D\u975E\u6CD5");
    }
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    if (nameLength === 0 || nameLength > 1024) {
      throw new ProjectVerificationError("corrupt-container", "\u5DE5\u7A0B\u6761\u76EE\u540D\u957F\u5EA6\u975E\u6CD5");
    }
    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.byteLength) {
      throw new ProjectVerificationError("corrupt-container", "\u5DE5\u7A0B\u6761\u76EE\u540D\u8D8A\u754C");
    }
    const name = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.push({ name, compression, compressedSize, uncompressedSize, flags, localHeaderOffset });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}
function readEntry(bytes, entry, options) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.byteLength) throw new ProjectVerificationError("corrupt-container", "\u5DE5\u7A0B\u6761\u76EE\u672C\u5730\u5934\u8D8A\u754C");
  if (view.getUint32(offset, true) !== ZIP_LOCAL_SIG) {
    throw new ProjectVerificationError("corrupt-container", "\u5DE5\u7A0B\u6761\u76EE\u672C\u5730\u5934\u7B7E\u540D\u975E\u6CD5");
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) throw new ProjectVerificationError("corrupt-container", "\u5DE5\u7A0B\u6761\u76EE\u6570\u636E\u8D8A\u754C");
  const raw = bytes.subarray(dataStart, dataEnd);
  let out;
  if (entry.compression === 0) {
    out = raw;
  } else {
    try {
      out = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.min(options.maxBytes, IMAGE_PROJECT_LIMITS2.maxEntryDecompressedBytes) }));
    } catch {
      throw new ProjectVerificationError("corrupt-container", `\u5DE5\u7A0B\u6761\u76EE\u89E3\u538B\u5931\u8D25\uFF1A${entry.name}`);
    }
  }
  if (out.byteLength > options.maxBytes) {
    throw new ProjectVerificationError("entry-too-large", `\u5DE5\u7A0B\u6761\u76EE\u89E3\u538B\u540E\u8D85\u8FC7\u4E0A\u9650\uFF1A${entry.name}`);
  }
  if (entry.uncompressedSize !== 0 && out.byteLength !== entry.uncompressedSize) {
    throw new ProjectVerificationError("corrupt-container", `\u5DE5\u7A0B\u6761\u76EE\u58F0\u660E\u957F\u5EA6\u4E0E\u5B9E\u9645\u4E0D\u7B26\uFF1A${entry.name}`);
  }
  return out;
}
function parseManifest(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B manifest.json \u4E0D\u662F\u5408\u6CD5 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B manifest.json \u7ED3\u6784\u975E\u6CD5");
  }
  return parsed;
}
function inspectManifest(manifest, embeddedSmart = false) {
  const formatVersion = manifest.format_version;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u7F3A\u5C11\u5408\u6CD5 format_version");
  }
  if (!SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS.includes(formatVersion)) {
    throw new ProjectVerificationError("unsupported-format-version", `\u5DE5\u7A0B\u683C\u5F0F\u7248\u672C\u4E0D\u53D7\u652F\u6301\uFF1A${formatVersion}`);
  }
  const generator = typeof manifest.generator === "string" ? manifest.generator.slice(0, 200) : "";
  const document = manifest.document;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u7F3A\u5C11 document");
  }
  const doc = document;
  if (!isSupportedImageProjectPatterns(doc.patterns)) throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u56FE\u6848\u8D44\u6E90\u8D85\u9650\u6216\u683C\u5F0F\u4E0D\u53D7\u652F\u6301");
  const size = doc.size;
  if (typeof size !== "object" || size === null) throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u7F3A\u5C11\u753B\u5E03\u5C3A\u5BF8");
  const width = readDimension(size.width);
  const height = readDimension(size.height);
  if (width === null || height === null) throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u753B\u5E03\u5C3A\u5BF8\u975E\u6CD5");
  if (width > IMAGE_PROJECT_LIMITS2.maxCanvasSide || height > IMAGE_PROJECT_LIMITS2.maxCanvasSide) {
    throw new ProjectVerificationError("canvas-too-large", `\u5DE5\u7A0B\u753B\u5E03\u5355\u8FB9\u8D85\u8FC7\u4E0A\u9650\uFF1A${width}x${height}`);
  }
  if (width * height > IMAGE_PROJECT_LIMITS2.maxCanvasPixels) {
    throw new ProjectVerificationError("canvas-too-large", `\u5DE5\u7A0B\u753B\u5E03\u50CF\u7D20\u8D85\u8FC7\u4E0A\u9650\uFF1A${width}x${height}`);
  }
  const layers = doc.layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u7F3A\u5C11\u56FE\u5C42");
  }
  const objectKinds = /* @__PURE__ */ new Set();
  const counters = { count: 0, depth: 0 };
  inspectLayers(layers, 1, counters, objectKinds, doc.patterns ?? [], embeddedSmart);
  inspectTimeline(doc.timeline);
  if (counters.count > IMAGE_PROJECT_LIMITS2.maxLayers) {
    throw new ProjectVerificationError("too-many-layers", `\u5DE5\u7A0B\u5C42\u6570\u8D85\u8FC7\u4E0A\u9650\uFF1A${counters.count} > ${IMAGE_PROJECT_LIMITS2.maxLayers}`);
  }
  if (counters.depth > IMAGE_PROJECT_LIMITS2.maxDocumentDepth) {
    throw new ProjectVerificationError("too-deep", `\u5DE5\u7A0B\u6587\u6863\u5C42\u7EA7\u8D85\u8FC7\u4E0A\u9650\uFF1A${counters.depth} > ${IMAGE_PROJECT_LIMITS2.maxDocumentDepth}`);
  }
  return {
    formatVersion,
    generator,
    canvasWidth: width,
    canvasHeight: height,
    layerCount: counters.count,
    depth: counters.depth,
    objectKinds: [...objectKinds].sort()
  };
}
function readDimension(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}
function inspectLayers(layers, depth, counters, objectKinds, patterns, embeddedSmart = false) {
  if (depth > IMAGE_PROJECT_LIMITS2.maxDocumentDepth) {
    throw new ProjectVerificationError("too-deep", "\u5DE5\u7A0B\u6587\u6863\u5C42\u7EA7\u8D85\u8FC7\u4E0A\u9650");
  }
  counters.depth = Math.max(counters.depth, depth);
  for (const raw of layers) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u56FE\u5C42\u7ED3\u6784\u975E\u6CD5");
    }
    const layer = raw;
    counters.count += 1;
    if (counters.count > IMAGE_PROJECT_LIMITS2.maxLayers) {
      throw new ProjectVerificationError("too-many-layers", `\u5DE5\u7A0B\u5C42\u6570\u8D85\u8FC7\u4E0A\u9650\uFF1A${IMAGE_PROJECT_LIMITS2.maxLayers}`);
    }
    if (layer.fill_opacity !== void 0 && (typeof layer.fill_opacity !== "number" || !Number.isFinite(layer.fill_opacity) || layer.fill_opacity < 0 || layer.fill_opacity > 1)) {
      throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u586B\u5145\u4E0D\u900F\u660E\u5EA6\u65E0\u6548");
    }
    if (layer.effects !== void 0 && !isSupportedImageProjectEffects(layer.effects, patterns)) {
      throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u5305\u542B\u672A\u5F00\u653E\u6216\u8D85\u9650\u7684\u56FE\u5C42\u6837\u5F0F");
    }
    const content = layer.content;
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u56FE\u5C42\u7F3A\u5C11\u5185\u5BB9");
    }
    const kind = content.kind;
    if (typeof kind !== "string") throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u56FE\u5C42\u7F3A\u5C11\u5185\u5BB9\u7C7B\u578B");
    const video = layer.video;
    if (layer.blend !== void 0) {
      const blend = typeof layer.blend === "string" ? layer.blend.replace(/-/g, "").toLowerCase() : "";
      if (!IMAGE_PROJECT_BLEND_MODES.some((mode) => mode.replace(/-/g, "") === blend) || blend === "passthrough" && kind !== "group") {
        throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u5305\u542B\u672A\u5F00\u653E\u7684\u6DF7\u5408\u6A21\u5F0F");
      }
    }
    if (!(embeddedSmart && kind === "smart") && (REJECTED_OBJECT_KINDS.has(kind) || !ALLOWED_OBJECT_KINDS.has(kind))) {
      throw new ProjectVerificationError("unsupported-object", `\u5DE5\u7A0B\u5305\u542B\u9996\u671F\u672A\u5F00\u653E\u7684\u5BF9\u8C61\u7C7B\u578B\uFF1A${kind}`);
    }
    if (video === void 0 || video === null) {
      objectKinds.add(kind);
    } else if (typeof video !== "object" || Array.isArray(video)) {
      throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u89C6\u9891\u56FE\u5C42\u7ED3\u6784\u975E\u6CD5");
    } else {
      inspectVideo(video);
      objectKinds.add("video-layer");
    }
    if (kind === "smart") inspectSmart(content);
    if (kind === "adjustment") inspectAdjustment(content);
    if (kind === "fill") inspectFill(content, patterns);
    if (kind === "raster") inspectRasterSources(content);
    if (kind === "group") {
      const group = content;
      if (group.artboard != null) {
        throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u5305\u542B\u753B\u677F");
      }
      if (!Array.isArray(group.children) || typeof group.expanded !== "boolean") {
        throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u5206\u7EC4\u7ED3\u6784\u975E\u6CD5");
      }
      if (group.children.length > 0) inspectLayers(group.children, depth + 1, counters, objectKinds, patterns, embeddedSmart);
    }
    if (layer.smart_filters !== void 0 || kind !== "smart" && content.smart_filters !== void 0) {
      throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u5305\u542B\u667A\u80FD\u6EE4\u955C");
    }
    if (Array.isArray(layer.vector_mask) && layer.vector_mask.length > 0) {
      throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u5305\u542B\u77E2\u91CF\u8DEF\u5F84");
    }
  }
}
function inspectVideo(video) {
  const frames = video.frames;
  const original = video.original_frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new ProjectVerificationError("unsupported-object", "\u89C6\u9891\u56FE\u5C42\u7684\u5E27\u6808\u4E3A\u7A7A");
  }
  if (frames.length > ANIMATION_MAX_FRAMES) {
    throw new ProjectVerificationError("unsupported-object", `\u89C6\u9891\u56FE\u5C42\u5E27\u6570\u8D85\u8FC7\u4E0A\u9650\uFF1A${frames.length} > ${ANIMATION_MAX_FRAMES}`);
  }
  if (typeof video.fps !== "number" || !Number.isFinite(video.fps) || video.fps <= 0 || video.fps > ANIMATION_MAX_FPS) {
    throw new ProjectVerificationError("unsupported-object", `\u89C6\u9891\u56FE\u5C42\u5E27\u7387\u975E\u6CD5\uFF1A${String(video.fps)}`);
  }
  if (video.show_altered !== void 0 && typeof video.show_altered !== "boolean") {
    throw new ProjectVerificationError("invalid-manifest", "\u89C6\u9891\u56FE\u5C42\u663E\u793A\u5F00\u5173\u975E\u6CD5");
  }
  const source = video.source;
  if (source !== void 0 && source !== null && typeof source !== "string" && (typeof source !== "object" || Array.isArray(source))) {
    throw new ProjectVerificationError("invalid-manifest", "\u89C6\u9891\u56FE\u5C42\u6765\u6E90\u7ED3\u6784\u975E\u6CD5");
  }
  if (original !== void 0 && original !== null) {
    if (!Array.isArray(original) || original.length !== frames.length) {
      throw new ProjectVerificationError("unsupported-object", "\u89C6\u9891\u56FE\u5C42\u539F\u59CB\u5E27\u6570\u4E0E\u5E27\u6808\u4E0D\u4E00\u81F4");
    }
  }
  let pixels = 0;
  for (const frame of [...frames, ...Array.isArray(original) ? original : []]) {
    pixels += surfacePixels(frame);
    if (pixels > ANIMATION_MAX_CUMULATIVE_FRAME_PIXELS) {
      throw new ProjectVerificationError("unsupported-object", `\u89C6\u9891\u5E27\u7D2F\u8BA1\u50CF\u7D20\u8D85\u8FC7\u4E0A\u9650\uFF1A${pixels} > ${ANIMATION_MAX_CUMULATIVE_FRAME_PIXELS}`);
    }
  }
}
function surfacePixels(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectVerificationError("invalid-manifest", "\u89C6\u9891\u5E27\u7ED3\u6784\u975E\u6CD5");
  }
  const surface = raw;
  const tiles = surface.tiles;
  if (!Array.isArray(tiles)) throw new ProjectVerificationError("invalid-manifest", "\u89C6\u9891\u5E27\u7F3A\u5C11 tile \u5217\u8868");
  if (tiles.length > ANIMATION_MAX_FRAME_TILES) {
    throw new ProjectVerificationError("unsupported-object", `\u89C6\u9891\u5E27 tile \u6570\u8D85\u8FC7\u4E0A\u9650\uFF1A${tiles.length}`);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const tile of tiles) {
    if (typeof tile !== "object" || tile === null) throw new ProjectVerificationError("invalid-manifest", "\u89C6\u9891\u5E27 tile \u7ED3\u6784\u975E\u6CD5");
    const { tx, ty } = tile;
    if (typeof tx !== "number" || typeof ty !== "number" || !Number.isInteger(tx) || !Number.isInteger(ty) || Math.abs(tx) > ANIMATION_MAX_TILE_INDEX || Math.abs(ty) > ANIMATION_MAX_TILE_INDEX) {
      throw new ProjectVerificationError("unsupported-object", "\u89C6\u9891\u5E27 tile \u5750\u6807\u975E\u6CD5");
    }
    x0 = Math.min(x0, tx * TILE_SIZE);
    y0 = Math.min(y0, ty * TILE_SIZE);
    x1 = Math.max(x1, tx * TILE_SIZE + TILE_SIZE);
    y1 = Math.max(y1, ty * TILE_SIZE + TILE_SIZE);
  }
  if (!Number.isFinite(x0)) return 0;
  return (x1 - x0) * (y1 - y0);
}
function inspectTimeline(raw) {
  if (raw === void 0 || raw === null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u65F6\u95F4\u8F74\u7ED3\u6784\u975E\u6CD5");
  }
  const timeline = raw;
  const duration = timeline.duration;
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 1 || duration > ANIMATION_MAX_FRAMES) {
    throw new ProjectVerificationError("unsupported-object", `\u65F6\u95F4\u8F74\u65F6\u957F\u8D85\u8FC7\u4E0A\u9650\u6216\u975E\u6CD5\uFF1A${String(duration)}\uFF08\u4E0A\u9650 ${ANIMATION_MAX_FRAMES}\uFF09`);
  }
  if (typeof timeline.fps !== "number" || !Number.isFinite(timeline.fps) || timeline.fps <= 0 || timeline.fps > ANIMATION_MAX_FPS) {
    throw new ProjectVerificationError("unsupported-object", `\u65F6\u95F4\u8F74\u5E27\u7387\u975E\u6CD5\uFF1A${String(timeline.fps)}`);
  }
  const current = timeline.current;
  if (typeof current !== "number" || !Number.isInteger(current) || current < 0 || current >= duration) {
    throw new ProjectVerificationError("unsupported-object", `\u65F6\u95F4\u8F74\u64AD\u653E\u5934\u8D8A\u754C\uFF1A${String(current)} >= ${duration}`);
  }
  const workStart = timeline.work_start ?? 0;
  const workEnd = timeline.work_end;
  if (typeof workStart !== "number" || !Number.isInteger(workStart) || typeof workEnd !== "number" || !Number.isInteger(workEnd) || workStart >= workEnd || workEnd > duration) {
    throw new ProjectVerificationError("unsupported-object", `\u65F6\u95F4\u8F74\u5DE5\u4F5C\u533A\u8303\u56F4\u975E\u6CD5\uFF1A${String(workStart)}..${String(workEnd)}\uFF08\u65F6\u957F ${duration}\uFF09`);
  }
}
function inspectSmart(content) {
  const source = content.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new ProjectVerificationError("invalid-manifest", "\u667A\u80FD\u5BF9\u8C61\u7F3A\u5C11\u6E90");
  const value = source;
  if (value.kind !== "embedded") throw new ProjectVerificationError("external-reference", "\u667A\u80FD\u5BF9\u8C61\u53EA\u5141\u8BB8\u5D4C\u5165\u539F\u751F\u6E90");
  if (typeof value.file_name !== "string" || value.file_name.length > 200 || !value.file_name.trim() || /[\\/:\u0000-\u001f\u007f-\u009f]/.test(value.file_name) || !/^.+\.pcraft$/i.test(value.file_name) || !value.file_name.slice(0, -7).trim() || typeof value.blob !== "string" || !/^[0-9a-f]{64}$/.test(value.blob)) {
    throw new ProjectVerificationError("invalid-manifest", "\u667A\u80FD\u5BF9\u8C61\u6E90\u540D\u6216\u8D44\u6E90\u5F15\u7528\u975E\u6CD5");
  }
  const transform = content.transform;
  const matrix = transform && typeof transform === "object" && !Array.isArray(transform) ? transform.m : null;
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every((n) => typeof n === "number" && Number.isFinite(n))) throw new ProjectVerificationError("unsupported-object", "\u667A\u80FD\u5BF9\u8C61\u4EFF\u5C04\u975E\u6CD5");
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12 || !Array.isArray(content.smart_filters) || content.smart_filters.length !== 0 || ["psd_raw", "filter_mask", "warp", "stack_mode", "perspective"].some((key) => content[key] != null) || content.filters_enabled !== void 0 && typeof content.filters_enabled !== "boolean") {
    throw new ProjectVerificationError("unsupported-object", "\u667A\u80FD\u5BF9\u8C61\u5305\u542B\u672A\u5F00\u653E\u53C2\u6570\u6216\u4E0D\u53EF\u9006\u4EFF\u5C04");
  }
}
function inspectAdjustment(content) {
  const adjustment = content.adjustment;
  if (adjustment === null || adjustment === void 0) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u8C03\u6574\u5C42\u7F3A\u5C11\u53C2\u6570");
  }
  const variant = typeof adjustment === "string" ? adjustment : typeof adjustment === "object" && !Array.isArray(adjustment) ? Object.keys(adjustment)[0] : void 0;
  if (typeof variant !== "string" || variant.length === 0 || !ALLOWED_ADJUSTMENT_VARIANTS.has(variant)) {
    throw new ProjectVerificationError("unsupported-object", `\u5DE5\u7A0B\u5305\u542B\u672A\u5F00\u653E\u7684\u8C03\u6574\u7C7B\u578B\uFF1A${String(variant ?? adjustment)}`);
  }
  if (typeof adjustment === "object" && Object.keys(adjustment).length !== 1) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u8C03\u6574\u5C42\u53C2\u6570\u7ED3\u6784\u975E\u6CD5");
  }
  const payload = typeof adjustment === "object" ? adjustment[variant] : null;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && (payload.psd_key !== void 0 || payload.raw !== void 0)) {
    throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u5305\u542B\u65E0\u6CD5\u6C42\u503C\u7684\u8C03\u6574\u5C42");
  }
}
function inspectFill(content, patterns) {
  const fill = content.fill;
  if (typeof fill !== "object" || fill === null || Array.isArray(fill)) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u586B\u5145\u5C42\u7F3A\u5C11\u53C2\u6570");
  }
  const record = fill;
  if (record.kind === "Solid") {
    inspectFillColor(record.alpha);
    return;
  }
  if (record.kind === "Gradient") {
    const stops = record.stops;
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > 1024) {
      throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u6E10\u53D8\u586B\u5145\u7684\u7AEF\u70B9\u6570\u91CF\u975E\u6CD5");
    }
    let previous = Number.NEGATIVE_INFINITY;
    for (const raw of stops) {
      if (!Array.isArray(raw) || raw.length !== 2) throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u6E10\u53D8\u7AEF\u70B9\u7ED3\u6784\u975E\u6CD5");
      const at = raw[0];
      if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at > 1 || at < previous) {
        throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u6E10\u53D8\u7AEF\u70B9\u4F4D\u7F6E\u975E\u6CD5\u6216\u6B21\u5E8F\u98A0\u5012");
      }
      previous = at;
      inspectFillColorValue(raw[1]);
    }
    const scale2 = record.scale;
    if (typeof scale2 !== "number" || !Number.isFinite(scale2) || scale2 < 0.1 || scale2 > 1.5) {
      throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u6E10\u53D8\u586B\u5145\u7684\u7F29\u653E\u8D85\u51FA\u8303\u56F4");
    }
    const midpoints = record.midpoints;
    if (midpoints !== void 0) {
      if (!Array.isArray(midpoints) || midpoints.length >= Math.max(stops.length, 1)) {
        throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u6E10\u53D8\u586B\u5145\u7684\u4E2D\u70B9\u6570\u91CF\u975E\u6CD5");
      }
      if (!midpoints.every((mid) => typeof mid === "number" && Number.isFinite(mid) && mid >= 0 && mid <= 1)) {
        throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u6E10\u53D8\u586B\u5145\u7684\u4E2D\u70B9\u8D85\u51FA\u8303\u56F4");
      }
    }
    const opacityStops = record.opacity_stops;
    if (opacityStops !== void 0) {
      if (!Array.isArray(opacityStops) || opacityStops.length > 1024) {
        throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u6E10\u53D8\u586B\u5145\u7684\u900F\u660E\u5EA6\u7AEF\u70B9\u6570\u91CF\u975E\u6CD5");
      }
      for (const raw of opacityStops) {
        if (!Array.isArray(raw) || raw.length !== 2) throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u6E10\u53D8\u900F\u660E\u5EA6\u7AEF\u70B9\u7ED3\u6784\u975E\u6CD5");
        const [at, alpha] = raw;
        if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at > 1) {
          throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u6E10\u53D8\u900F\u660E\u5EA6\u7AEF\u70B9\u4F4D\u7F6E\u975E\u6CD5");
        }
        if (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
          throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u6E10\u53D8\u900F\u660E\u5EA6\u7AEF\u70B9\u53D6\u503C\u975E\u6CD5");
        }
      }
    }
    return;
  }
  if (record.kind !== "Pattern") {
    throw new ProjectVerificationError("unsupported-object", `\u5DE5\u7A0B\u5305\u542B\u672A\u5F00\u653E\u7684\u5BF9\u8C61\u7C7B\u578B\uFF1Afill/${String(record.kind)}`);
  }
  const name = record.name;
  const id2 = record.id;
  if (typeof name !== "string" || !name.trim() || name.length > 200) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u56FE\u6848\u586B\u5145\u7684\u540D\u79F0\u975E\u6CD5");
  }
  if (typeof id2 !== "string" || !id2 || id2.length > 200) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u56FE\u6848\u586B\u5145\u7F3A\u5C11\u56FE\u6848\u5F15\u7528");
  }
  if (!patterns.some((raw) => typeof raw === "object" && raw !== null && raw.id === id2)) {
    throw new ProjectVerificationError("missing-resource", `\u5DE5\u7A0B\u56FE\u6848\u586B\u5145\u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u56FE\u6848\uFF1A${id2}`);
  }
  const scale = record.scale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 10) {
    throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u56FE\u6848\u586B\u5145\u7684\u7F29\u653E\u8D85\u51FA\u8303\u56F4");
  }
  const angle = record.angle;
  if (angle !== void 0 && (typeof angle !== "number" || !Number.isFinite(angle) || angle < -360 || angle > 360)) {
    throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u56FE\u6848\u586B\u5145\u7684\u89D2\u5EA6\u8D85\u51FA\u8303\u56F4");
  }
}
function inspectFillColor(alpha) {
  if (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u586B\u5145\u989C\u8272\u900F\u660E\u5EA6\u975E\u6CD5");
  }
}
function inspectFillColorValue(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u6E10\u53D8\u7AEF\u70B9\u7F3A\u5C11\u989C\u8272");
  }
  const color = raw;
  const channels = color.c;
  if (channels !== void 0) {
    if (!Array.isArray(channels) || !channels.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new ProjectVerificationError("unsupported-object", "\u5DE5\u7A0B\u6E10\u53D8\u7AEF\u70B9\u989C\u8272\u901A\u9053\u975E\u6CD5");
    }
  }
  inspectFillColor(color.alpha);
}
function inspectRasterSources(content) {
  const sources = content.sources ?? content.source;
  if (sources === void 0 || sources === null) return;
  const list = Array.isArray(sources) ? sources : [sources];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const source = raw;
    const kind = source.kind;
    if (kind === "linked") {
      throw new ProjectVerificationError("external-reference", "\u5DE5\u7A0B\u5305\u542B\u5916\u90E8\u6587\u4EF6\u94FE\u63A5");
    }
    if (typeof source.path === "string" && source.path.length > 0) {
      throw new ProjectVerificationError("external-reference", "\u5DE5\u7A0B\u5305\u542B\u5916\u90E8\u6587\u4EF6\u8DEF\u5F84");
    }
  }
}
function assertResourcesPresent(byName, manifest) {
  const hashes = /* @__PURE__ */ new Set();
  for (const name of byName.keys()) {
    const match = /^(?:tiles|blobs)\/([0-9a-f]{64})\.zst$/.exec(name);
    if (match) hashes.add(match[1]);
  }
  const referenced = /* @__PURE__ */ new Set();
  collectHashes(manifest, referenced);
  for (const hash of referenced) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new ProjectVerificationError("invalid-manifest", "\u5DE5\u7A0B\u5F15\u7528\u975E\u6CD5\u8D44\u6E90 hash");
    }
    if (!hashes.has(hash)) {
      throw new ProjectVerificationError("missing-resource", `\u5DE5\u7A0B\u7F3A\u5C11\u5FC5\u9700\u8D44\u6E90\uFF1A${hash}`);
    }
  }
}
function collectHashes(value, out, depth = 0) {
  if (depth > 64 || out.size > IMAGE_PROJECT_LIMITS2.maxEntries) return;
  if (typeof value === "string") {
    if (/^[0-9a-f]{64}$/.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectHashes(entry, out, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectHashes(entry, out, depth + 1);
  }
}

// ../project-verifier/src/native-project-verifier.ts
import { spawn } from "node:child_process";
var NativeVerifierError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "NativeVerifierError";
    this.code = code;
  }
};
var DEFAULT_TIMEOUT_MS = 5e3;
var DEFAULT_MAX_CONCURRENT = 2;
var DEFAULT_MAX_OUTPUT_BYTES2 = 1 << 20;
function createNativeProjectVerifier(options = null) {
  let config = null;
  if (options) {
    if (!options.binaryPath) {
      throw new NativeVerifierError("native-verifier-unavailable", "\u7F3A\u5C11\u539F\u751F\u6838\u9A8C\u5DE5\u5177\u8DEF\u5F84");
    }
    config = {
      binaryPath: options.binaryPath,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxConcurrent: Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES2,
      spawnImpl: options.spawnImpl ?? spawn
    };
  }
  let running = 0;
  let disposed = false;
  const waiters = [];
  async function acquire() {
    if (disposed) {
      throw new NativeVerifierError("native-verifier-unavailable", "\u539F\u751F\u6838\u9A8C\u5B9E\u4F8B\u5DF2\u91CA\u653E");
    }
    if (config === null) return;
    if (running < config.maxConcurrent) {
      running += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    if (disposed) {
      throw new NativeVerifierError("native-verifier-unavailable", "\u539F\u751F\u6838\u9A8C\u5B9E\u4F8B\u5DF2\u91CA\u653E");
    }
    running += 1;
  }
  function release() {
    running -= 1;
    waiters.shift()?.();
  }
  async function verify(bytes, verifyOptions = {}) {
    const current = config;
    if (current === null) {
      throw new NativeVerifierError("native-verifier-unavailable", "\u672A\u914D\u7F6E\u539F\u751F\u6838\u9A8C\u5DE5\u5177");
    }
    if (disposed) {
      throw new NativeVerifierError("native-verifier-unavailable", "\u539F\u751F\u6838\u9A8C\u5B9E\u4F8B\u5DF2\u91CA\u653E");
    }
    await acquire();
    try {
      const output = await runVerifier(current, bytes, verifyOptions.embeddedSmart === true);
      const parsed = JSON.parse(output);
      if (parsed.ok) {
        return {
          formatVersion: Number(parsed.summary.formatVersion ?? 0),
          generator: String(parsed.summary.generator ?? ""),
          canvasWidth: Number(parsed.summary.canvasWidth ?? 0),
          canvasHeight: Number(parsed.summary.canvasHeight ?? 0),
          layerCount: Number(parsed.summary.layerCount ?? 0),
          depth: Number(parsed.summary.depth ?? 0),
          entryCount: Number(parsed.summary.entryCount ?? 0),
          decompressedBytes: Number(parsed.summary.decompressedBytes ?? 0),
          objectKinds: Array.isArray(parsed.summary.objectKinds) ? parsed.summary.objectKinds.map((kind) => String(kind)) : []
        };
      }
      throw new ProjectVerificationError(parsed.code, parsed.message);
    } finally {
      release();
    }
  }
  async function verifyForIngest(bytes, contentType, verifyOptions = {}) {
    if (contentType !== IMAGE_PROJECT_CONTENT_TYPE) {
      throw new ProjectVerificationError(
        "unsupported-content-type",
        `\u4E0D\u662F\u5DE5\u7A0B\u5A92\u4F53\u7C7B\u578B\uFF1A${contentType || "(\u7A7A)"}`
      );
    }
    if (config === null || disposed) {
      return verifyPhotocraftProject(bytes, verifyOptions);
    }
    try {
      return await verify(bytes);
    } catch (error) {
      if (error instanceof NativeVerifierError) {
        return verifyPhotocraftProject(bytes, verifyOptions);
      }
      throw error;
    }
  }
  async function verifyEmbeddedForIngest(bytes, contentType, verifyOptions = {}) {
    if (contentType !== IMAGE_PROJECT_CONTENT_TYPE) {
      throw new ProjectVerificationError("unsupported-content-type", "\u4E0D\u662F\u5DE5\u7A0B\u5A92\u4F53\u7C7B\u578B");
    }
    const structure = inspectEmbeddedPhotocraftProject(bytes, verifyOptions);
    const native = await verify(bytes, { embeddedSmart: true });
    for (const key of [
      "formatVersion",
      "canvasWidth",
      "canvasHeight",
      "layerCount",
      "depth",
      "entryCount",
      "decompressedBytes"
    ]) {
      if (native[key] !== structure[key]) {
        throw new NativeVerifierError("native-verifier-failed", `\u539F\u751F\u6838\u9A8C\u6458\u8981\u4E0D\u4E00\u81F4\uFF1A${key}`);
      }
    }
    if (native.objectKinds.join(",") !== structure.objectKinds.join(",")) {
      throw new NativeVerifierError("native-verifier-failed", "\u539F\u751F\u6838\u9A8C\u5BF9\u8C61\u7C7B\u578B\u4E0D\u4E00\u81F4");
    }
    return native;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    config = null;
    for (const waiter of waiters.splice(0)) waiter();
  }
  return {
    configured: () => config !== null && !disposed,
    verify,
    verifyForIngest,
    verifyEmbeddedForIngest,
    dispose,
    inflight: () => running
  };
}
function createProcessOnlyVerifier() {
  return createNativeProjectVerifier(null);
}
function runVerifier(config, bytes, embeddedSmart = false) {
  return new Promise((resolve, reject2) => {
    const child = config.spawnImpl(config.binaryPath, embeddedSmart ? ["--embedded-smart"] : [], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject2(error);
      else resolve(value ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new NativeVerifierError("native-verifier-timeout", `\u539F\u751F\u6838\u9A8C\u8D85\u8FC7 ${config.timeoutMs}ms`));
    }, config.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > config.maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new NativeVerifierError("native-verifier-output-too-large", "\u539F\u751F\u6838\u9A8C\u8F93\u51FA\u8D85\u8FC7\u4E0A\u9650"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= config.maxOutputBytes) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(new NativeVerifierError("native-verifier-unavailable", `\u65E0\u6CD5\u542F\u52A8\u539F\u751F\u6838\u9A8C\u5DE5\u5177\uFF1A${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (stdout.trim().length === 0) {
        finish(
          new NativeVerifierError(
            "native-verifier-failed",
            `\u539F\u751F\u6838\u9A8C\u672A\u8F93\u51FA\u7ED3\u679C\uFF08\u9000\u51FA\u7801 ${code ?? "null"}\uFF09\uFF1A${stderr.trim().slice(0, 200)}`
          )
        );
        return;
      }
      finish(null, stdout.trim());
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(bytes);
  });
}

// ../project-verifier/src/media-format.ts
function photocraftMediaFormat(verifier) {
  return {
    contentType: IMAGE_PROJECT_CONTENT_TYPE,
    maxBytes: IMAGE_PROJECT_LIMITS2.maxProjectBytes,
    async validate(bytes, options) {
      try {
        await verifier.verifyForIngest(bytes, IMAGE_PROJECT_CONTENT_TYPE, options);
        return;
      } catch (error) {
        if (!(error instanceof ProjectVerificationError) || error.code !== "unsupported-object") throw error;
        if (!inspectEmbeddedPhotocraftProject(bytes, options).objectKinds.includes("smart")) throw error;
      }
      await verifier.verifyEmbeddedForIngest(bytes, IMAGE_PROJECT_CONTENT_TYPE, options);
    }
  };
}

// src/backend.ts
function createPhotocraftPlugin() {
  return {
    name: "photocraft",
    label: "PhotoCraft \u56FE\u7247\u7F16\u8F91",
    configPrefix: "extensions.photocraft",
    inject: { optional: ["capabilities", "mediaFormats"] },
    Config: defineConfigSchema({}),
    apply(ctx) {
      if (!ctx.capabilities) throw new Error("\u5BBF\u4E3B\u4E0D\u652F\u6301\u80FD\u529B\u6CE8\u518C");
      if (!ctx.mediaFormats) throw new Error("\u5BBF\u4E3B\u4E0D\u652F\u6301\u53EF\u7F16\u8F91\u5A92\u4F53\u683C\u5F0F");
      ctx.effect(() => ctx.capabilities.register("photocraft.edit", { available: true }));
      const binaryPath = process.env.WOOHAA3_PROJECT_VERIFIER_PATH?.trim();
      if (binaryPath) {
        if (!isAbsolute(binaryPath)) throw new Error("\u6838\u9A8C\u5DE5\u5177\u5FC5\u987B\u4E3A\u7EDD\u5BF9\u8DEF\u5F84");
        accessSync(binaryPath, constants.X_OK);
      }
      const verifier = binaryPath ? createNativeProjectVerifier({ binaryPath }) : createProcessOnlyVerifier();
      ctx.effect(() => () => verifier.dispose());
      ctx.effect(() => {
        const dispose = ctx.mediaFormats.register(photocraftMediaFormat(verifier));
        return () => dispose();
      });
    }
  };
}
export {
  createPhotocraftPlugin
};
