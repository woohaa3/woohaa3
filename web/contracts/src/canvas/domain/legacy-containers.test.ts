import { describe, expect, it } from "vitest";
import { normalizeCanvas } from "./normalization.js";
import { createEmptyWoohaa3ServerCanvas } from "./aggregate.js";

const NOW = "2026-10-31T00:00:00.000Z";

/** 旧文档：组 + 成员 + 片场组 + 拍摄镜头预览。 */
function legacyCanvas() {
  const canvas = createEmptyWoohaa3ServerCanvas("legacy", NOW);
  canvas.document.nodes = [
    { id: "g", type: "group", position: { x: 100, y: 100 }, width: 400, height: 300 },
    { id: "member", type: "image", position: { x: 20, y: 30 }, width: 200, height: 120, parentId: "g" },
    { id: "nested", type: "text", position: { x: 10, y: 10 }, parentId: "member" },
    { id: "preview", type: "film-set-shot-preview", position: { x: 0, y: 0 } },
    { id: "plain", type: "video", position: { x: 600, y: 0 } }
  ];
  canvas.nodeData = {
    g: { title: "组", groupCollapsed: true, groupAppearance: { schemaVersion: 1 } },
    member: { title: "成员", groupAppearance: { schemaVersion: 1 } },
    nested: { title: "嵌套" },
    preview: { shotPreview: { filmSetNodeId: "g" } },
    plain: { title: "普通视频" }
  } as never;
  return canvas;
}

describe("旧容器读取期迁移（change: remove-canvas-groups-and-film-set）", () => {
  it("组被溶解、成员提升为顶层并保留绝对位置", () => {
    const normalized = normalizeCanvas(legacyCanvas());
    const ids = normalized.document.nodes.map((node) => node.id);

    expect(ids).not.toContain("g");
    expect(normalized.document.nodes.every((node) => node.parentId === undefined)).toBe(true);

    const member = normalized.document.nodes.find((node) => node.id === "member")!;
    expect(member.position).toEqual({ x: 120, y: 130 });
    const nested = normalized.document.nodes.find((node) => node.id === "nested")!;
    expect(nested.position).toEqual({ x: 130, y: 140 });
  });

  it("拍摄镜头预览与组/片场专用 nodeData 字段被共享清理", () => {
    const normalized = normalizeCanvas(legacyCanvas());

    expect(normalized.document.nodes.some((node) => node.type === "film-set-shot-preview")).toBe(false);
    expect(normalized.nodeData.preview).toBeUndefined();
    expect(normalized.nodeData.g).toBeUndefined();
    expect(normalized.nodeData.member).toEqual({ title: "成员" });
    expect(normalized.nodeData.plain).toEqual({ title: "普通视频" });
  });

  it("迁移幂等：再次规范化不改变文档与内容", () => {
    const once = normalizeCanvas(legacyCanvas());
    const twice = normalizeCanvas(once);

    expect(twice.document.nodes).toEqual(once.document.nodes);
    expect(twice.nodeData).toEqual(once.nodeData);
  });

  it("旧 composite 片场物化为普通卡片后删除容器", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("legacy-composite", NOW);
    canvas.document.nodes = [{ id: "film", type: "composite-asset", position: { x: 40, y: 50 } }];
    canvas.nodeData = {
      film: {
        extensionId: "film-set",
        title: "片场",
        filmSetContent: {
          items: [
            { id: "hero", kind: "model", name: "主角", model: { modelScript: "", modelScriptVersion: "woohaa-model-js-v2" } },
            { id: "poster", kind: "image", name: "海报", assetId: "asset-1" }
          ]
        }
      }
    } as never;

    const normalized = normalizeCanvas(canvas);
    expect(normalized.document.nodes.some((node) => node.id === "film")).toBe(false);
    const model = normalized.document.nodes.find((node) => node.type === "model3d")!;
    expect(model).toBeDefined();
    expect(normalized.document.nodes.find((node) => node.type === "image")).toBeDefined();
    expect(normalized.nodeData[model.id]).toMatchObject({ title: "主角" });
  });
});
