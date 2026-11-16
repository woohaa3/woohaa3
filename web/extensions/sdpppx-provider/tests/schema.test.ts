import { describe, expect, it } from "vitest";
import { buildSdpppxInputSchema } from "../src/backend/schema.js";

const FORM = {
  type: "object",
  required: ["prompt", "size"],
  properties: {
    prompt: { type: "string", title: "提示词", maxLength: 800 },
    steps: { type: "integer", title: "步数", minimum: 1, maximum: 50, default: 20 },
    ratio: { type: "number", title: "比例", multipleOf: 0.5 },
    enhance: { type: "boolean", title: "增强", default: true },
    size: { type: "string", title: "尺寸", enum: ["512", "1024"], enumNames: ["小", "大"] },
    image: {
      type: "string",
      title: "参考图",
      "x-component": "Upload",
      format: "image",
      "x-component-props": { maxCount: 1, accept: "image/*" }
    },
    video: {
      type: "array",
      title: "参考视频",
      "x-component": "Upload",
      items: { type: "string", format: "video" },
      "x-component-props": { maxCount: 3 }
    },
    mystery: { type: "object", title: "未知控件", "x-component": "SomethingCustom" },
    note: "not-an-object"
  }
};

describe("Formily → 宿主 inputSchema", () => {
  it("白名单转换 string/integer/number/boolean/enum，不渲染 prompt 与 rawParams", () => {
    const built = buildSdpppxInputSchema({ formSchema: FORM, promptField: "prompt" });
    const properties = built.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.prompt).toBeUndefined();
    expect(properties.rawParams).toBeUndefined();
    expect(properties.steps).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
      "x-component": "NumberPicker",
      "x-pptask-presentation": { section: "common" }
    });
    expect(properties.steps?.default).toBe(20);
    expect(properties.ratio).toMatchObject({ type: "number", multipleOf: 0.5 });
    expect(properties.enhance).toMatchObject({ type: "boolean", "x-component": "Switch" });
    expect(properties.size).toMatchObject({ type: "string", enum: ["512", "1024"], "x-enum-labels": ["小", "大"] });
    expect(built.inputSchema.required).toEqual(["size"]);
    expect(built.defaultInput).toEqual({ steps: 20, enhance: true });
    expect(built.promptRequirement).toBe("none");
    expect(built.promptField).toBe("prompt");
    expect(built.hasPromptField).toBe(true);
  });

  it("上传字段映射为参考媒体：单个取一、数组收全部并识别视频", () => {
    const built = buildSdpppxInputSchema({ formSchema: FORM, promptField: "prompt" });
    const properties = built.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.image).toMatchObject({
      type: "string",
      "x-component": "Upload",
      "x-pptask-semantic": "reference-image"
    });
    expect(properties.video).toMatchObject({
      type: "array",
      "x-component": "Upload",
      "x-pptask-semantic": "reference-video"
    });
    expect(built.referenceFields).toEqual([
      { key: "image", mediaKind: "image", multiple: false, maxItems: 1 },
      { key: "video", mediaKind: "video", multiple: true, maxItems: 3 }
    ]);
  });

  it("未识别字段只记诊断，不进入面板、不生成 rawParams", () => {
    const built = buildSdpppxInputSchema({ formSchema: FORM, promptField: "prompt" });
    expect(built.unknownFields).toEqual(["mystery", "note"]);
    const properties = built.inputSchema.properties as Record<string, unknown>;
    expect(properties.rawParams).toBeUndefined();
    expect(built.mappedFields).toBe(6);
  });

  it("没有 prompt 字段时同样不渲染 prompt，promptRequirement 固定为 none", () => {
    const built = buildSdpppxInputSchema({
      formSchema: { type: "object", properties: { size: { type: "string", enum: ["1"] } } },
      promptField: "prompt"
    });
    expect(built.promptRequirement).toBe("none");
    expect(built.hasPromptField).toBe(false);
    const properties = built.inputSchema.properties as Record<string, unknown>;
    expect(properties.prompt).toBeUndefined();
  });

  it("describe 失败/超时只给空 schema，不猜字段也不补 prompt/rawParams", () => {
    const built = buildSdpppxInputSchema({ formSchema: undefined, promptField: "prompt", minimal: true });
    expect(built.promptRequirement).toBe("none");
    expect(built.unknownFields).toEqual([]);
    expect(built.mappedFields).toBe(0);
    expect(built.inputSchema.properties).toEqual({});
    expect(built.inputSchema.required).toBeUndefined();
    expect(built.defaultInput).toEqual({});
    expect(built.hasPromptField).toBe(false);
  });

  it("自定义 prompt 字段名只用于提交回填，不出现在参数面板", () => {
    const built = buildSdpppxInputSchema({
      formSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      promptField: "text"
    });
    expect(built.promptRequirement).toBe("none");
    expect(built.hasPromptField).toBe(true);
    expect(built.promptField).toBe("text");
    expect((built.inputSchema.properties as Record<string, unknown>).text).toBeUndefined();
    expect((built.inputSchema.properties as Record<string, unknown>).prompt).toBeUndefined();
  });

  it("识别带前缀的模板提示词字段（2_prompt），不把它当普通参数", () => {
    const built = buildSdpppxInputSchema({
      formSchema: {
        type: "object",
        required: ["2_prompt", "2_resolution"],
        properties: {
          "2_prompt": { type: "string", title: "提示词", "x-component": "Input.TextArea" },
          "2_resolution": { type: "string", title: "清晰度", enum: ["1K", "2K"] }
        }
      },
      promptField: "prompt"
    });
    const properties = built.inputSchema.properties as Record<string, unknown>;
    expect(built.hasPromptField).toBe(true);
    expect(built.promptField).toBe("2_prompt");
    expect(properties["2_prompt"]).toBeUndefined();
    expect(properties["2_resolution"]).toMatchObject({
      title: "清晰度",
      "x-pptask-presentation": { section: "common" }
    });
    expect(built.inputSchema.required).toEqual(["2_resolution"]);
  });
});
