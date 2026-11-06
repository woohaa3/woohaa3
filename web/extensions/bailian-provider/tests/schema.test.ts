import { describe, expect, it } from "vitest";
import { alibabaFamilySchema, findAdaptiveOption } from "@woohaa3/contracts";
import { BAILIAN_IMAGE_MODELS, findBailianModel } from "../src/catalog.js";
import { bailianDefaultInput, bailianInputSchema, describeBailianModel, inputSchemaOptions } from "../src/schema.js";
import { bailianModelDefinitions } from "../src/backend.js";

const qwen20 = findBailianModel("qwen-image-2.0")!;
const qwen21 = findBailianModel("qwen-image-2.1-pro")!;
const wan = findBailianModel("wan2.7-image-pro")!;
const zImage = findBailianModel("z-image-turbo")!;

describe("百炼参数面板", () => {
  it("提示词必填，比例与分辨率用公共语义控件", () => {
    const schema = bailianInputSchema(qwen20, inputSchemaOptions(qwen20));
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(schema).toMatchObject({ type: "object", required: ["prompt"] });
    expect(properties.prompt).toMatchObject({ type: "string", "x-component": "Input.TextArea" });
    expect(properties.aspectRatio).toMatchObject({ title: "比例", "x-pptask-control": "aspect-ratio" });
    expect(properties.resolution).toMatchObject({ title: "图片分辨率", "x-pptask-control": "resolution" });
    // 百炼不支持「自适应画幅」：比例必须落到具体像素。
    expect(findAdaptiveOption(properties.aspectRatio?.enum)).toBeUndefined();
  });

  it("参考图上限跟随模型，只能文生图的模型不出现参考图控件", () => {
    const qwen20Properties = bailianInputSchema(qwen20, inputSchemaOptions(qwen20)).properties as Record<string, Record<string, unknown>>;
    expect(qwen20Properties.urls).toMatchObject({
      type: "array",
      "x-pptask-semantic": "reference-image",
      "x-component": "Upload",
      maxItems: 3
    });
    expect(qwen20Properties.urls?.["x-component-props"]).toEqual({ maxCount: 3 });
    expect(bailianDefaultInput(qwen20, inputSchemaOptions(qwen20)).urls).toEqual([]);

    const zImageProperties = bailianInputSchema(zImage, inputSchemaOptions(zImage)).properties as Record<string, unknown>;
    expect(zImageProperties).not.toHaveProperty("urls");
    expect(bailianDefaultInput(zImage, inputSchemaOptions(zImage))).not.toHaveProperty("urls");
  });

  it("只有支持 negative_prompt / prompt_extend 的模型才出控件", () => {
    const qwen20Properties = bailianInputSchema(qwen20, inputSchemaOptions(qwen20)).properties as Record<string, Record<string, unknown>>;
    expect(qwen20Properties.negativePrompt).toMatchObject({ "x-component": "Input.TextArea" });
    expect(qwen20Properties.promptExtend).toMatchObject({ "x-component": "Switch", default: true });

    // 2.1 / 3.0 文档只给 prompt_extend，没有 negative_prompt。
    const qwen21Properties = bailianInputSchema(qwen21, inputSchemaOptions(qwen21)).properties as Record<string, unknown>;
    expect(qwen21Properties).toHaveProperty("promptExtend");
    expect(qwen21Properties).not.toHaveProperty("negativePrompt");

    // 万相 2.7 两个都不支持（提质走 thinking_mode，不在面板暴露）。
    const wanProperties = bailianInputSchema(wan, inputSchemaOptions(wan)).properties as Record<string, unknown>;
    expect(wanProperties).not.toHaveProperty("negativePrompt");
    expect(wanProperties).not.toHaveProperty("promptExtend");
  });

  it("z-image 的智能改写默认关（开启会加价）", () => {
    const properties = bailianInputSchema(zImage, inputSchemaOptions(zImage)).properties as Record<string, Record<string, unknown>>;
    expect(properties.promptExtend).toMatchObject({ "x-component": "Switch", default: false });
    expect(bailianDefaultInput(zImage, inputSchemaOptions(zImage))).toMatchObject({ promptExtend: false });
  });

  it("面板不暴露数量：任务服务只落第一张图", () => {
    for (const model of BAILIAN_IMAGE_MODELS) {
      const properties = bailianInputSchema(model, inputSchemaOptions(model)).properties as Record<string, unknown>;
      expect(properties).not.toHaveProperty("n");
      expect(properties).not.toHaveProperty("seed");
    }
  });

  it("默认输入与面板字段一致", () => {
    for (const model of BAILIAN_IMAGE_MODELS) {
      const options = inputSchemaOptions(model);
      const schema = bailianInputSchema(model, options);
      const defaults = bailianDefaultInput(model, options);
      expect(Object.keys(defaults).sort()).toEqual(Object.keys(schema.properties as Record<string, unknown>).sort());
      expect(describeBailianModel(model)).toMatchObject({ title: model.title, promptRequirement: "required" });
    }
  });

  it("注册给宿主的模型定义与面板同源（不许两边各写一份 schema）", () => {
    // 设置页/任务面板读的是 `bailianModelDefinitions()`，家族读的是卡片投影；
    // 两者必须由同一个 `describeBailianModel` 派生，否则面板与请求体会悄悄分叉。
    const definitions = bailianModelDefinitions();
    expect(definitions.map((definition) => definition.providerModelId))
      .toEqual(BAILIAN_IMAGE_MODELS.map((model) => model.id));
    for (const definition of definitions) {
      const model = findBailianModel(definition.providerModelId)!;
      const expected = describeBailianModel(model);
      expect(definition.title, model.id).toBe(expected.title);
      expect(definition.inputSchema, model.id).toEqual(expected.inputSchema);
      expect(definition.defaultInput, model.id).toEqual(expected.defaultInput);
      expect(definition.promptRequirement).toBe("required");
      // 同步接口没有远端 id 可取消。
      expect(definition.cancel).toBe("local");
    }
  });

  it("面板的语义控件就是卡片投影给出的那份", () => {
    for (const model of BAILIAN_IMAGE_MODELS) {
      const projected = alibabaFamilySchema(model);
      const properties = bailianInputSchema(model, inputSchemaOptions(model)).properties as Record<string, unknown>;
      for (const [key, schema] of Object.entries(projected.properties)) {
        expect(properties[key], `${model.id} ${key}`).toEqual(schema);
      }
      for (const [key, value] of Object.entries(projected.defaults)) {
        expect(bailianDefaultInput(model, inputSchemaOptions(model))[key], `${model.id} ${key}`).toBe(value);
      }
    }
  });

  it("分辨率档位只给模型真正支持的", () => {
    expect(wan.resolutions).toEqual(["1K", "2K", "4K"]);
    expect(findBailianModel("wan2.7-image")?.resolutions).toEqual(["1K", "2K"]);
    expect(zImage.resolutions).toEqual(["1K"]);
    // 每个比例在每档上都有像素值，否则 resolvePixelSize 会静默回落。
    for (const model of BAILIAN_IMAGE_MODELS) {
      for (const ratio of model.aspectRatios) {
        for (const resolution of model.resolutions) {
          expect(model.sizes[ratio]?.[resolution], `${model.id} ${ratio} ${resolution}`).toMatch(/^\d+\*\d+$/);
        }
      }
    }
  });
});
