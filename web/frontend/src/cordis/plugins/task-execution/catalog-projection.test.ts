/**
 * catalog → 面板配置投影测试（任务 3.5 / 4.3）。
 */
import { describe, expect, it } from "vitest";
import { resolveBlockingReasons } from "./node-panel-helpers.js";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";
import { catalogFixture } from "./test-support/fixtures.js";
import { catalogBlockingReasons,
  capabilityForModel,
  modelsForPanel,
  modelOptionForCatalog,
  panelModelConfigForCatalog } from "./catalog-projection.js";

const CATALOG: CanvasTaskCatalog = catalogFixture([
  {
    modelKey: "gpt-image-2",
    modelType: "image",
    title: "Image 2",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", title: "提示词" },
        urls: { type: "array", maxItems: 16, "x-pptask-semantic": "reference-image" },
        aspectRatio: {
          type: "string",
          title: "比例",
          default: "1:1",
          enum: [
            { label: "1:1", value: "1:1" },
            { label: "16:9", value: "16:9" }
          ]
        },
        outputCompression: {
          type: "number",
          title: "输出压缩",
          default: 80,
          minimum: 0,
          maximum: 100,
          "x-hidden-when": [{ field: "outputFormat", equals: "png" }]
        },
        enhance: { type: "boolean", title: "增强", default: true },
        notes: { type: "string", title: "备注", "x-component": "Input.TextArea" }
      }
    },
    defaultInput: { prompt: "", urls: [], aspectRatio: "1:1", outputCompression: 80, enhance: true }
  },
  {
    modelKey: "gemini-2.5-flash",
    modelType: "language",
    title: "Gemini 2.5 Flash",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", title: "提示词" },
        urls: { type: "array", maxItems: 14, "x-pptask-semantic": "reference-image" },
        maxTokens: { type: "number", title: "最大输出 Token", default: 2048 }
      }
    },
    defaultInput: { prompt: "", urls: [], maxTokens: 2048 }
  }
], { image: "gpt-image-2" });

describe("panelModelConfigForCatalog", () => {
  it("模型选项不附加参考输入和分辨率介绍，Provider独立展示", () => {
    const model = { ...CATALOG.models[0], inputSchema: { properties: {
      resolution: { title: "分辨率", enum: [{ value: "512", label: "512" }, { value: "2K", label: "2K" }] }
    } } };
    const option = modelOptionForCatalog(model);
    expect(option.detail).toBeUndefined();
    expect(option.label).toBe(model.title || model.providerModelId);
    expect(option.provider).toBe(model.providerId);
    expect(modelOptionForCatalog({ ...model, bindings: [] }).detail).toBeUndefined();
  });
  it("按任务类型筛选模型（图片面板只出图片模型）", () => {
    const config = panelModelConfigForCatalog(CATALOG, "image-generation");
    expect(config.modelOptions.map((option) => option.value)).toEqual(["gpt-image-2"]);
    expect(config.defaultModel).toBe("gpt-image-2");
  });

  it("enum → select，number 带范围 → slider，boolean → checkbox，TextArea → textarea", () => {
    const config = panelModelConfigForCatalog(CATALOG, "image-generation");
    const fields = config.parameterSchemaByModel?.["gpt-image-2"] ?? [];
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));

    expect(byKey.aspectRatio.type).toBe("select");
    expect(byKey.aspectRatio.options).toEqual([
      { value: "1:1", label: "1:1" },
      { value: "16:9", label: "16:9" }
    ]);
    expect(byKey.outputCompression).toMatchObject({
      type: "number",
      control: "slider",
      minimum: 0,
      maximum: 100
    });
    expect(byKey.outputCompression.hiddenWhen).toEqual([{ field: "outputFormat", equals: "png" }]);
    expect(byKey.enhance.type).toBe("boolean");
    expect(byKey.notes.type).toBe("textarea");
  });

  it("prompt 与 urls 不进入参数表（面板自带提示词框与参考输入）", () => {
    const config = panelModelConfigForCatalog(CATALOG, "image-generation");
    const keys = (config.parameterSchemaByModel?.["gpt-image-2"] ?? []).map((field) => field.key);
    expect(keys).not.toContain("prompt");
    expect(keys).not.toContain("urls");
    expect(config.defaultsByModel?.["gpt-image-2"]).toEqual({
      aspectRatio: "1:1",
      outputCompression: 80,
      enhance: true
    });
  });

  it("没有模型时返回空配置（面板由 blocking reason 禁用）", () => {
    const config = panelModelConfigForCatalog({ available: false, models: [], defaultModels: {} }, "image-generation");
    expect(config.modelOptions).toEqual([]);
    expect(config.defaultModel).toBe("");
  });
});

describe("默认模型", () => {
  it("优先用 catalog 的 defaultModels（来自模型配置文件）", () => {
    const catalog = catalogFixture(
      [
        { modelKey: "gpt-image-2", modelType: "image" },
        { modelKey: "gemini-3.1-flash-image", modelType: "image" }
      ],
      { image: "gemini-3.1-flash-image" }
    );
    expect(panelModelConfigForCatalog(catalog, "image-generation").defaultModel).toBe(
      "gemini-3.1-flash-image"
    );
  });

  it("配置的默认模型不在启用集合里时以首个可用模型初始化", () => {
    const catalog = catalogFixture([{ modelKey: "gpt-image-2", modelType: "image" }], {
      image: "no-longer-enabled"
    });
    expect(panelModelConfigForCatalog(catalog, "image-generation").defaultModel).toBe("gpt-image-2");
  });

  it("没有声明默认模型时以首个可用模型初始化", () => {
    const catalog = catalogFixture([{ modelKey: "gpt-image-2", modelType: "image" }]);
    expect(panelModelConfigForCatalog(catalog, "image-generation").defaultModel).toBe("gpt-image-2");
  });
});

describe("modelsForPanel", () => {
  it("image-generation 只取 image 模型，text-generation 只取 language 模型", () => {
    expect(modelsForPanel(CATALOG, "image-generation").map((m) => m.modelKey)).toEqual(["gpt-image-2"]);
    expect(modelsForPanel(CATALOG, "text-generation").map((m) => m.modelKey)).toEqual(["gemini-2.5-flash"]);
  });
});

describe("capabilityForModel", () => {
  it("读取模型的参考输入能力", () => {
    expect(capabilityForModel(CATALOG, "image-generation", "gpt-image-2")).toMatchObject({
      acceptsImages: true,
      roles: ["reference_image"],
      maxItems: 16,
      mediaTypes: ["image/png", "image/jpeg", "image/webp"]
    });
    expect(capabilityForModel(CATALOG, "image-generation", "gpt-image-2")?.bindings[0]).toMatchObject({
      semantic: "reference-image",
      mediaKinds: ["image"],
      maxItems: 16
    });
  });

  it("未知模型不借用其他模型的能力", () => {
    expect(capabilityForModel(CATALOG, "text-generation", "no-such-model")).toBeNull();
  });

  it("该类型没有模型时返回 null", () => {
    expect(capabilityForModel({ available: true, models: [], defaultModels: {} }, "image-generation")).toBeNull();
  });

  it("不接受参考图的模型返回 acceptsImages=false（调用方据此阻止执行）", () => {
    const catalog = catalogFixture([
      { modelKey: "text-only", modelType: "language", bindings: [] }
    ]);
    expect(capabilityForModel(catalog, "text-generation", "text-only")).toMatchObject({
      acceptsImages: false,
      maxItems: 0
    });
  });
});

describe("catalogBlockingReasons", () => {
  it("缺少凭据只提示配置，不叠加该节点没有可用模型", () => {
    const catalog = { available: false, reason: "请配置 Provider API Key", models: [], defaultModels: {} };
    expect(resolveBlockingReasons({
      panelKind: "video-generation", nodeId: "existing-video", disabledReason: null,
      pendingSelection: false, catalog, catalogState: { status: "ready", catalog },
      model: "ark:seedance2_0", canvas: null, panelParameters: {}
    })).toEqual(["请配置 Provider API Key"]);
  });
  it("目录不可用时给出原因（不是「没有模型」）", () => {
    expect(catalogBlockingReasons({ available: false, reason: "缺少 PPTASK_LITELLM_API_KEY", models: [], defaultModels: {} })).toEqual([
      "缺少 PPTASK_LITELLM_API_KEY"
    ]);
  });

  it("尚未加载", () => {
    expect(catalogBlockingReasons(null)).toEqual(["任务目录尚未加载"]);
  });

  it("可用且有模型时没有阻止原因", () => {
    expect(catalogBlockingReasons(CATALOG)).toEqual([]);
  });
});

describe("参数语义投影（x-pptask-control / x-pptask-adaptive）", () => {
  const SEMANTIC_CATALOG: CanvasTaskCatalog = catalogFixture([
    {
      modelKey: "semantic-image",
      modelType: "image",
      title: "语义图片模型",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", title: "提示词" },
          urls: { type: "array", maxItems: 16 },
          aspectRatio: {
            type: "string",
            title: "比例",
            default: "auto",
            "x-pptask-control": "aspect-ratio",
            enum: [
              { value: "auto", label: "自适应", "x-pptask-adaptive": true },
              { value: "1:1", label: "1:1" },
              { value: "16:9", label: "16:9" }
            ]
          },
          resolution: {
            type: "string",
            title: "分辨率",
            default: "1K",
            "x-pptask-control": "resolution",
            enum: [
              { value: "1K", label: "1K" },
              { value: "2K", label: "2K" }
            ]
          },
          quality: {
            type: "string",
            title: "质量",
            "x-pptask-control": "quality",
            enum: ["standard", "hd"]
          },
          style: {
            type: "string",
            title: "风格",
            enum: ["photo", "anime"]
          },
          background: {
            type: "string",
            title: "背景",
            default: "auto",
            "x-pptask-control": "background",
            enum: [
              { value: "auto", label: "自动" },
              { value: "transparent", label: "透明", "x-pptask-requires": { outputFormat: "png" } },
              { value: "opaque", label: "不透明" }
            ]
          },
          outputFormat: {
            type: "string",
            title: "输出格式",
            default: "png",
            enum: ["png", "jpeg"]
          }
        }
      },
      defaultInput: { prompt: "", urls: [], aspectRatio: "auto", resolution: "1K" }
    }
  ]);

  function semanticFields() {
    const config = panelModelConfigForCatalog(SEMANTIC_CATALOG, "image-generation");
    const fields = config.parameterSchemaByModel?.["semantic-image"] ?? [];
    return Object.fromEntries(fields.map((field) => [field.key, field]));
  }

  it("x-pptask-control 投影为 semantic，未声明语义的 select 不带 semantic", () => {
    const byKey = semanticFields();
    expect(byKey.aspectRatio.semantic).toBe("aspect-ratio");
    expect(byKey.resolution.semantic).toBe("resolution");
    expect(byKey.quality.semantic).toBe("quality");
    expect(byKey.style.type).toBe("select");
    expect(byKey.style.semantic).toBeUndefined();
  });

  it("x-pptask-requires 投影为 requiresByValue，只带声明过的选项", () => {
    const byKey = semanticFields();
    expect(byKey.background.semantic).toBe("background");
    expect(byKey.background.requiresByValue).toEqual({ transparent: { outputFormat: "png" } });
    // 没有声明联动的字段完全没有这个概念。
    expect(byKey.outputFormat.requiresByValue).toBeUndefined();
    expect(byKey.aspectRatio.requiresByValue).toBeUndefined();
  });

  it("x-pptask-adaptive 投影为 adaptiveValue，普通枚举没有自适应值", () => {
    const byKey = semanticFields();
    expect(byKey.aspectRatio.adaptiveValue).toBe("auto");
    expect(byKey.resolution.adaptiveValue).toBeUndefined();
    expect(byKey.quality.adaptiveValue).toBeUndefined();
    expect(byKey.style.adaptiveValue).toBeUndefined();
  });

  it("语义声明不改变选项与默认值投影", () => {
    const config = panelModelConfigForCatalog(SEMANTIC_CATALOG, "image-generation");
    const byKey = semanticFields();
    expect(byKey.aspectRatio.options).toEqual([
      { value: "auto", label: "自适应" },
      { value: "1:1", label: "1:1" },
      { value: "16:9", label: "16:9" }
    ]);
    expect(byKey.aspectRatio.defaultValue).toBe("auto");
    expect(config.defaultsByModel?.["semantic-image"]).toEqual({
      aspectRatio: "auto",
      resolution: "1K",
      // 新增字段的 default 也会进默认值表：面板打开时就有值，不必等用户点一遍。
      background: "auto",
      outputFormat: "png"
    });
  });
});

describe("音视频目录投影", () => {
  const MEDIA_CATALOG: CanvasTaskCatalog = catalogFixture([
    {
      modelKey: "seedance2_0",
      modelType: "video",
      title: "Seedance 2.0",
      bindings: [
        {
          field: "frames",
          semantic: "reference-image",
          roles: ["first_frame", "last_frame"],
          mediaKinds: ["image"],
          mediaTypes: ["image/png"],
          maxItems: 2,
          valueFormat: "url"
        },
        {
          field: "videoUrls",
          semantic: "reference-video",
          roles: ["edit_video", "reference_video"],
          mediaKinds: ["video"],
          mediaTypes: ["video/mp4"],
          maxItems: 1,
          valueFormat: "url"
        }
      ]
    },
    {
      modelKey: "minimax-speech-2.8-hd",
      modelType: "audio",
      title: "MiniMax Speech",
      bindings: []
    }
  ]);

  it("video-generation 只显示 video 模型", () => {
    const models = modelsForPanel(MEDIA_CATALOG, "video-generation");
    expect(models.map((model) => model.modelKey)).toEqual(["seedance2_0"]);
  });

  it("audio-generation 只显示 audio 模型", () => {
    const models = modelsForPanel(MEDIA_CATALOG, "audio-generation");
    expect(models.map((model) => model.modelKey)).toEqual(["minimax-speech-2.8-hd"]);
  });

  it("视频模型的参考能力来自 bindings（多模态）", () => {
    const capability = capabilityForModel(MEDIA_CATALOG, "video-generation", "seedance2_0");
    expect(capability?.bindings.map((binding) => binding.semantic)).toEqual([
      "reference-image",
      "reference-video"
    ]);
    expect(capability?.roles).toContain("first_frame");
    expect(capability?.roles).toContain("edit_video");
    expect(capability?.mediaTypes).toContain("video/mp4");
  });

  it("音频模型无参考输入", () => {
    const capability = capabilityForModel(MEDIA_CATALOG, "audio-generation", "minimax-speech-2.8-hd");
    expect(capability?.acceptsImages).toBe(false);
    expect(capability?.bindings).toEqual([]);
  });
});
