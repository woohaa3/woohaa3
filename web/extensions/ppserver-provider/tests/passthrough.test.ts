import { describe, expect, it } from "vitest";
import { isTemplateId } from "../src/shared.js";
import {
  PASSTHROUGH_CATEGORY,
  PASSTHROUGH_TEMPLATE_ID,
  isPassthroughTemplate,
  passthroughSource,
  passthroughTaskId,
  passthroughTemplate,
  readPassthroughTaskId
} from "../src/passthrough.js";
import { ppserverModelDefinitions } from "../src/discovery.js";

describe("passthrough template", () => {
  it("模板 id 过得了宿主对模板 id 的校验,且能被识别", () => {
    expect(isTemplateId(PASSTHROUGH_TEMPLATE_ID)).toBe(true);
    expect(isPassthroughTemplate(PASSTHROUGH_TEMPLATE_ID.toUpperCase())).toBe(true);
    expect(isPassthroughTemplate("0b19678e-7170-44b3-9758-fcdb8088ded2")).toBe(false);
  });

  it("目录定义带内部分类、零价,并有一个主图槽位", () => {
    const template = passthroughTemplate();
    expect(template.category).toBe(PASSTHROUGH_CATEGORY);
    expect(template.cost).toBe(0);
    const field = (template.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties["3_image"];
    expect(field?.["x-pptask-semantic"]).toBe("reference-image");
    const [definition] = ppserverModelDefinitions([template]);
    expect(definition?.capabilities).toEqual({ category: PASSTHROUGH_CATEGORY });
  });

  it("从输入里取图片地址:字符串数组、对象数组、缺失", () => {
    expect(passthroughSource({ "3_image": ["https://x/a.png"] })).toBe("https://x/a.png");
    expect(passthroughSource({ "3_image": [{ url: " https://x/b.png " }] })).toBe("https://x/b.png");
    expect(passthroughSource({})).toBe("");
  });

  it("任务 id 编码地址,可无状态还原;别的任务 id 不认", () => {
    const url = "https://cdn.example.com/a b/一张图.png?x=1&y=2";
    expect(readPassthroughTaskId(passthroughTaskId(url))).toBe(url);
    expect(readPassthroughTaskId("job_123")).toBeUndefined();
    expect(readPassthroughTaskId("passthrough:%E0%A4%A")).toBeUndefined();
  });
});
