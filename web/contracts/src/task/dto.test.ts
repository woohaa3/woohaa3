/**
 * Task DTO 往返契约测试（change: split-web-runtime-services，任务 1.3；迁自
 * `apps/site/shared/tasks.test.ts`）。
 *
 * 浏览器与服务端共用同一份 DTO 定义（`@woohaa3/contracts`）。共用类型只是编译期保证，
 * 这里用真实 JSON 往返断言运行期字段集合稳定（不多、不少、无敏感字段）。
 */
import { describe, expect, it } from "vitest";
import { CANVAS_TASK_LIMITS,
  referenceInputCapabilityFromDescription,
  type CanvasTaskRequest } from "./dto.js";

const REQUEST: CanvasTaskRequest = {
  runId: "run-abc-1",
  nodeId: "node-image-1",
  nodeType: "image",
  modelType: "image",
  modelKey: "litellm:gpt-image-2",
  prompt: "一只在雨里跑步的猫",
  parameters: { model: "litellm:gpt-image-2", aspectRatio: "1:1", resolution: "1K" },
  inputs: [
    { assetId: "asset-a", role: "reference_image", storageKey: "sha256-" + "a".repeat(64), mediaType: "image/png" }
  ]
};

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("CanvasTaskRequest DTO", () => {
  it("JSON 往返后字段完全一致", () => {
    expect(roundTrip(REQUEST)).toEqual(REQUEST);
  });

  it("参考输入只包含稳定媒体引用", () => {
    const serialized = JSON.stringify(REQUEST);
    for (const forbidden of ["blob:", "data:", "base64", "http://", "https://", "bytes"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(REQUEST.inputs[0]!).sort()).toEqual([
      "assetId",
      "mediaType",
      "role",
      "storageKey"
    ]);
  });
});

describe("referenceInputCapabilityFromDescription", () => {
  it("从显式 referenceInput.bindings 读取（旧图片字段不再生效）", () => {
    const capability = referenceInputCapabilityFromDescription({
      capabilities: {
        // 旧字段被忽略：只有 bindings 生效。
        referenceInput: {
          acceptsImages: true,
          roles: ["first_frame"],
          maxItems: 2,
          mediaTypes: ["image/png"],
          bindings: [
            { field: "referenceImages", semantic: "reference-image", roles: ["first_frame"], maxItems: 2, mediaTypes: ["image/png"] }
          ]
        }
      }
    });
    expect(capability).toMatchObject({
      acceptsImages: true,
      roles: ["first_frame"],
      maxItems: 2,
      mediaTypes: ["image/png"]
    });
    expect(capability.bindings).toEqual([
      {
        field: "referenceImages",
        semantic: "reference-image",
        roles: ["first_frame"],
        mediaKinds: ["image"],
        mediaTypes: ["image/png"],
        maxItems: 2,
        valueFormat: "url"
      }
    ]);
  });

  it("仅旧图片字段而无 bindings 时不再合成能力", () => {
    const capability = referenceInputCapabilityFromDescription({
      capabilities: { referenceInput: { acceptsImages: true, maxItems: 4 } }
    });
    expect(capability.bindings).toEqual([]);
    expect(capability.acceptsImages).toBe(false);
    expect(capability.maxItems).toBe(0);
  });

  it("从 litellm 式 schema 语义标记推导上限", () => {
    const capability = referenceInputCapabilityFromDescription({
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          urls: { type: "array", maxItems: 16, "x-pptask-semantic": "reference-image" }
        }
      }
    });
    expect(capability.acceptsImages).toBe(true);
    expect(capability.maxItems).toBe(16);
  });

  it("schema 上限被全局上限夹紧", () => {
    const capability = referenceInputCapabilityFromDescription({
      inputSchema: {
        properties: {
          urls: { type: "array", maxItems: 999, "x-pptask-semantic": "reference-image" }
        }
      }
    });
    expect(capability.maxItems).toBe(CANVAS_TASK_LIMITS.maxReferences);
  });

  it("没有参考图声明时为不接受", () => {
    const capability = referenceInputCapabilityFromDescription({
      inputSchema: { properties: { prompt: { type: "string" } } }
    });
    expect(capability.acceptsImages).toBe(false);
    expect(capability.maxItems).toBe(0);
  });

  it("上限是正数（默认值 canary）", () => {
    expect(CANVAS_TASK_LIMITS.promptMaxChars).toBeGreaterThan(0);
    expect(CANVAS_TASK_LIMITS.maxImageOutputBytes).toBeGreaterThan(0);
  });
});
