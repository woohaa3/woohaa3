import { describe, expect, it } from "vitest";
import {
  SDPPPX_RAW_PARAMS_FIELD,
  buildSdpppxInputSchema
} from "../src/backend/schema.js";

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
  it("白名单转换 string/integer/number/boolean/enum，并保留 default 与 required", () => {
    const built = buildSdpppxInputSchema({ formSchema: FORM, promptField: "prompt" });
    const properties = built.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.prompt).toMatchObject({ type: "string", maxLength: 800, "x-component": "Input.TextArea" });
    expect(properties.steps).toMatchObject({ type: "integer", minimum: 1, maximum: 50, "x-component": "NumberPicker" });
    expect(properties.steps?.default).toBe(20);
    expect(properties.ratio).toMatchObject({ type: "number", multipleOf: 0.5 });
    expect(properties.enhance).toMatchObject({ type: "boolean", "x-component": "Switch" });
    expect(properties.size).toMatchObject({ type: "string", enum: ["512", "1024"], "x-enum-labels": ["小", "大"] });
    expect(built.inputSchema.required).toEqual(["prompt", "size"]);
    expect(built.defaultInput).toEqual({ prompt: "", steps: 20, enhance: true, [SDPPPX_RAW_PARAMS_FIELD]: "" });
    expect(built.promptRequirement).toBe("required");
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

  it("未识别字段收敛到 rawParams，不丢信息、不阻塞面板", () => {
    const built = buildSdpppxInputSchema({ formSchema: FORM, promptField: "prompt" });
    expect(built.unknownFields).toEqual(["mystery", "note"]);
    const properties = built.inputSchema.properties as Record<string, unknown>;
    expect(properties[SDPPPX_RAW_PARAMS_FIELD]).toMatchObject({ type: "string", "x-component": "Input.TextArea" });
    expect(built.mappedFields).toBe(7);
  });

  it("模板没有 prompt 字段时 promptRequirement=none", () => {
    const built = buildSdpppxInputSchema({
      formSchema: { type: "object", properties: { size: { type: "string", enum: ["1"] } } },
      promptField: "prompt"
    });
    expect(built.promptRequirement).toBe("none");
    const properties = built.inputSchema.properties as Record<string, unknown>;
    expect(properties.prompt).toBeUndefined();
  });

  it("prompt 存在但非必填时为 optional", () => {
    const built = buildSdpppxInputSchema({
      formSchema: { type: "object", properties: { prompt: { type: "string" } } },
      promptField: "prompt"
    });
    expect(built.promptRequirement).toBe("optional");
  });

  it("describe 失败/超时给最小 prompt + rawParams，不猜字段", () => {
    const built = buildSdpppxInputSchema({ formSchema: undefined, promptField: "prompt", minimal: true });
    expect(built.promptRequirement).toBe("required");
    expect(built.unknownFields).toEqual([]);
    expect(built.mappedFields).toBe(0);
    const properties = built.inputSchema.properties as Record<string, unknown>;
    expect(properties.prompt).toMatchObject({ type: "string" });
    expect(properties[SDPPPX_RAW_PARAMS_FIELD]).toBeDefined();
    expect(built.inputSchema.required).toEqual(["prompt"]);
  });

  it("自定义 prompt 字段名生效", () => {
    const built = buildSdpppxInputSchema({
      formSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      promptField: "text"
    });
    expect(built.promptRequirement).toBe("required");
    expect((built.inputSchema.properties as Record<string, unknown>).text).toBeDefined();
    expect((built.inputSchema.properties as Record<string, unknown>).prompt).toBeUndefined();
  });
});
