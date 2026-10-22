/**
 * Prompt snippet DTO / codec 契约测试（change: add-prompt-snippet-library，任务 1.1）。
 */
import { describe, expect, it } from "vitest";
import {
  decodePromptSnippet,
  decodePromptSnippetListQuery,
  normalizePromptSnippetName,
  promptSnippetNameKey,
  PROMPT_SNIPPET_FORMAT_VERSION,
  type PromptSnippet
} from "./dto.js";
import {
  captureNodePromptAsSnippetBody,
  materializeSnippetBody,
  validateSnippetBodyMaterials,
  type TargetInputMapping
} from "./codec.js";

const CHECKSUM = "a".repeat(64);

function snippet(overrides: Partial<PromptSnippet> = {}): PromptSnippet {
  return {
    id: "psnip-1",
    formatVersion: PROMPT_SNIPPET_FORMAT_VERSION,
    builtIn: false,
    name: "片段",
    body: "普通文本",
    materials: [],
    tagIds: [],
    revision: 1,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    ...overrides
  };
}

describe("decodePromptSnippet", () => {
  it("合法片段往返一致", () => {
    const decoded = decodePromptSnippet(snippet());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(JSON.parse(JSON.stringify(decoded.value))).toEqual(decoded.value);
  });

  it("拒绝任意 URL、签名 URL 与非法 storageKey", () => {
    const bad = snippet({
      materials: [
        {
          key: "material-1",
          mediaKind: "image",
          assetId: "a1",
          storageKey: "https://cos.example/sign?x=1",
          checksum: CHECKSUM,
          contentType: "image/png",
          size: 1,
          label: "图"
        }
      ]
    });
    expect(decodePromptSnippet(bad).ok).toBe(false);
  });

  it("拒绝重复 material key", () => {
    const media = {
      key: "material-1",
      mediaKind: "image" as const,
      assetId: "a1",
      storageKey: `sha256-${CHECKSUM}`,
      checksum: CHECKSUM,
      contentType: "image/png",
      size: 1,
      label: "图"
    };
    const decoded = decodePromptSnippet(snippet({ materials: [media, { ...media }] }));
    expect(decoded.ok).toBe(false);
  });
});

describe("名称规范化", () => {
  it("去除首尾空白、压缩内部空白、大小写无关唯一键", () => {
    expect(normalizePromptSnippetName("  hello   world  ")).toBe("hello world");
    expect(normalizePromptSnippetName("   ")).toBeNull();
    expect(promptSnippetNameKey("Hello")).toBe(promptSnippetNameKey("hello"));
  });
});

describe("decodePromptSnippetListQuery", () => {
  it("非法筛选回落 all，limit 钳制", () => {
    expect(decodePromptSnippetListQuery({ filter: "bogus", limit: 9999 })).toMatchObject({ filter: "all", limit: 100 });
    expect(decodePromptSnippetListQuery({ filter: "tag", tagId: "t1" })).toMatchObject({ filter: "tag", tagId: "t1" });
  });
});

describe("capture / validate / materialize 往返", () => {
  it("捕获把 slot token 重写为局部 material key", () => {
    const capture = captureNodePromptAsSnippetBody({
      prompt: "参考 {{input_image:slot-a:图片 1}} 和普通文本",
      resolveSlot: (id) =>
        id === "slot-a"
          ? {
              mediaKind: "image",
              assetId: "a1",
              storageKey: `sha256-${CHECKSUM}`,
              checksum: CHECKSUM,
              contentType: "image/png",
              size: 1,
              label: "图片 1"
            }
          : null
    });
    expect(capture.materials).toHaveLength(1);
    expect(capture.body).toContain("{{input_image:material-1:图片 1}}");
    expect(capture.body).not.toContain("slot-a");
    expect(capture.unresolved).toHaveLength(0);
  });

  it("无法权威解析的 slot 降级为可读文本并进入 unresolved", () => {
    const capture = captureNodePromptAsSnippetBody({
      prompt: "{{input_image:slot-x:图}}",
      resolveSlot: () => null
    });
    expect(capture.body).toBe("@图");
    expect(capture.unresolved).toHaveLength(1);
  });

  it("正文-material 双向一致性", () => {
    const material = {
      key: "material-1",
      mediaKind: "image" as const,
      assetId: "a1",
      storageKey: `sha256-${CHECKSUM}`,
      checksum: CHECKSUM,
      contentType: "image/png",
      size: 1,
      label: "图"
    };
    expect(validateSnippetBodyMaterials("{{input_image:material-1:图}}", [material])).toEqual({ ok: true });
    expect(validateSnippetBodyMaterials("无 token", [material]).ok).toBe(false);
    expect(validateSnippetBodyMaterials("{{input_image:material-1:图}}", []).ok).toBe(false);
    expect(validateSnippetBodyMaterials("{{input_audio:material-1:图}}", [material]).ok).toBe(false);
  });

  it("应用期只把稳定身份匹配的 direct mapping 转回 slot token，其余降级为 @label", () => {
    const imageMaterial = {
      key: "material-1",
      mediaKind: "image" as const,
      assetId: "a1",
      storageKey: `sha256-${CHECKSUM}`,
      checksum: CHECKSUM,
      contentType: "image/png",
      size: 1,
      label: "已连接图"
    };
    const audioMaterial = {
      key: "material-2",
      mediaKind: "audio" as const,
      assetId: "a2",
      storageKey: `sha256-${"b".repeat(64)}`,
      checksum: "b".repeat(64),
      contentType: "audio/mpeg",
      size: 1,
      label: "未连接音频"
    };
    const mappings: TargetInputMapping[] = [
      { slotId: "slot-img", role: "reference_image", assetId: "a1", storageKey: `sha256-${CHECKSUM}`, contentKind: "image" }
    ];
    const result = materializeSnippetBody({
      body: "{{input_image:material-1:已连接图}} 与 {{input_audio:material-2:未连接音频}}",
      materials: [imageMaterial, audioMaterial],
      targetMappings: mappings
    });
    expect(result.body).toContain("{{input_image:slot-img:已连接图}}");
    expect(result.body).toContain("@未连接音频");
    expect(result.diagnostics).toEqual([
      { materialKey: "material-2", label: "未连接音频", reason: "unresolved" }
    ]);
  });

  it("同名不同资产不按标签绑定", () => {
    const material = {
      key: "material-1",
      mediaKind: "image" as const,
      assetId: "a1",
      storageKey: `sha256-${CHECKSUM}`,
      checksum: CHECKSUM,
      contentType: "image/png",
      size: 1,
      label: "图"
    };
    const mappings: TargetInputMapping[] = [
      { slotId: "slot-x", role: "reference_image", assetId: "different", storageKey: `sha256-${"c".repeat(64)}`, contentKind: "image" }
    ];
    const result = materializeSnippetBody({
      body: "{{input_image:material-1:图}}",
      materials: [material],
      targetMappings: mappings
    });
    expect(result.body).toBe("@图");
    expect(result.diagnostics[0]?.reason).toBe("unresolved");
  });
});
