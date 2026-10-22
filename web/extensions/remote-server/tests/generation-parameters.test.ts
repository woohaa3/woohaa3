/**
 * 远端托管生成的参数收敛测试。
 *
 * 锁住这次修复的另一半：目录里的语义参数（resolution / aspectRatio）经过解码与收敛后
 * 必须**原样保留语义**——既不能被本地翻译成像素尺寸（那是服务端按家族的解释权），
 * 也不能被面板遗留的脏值（空串、隐藏字段、旧模型参数）污染成「用户选了这个值」。
 */
import { describe, expect, it } from "vitest";
import {
  convergeGenerationParameters,
  convergeGenerationParametersWithReport,
  describeSemanticField,
  isAdaptiveParameterValueFor,
  normalizeParameterValue,
  readPropertySchema
} from "../src/backend/generation/parameters.js";
import { decodeGenerationCatalog } from "../src/backend/generation/protocol.js";

/** 服务端为 seedream-5-pro 下发的 schema（与 generation/image_families.go 同形）。 */
const SEEDREAM_SCHEMA = {
  type: "object",
  properties: {
    aspectRatio: {
      type: "string",
      title: "图片比例",
      default: "auto",
      "x-component": "Select",
      "x-pptask-control": "aspect-ratio",
      enum: [
        { value: "auto", label: "自适应", "x-pptask-adaptive": true },
        { value: "1:1", label: "1:1" },
        { value: "16:9", label: "16:9" },
        { value: "9:16", label: "9:16" }
      ]
    },
    resolution: {
      type: "string",
      title: "图片分辨率",
      default: "2K",
      "x-component": "Select",
      "x-pptask-control": "resolution",
      enum: [
        { value: "1K", label: "1K" },
        { value: "1.5K", label: "1.5K" },
        { value: "2K", label: "2K" }
      ]
    }
  }
};

const SEEDREAM_DEFAULTS = { resolution: "2K", aspectRatio: "auto" };

/** 老服务端：仍是裸像素 size（兼容性回归用）。 */
const LEGACY_SCHEMA = {
  type: "object",
  properties: { size: { type: "string", title: "尺寸", default: "1024x1024" } }
};

describe("convergeGenerationParameters", () => {
  it("用户值优先并保留语义参数，不翻译成像素尺寸", () => {
    const parameters = convergeGenerationParameters({
      inputSchema: SEEDREAM_SCHEMA,
      defaultInput: SEEDREAM_DEFAULTS,
      parameters: { resolution: "1K", aspectRatio: "16:9" }
    });
    expect(parameters).toEqual({ resolution: "1K", aspectRatio: "16:9" });
    // 关键约束：客户端不改写语义参数——像素翻译由服务端按模型家族决定。
    expect(parameters).not.toHaveProperty("size");
  });

  it("缺省参数按 defaultInput 补齐（批处理/重跑没有面板参与时）", () => {
    const parameters = convergeGenerationParameters({
      inputSchema: SEEDREAM_SCHEMA,
      defaultInput: SEEDREAM_DEFAULTS,
      parameters: {}
    });
    expect(parameters).toEqual({ resolution: "2K", aspectRatio: "auto" });
  });

  it("保留「自适应」取值，不降级成固定像素", () => {
    const parameters = convergeGenerationParameters({
      inputSchema: SEEDREAM_SCHEMA,
      defaultInput: SEEDREAM_DEFAULTS,
      parameters: { resolution: "1K", aspectRatio: "auto" }
    });
    expect(parameters.aspectRatio).toBe("auto");
  });

  it("enum 残留值回落到默认值，而不是发给上游", () => {
    const parameters = convergeGenerationParameters({
      inputSchema: SEEDREAM_SCHEMA,
      defaultInput: SEEDREAM_DEFAULTS,
      // 'hd' 是切换模型前残留的旧枚举。
      parameters: { resolution: "hd", aspectRatio: "1:1" }
    });
    expect(parameters.resolution).toBe("2K");
    expect(parameters.aspectRatio).toBe("1:1");
  });

  it("清空字段不把默认值填回来（「不选」不等于「选了默认」）", () => {
    const parameters = convergeGenerationParameters({
      inputSchema: SEEDREAM_SCHEMA,
      defaultInput: SEEDREAM_DEFAULTS,
      parameters: { resolution: "", aspectRatio: "1:1" }
    });
    expect(parameters).not.toHaveProperty("resolution");
    expect(parameters.aspectRatio).toBe("1:1");
  });

  it("丢弃模型身份与 prompt：它们是协议同级字段", () => {
    const parameters = convergeGenerationParameters({
      inputSchema: SEEDREAM_SCHEMA,
      defaultInput: SEEDREAM_DEFAULTS,
      parameters: { model: "seedream-5-pro", prompt: "a cat", resolution: "1K" }
    });
    expect(parameters).not.toHaveProperty("model");
    expect(parameters).not.toHaveProperty("prompt");
    expect(parameters.resolution).toBe("1K");
  });

  it("清洗空串、null、NaN 与空容器", () => {
    const parameters = convergeGenerationParameters({
      inputSchema: {},
      defaultInput: {},
      parameters: { a: "", b: null, c: Number.NaN, d: [], e: {}, f: " keep ", g: 3 }
    });
    expect(parameters).toEqual({ f: "keep", g: 3 });
  });

  it("schema 未声明的键原样保留（不按白名单裁剪）", () => {
    const parameters = convergeGenerationParameters({
      inputSchema: SEEDREAM_SCHEMA,
      defaultInput: SEEDREAM_DEFAULTS,
      parameters: { resolution: "1K", seed: 42, watermark: false }
    });
    // 远端可能接受 schema 之外的参数，收得太紧会砍掉真实能力。
    expect(parameters.seed).toBe(42);
    expect(parameters.watermark).toBe(false);
  });

  it("老服务端的裸 size schema 原样工作", () => {
    const parameters = convergeGenerationParameters({
      inputSchema: LEGACY_SCHEMA,
      defaultInput: { size: "1024x1024" },
      parameters: {}
    });
    expect(parameters).toEqual({ size: "1024x1024" });
  });

  it("空 schema 与空参数不抛错", () => {
    expect(convergeGenerationParameters({})).toEqual({});
    expect(convergeGenerationParameters({ parameters: null })).toEqual({});
  });
});

describe("describeSemanticField", () => {
  it("解码后发现语义控件与自适应项仍然可识别", () => {
    // 这条保证「服务端下发的语义字段没有在解码/透传中丢失」：
    // 丢了前端就会退回成裸输入框，正是报障的现象。
    const ratio = describeSemanticField(SEEDREAM_SCHEMA, "aspectRatio");
    expect(ratio?.control).toBe("aspect-ratio");
    expect(ratio?.options.some((option) => option.value === "auto" && option.adaptive)).toBe(true);

    const resolution = describeSemanticField(SEEDREAM_SCHEMA, "resolution");
    expect(resolution?.control).toBe("resolution");
    expect(resolution?.options.map((option) => option.value)).toEqual(["1K", "1.5K", "2K"]);
  });

  it("未声明语义的字段回落成 plain", () => {
    expect(describeSemanticField(LEGACY_SCHEMA, "size")?.control).toBe("plain");
    expect(describeSemanticField(SEEDREAM_SCHEMA, "missing")).toBeUndefined();
  });

  it("读不到 properties 时返回空（不抛错）", () => {
    expect(readPropertySchema(undefined, "x")).toBeUndefined();
    expect(readPropertySchema({}, "x")).toBeUndefined();
  });
});

describe("isAdaptiveParameterValueFor", () => {
  it("识别 enum 上标记的自适应项", () => {
    const schema = readPropertySchema(SEEDREAM_SCHEMA, "aspectRatio")!;
    expect(isAdaptiveParameterValueFor(schema, "auto")).toBe(true);
    expect(isAdaptiveParameterValueFor(schema, "16:9")).toBe(false);
    expect(isAdaptiveParameterValueFor(schema, 42)).toBe(false);
  });
});

describe("normalizeParameterValue", () => {
  it("递归清洗容器内的空值", () => {
    expect(normalizeParameterValue({ a: "", b: 1 })).toEqual({ b: 1 });
    expect(normalizeParameterValue(["x", "", null])).toEqual(["x"]);
    expect(normalizeParameterValue("   ")).toBeUndefined();
    expect(normalizeParameterValue(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("convergeGenerationParametersWithReport", () => {
  it("报告被丢弃的键（便于解释「这个参数为什么没生效」）", () => {
    const report = convergeGenerationParametersWithReport({
      inputSchema: SEEDREAM_SCHEMA,
      defaultInput: SEEDREAM_DEFAULTS,
      parameters: { model: "x", resolution: "", aspectRatio: "1:1" }
    });
    expect(report.parameters.aspectRatio).toBe("1:1");
    // 被清空的已声明字段会被报告；model/prompt 本来就不是参数，不进入报告。
    expect(report.droppedKeys).toContain("resolution");
    expect(report.droppedKeys).not.toContain("model");
  });
});

describe("decodeGenerationCatalog 的 schema 保真", () => {
  it("线格式里的语义控件在解码后逐字保留", () => {
    // 这条钉住「服务端写对了、客户端解码没吃掉的」这一环：一旦 x-pptask-control /
    // x-pptask-adaptive 在 decodeModel 里被裁掉，前端会退回成普通下拉或裸输入框，
    // 正是截图里那个只有一个「尺寸」输入框的现象。
    const decoded = decodeGenerationCatalog(
      {
        available: true,
        catalogRevision: 3,
        models: [
          {
            modelKey: "seedream-5-pro",
            modelType: "image",
            title: "seedream-5-pro",
            // ProtoJSON：Struct 原样给出，键名保持 camelCase。
            inputSchema: SEEDREAM_SCHEMA,
            defaultInput: SEEDREAM_DEFAULTS
          }
        ]
      },
      "remote-server"
    );
    expect(decoded.models).toHaveLength(1);
    const model = decoded.models[0]!;
    expect(model.providerModelId).toBe("seedream-5-pro");
    expect(model.inputSchema).toEqual(SEEDREAM_SCHEMA);
    expect(model.defaultInput).toEqual(SEEDREAM_DEFAULTS);

    // 语义仍可识别（前端投影依赖这三个关键字）。
    expect(describeSemanticField(model.inputSchema, "aspectRatio")?.control).toBe("aspect-ratio");
    expect(describeSemanticField(model.inputSchema, "resolution")?.control).toBe("resolution");
  });

  it("解码后的默认值与 schema 一起流过收敛，产出可直接提交的参数", () => {
    const decoded = decodeGenerationCatalog(
      {
        available: true,
        models: [
          { modelKey: "seedream-5-pro", modelType: "image", inputSchema: SEEDREAM_SCHEMA, defaultInput: SEEDREAM_DEFAULTS }
        ]
      },
      "remote-server"
    );
    const model = decoded.models[0]!;
    // 面板什么都没改：提交的是模型默认（2K + 自适应），而不是 1024x1024。
    expect(convergeGenerationParameters({ inputSchema: model.inputSchema, defaultInput: model.defaultInput, parameters: {} }))
      .toEqual({ resolution: "2K", aspectRatio: "auto" });
  });
});
