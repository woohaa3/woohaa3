/**
 * 宿主默认图片聚焦目标解析测试（change: default-image-focus-viewer）。
 *
 * 这里防的是一类**回归**：图片聚焦目标曾经只由图片编辑器扩展写入 `setImageFocusTargets`。
 * 扩展未安装/未启用时集合恒为空，导航层会把每次双击图片判成 `focus-target-invalid`
 * （「聚焦目标不可用」）。宿主的 canonical 判定必须与扩展侧同义，才能作为兜底。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { imageFocusTargetIds, imageFocusTargetValid, isImageFocusTarget, resolveImageFocusTarget } from "./image-focus-target.js";

/** 造一个最小画布：单个图片节点 + 一个资产。 */
function canvasWith(overrides: {
  nodeType?: string;
  status?: string;
  mediaKind?: string;
  url?: string | null;
  outputAssetId?: string | null;
} = {}) {
  const base = createEmptyWoohaa3ServerCanvas("canvas-1", "2026-10-28T00:00:00.000Z");
  const outputAssetId = overrides.outputAssetId === undefined ? "asset-1" : overrides.outputAssetId;
  const url = overrides.url === undefined ? "/api/media/canvas-1/asset-1.png" : overrides.url;
  return {
    ...base,
    document: { ...base.document, nodes: [{ id: "node-1", type: overrides.nodeType ?? "image", position: { x: 0, y: 0 } }] },
    nodeData: { "node-1": outputAssetId === null ? {} : { outputAssetId } },
    assets: [{
      id: "asset-1",
      title: "图片",
      source: "uploaded" as const,
      status: (overrides.status ?? "ready") as never,
      mediaKind: (overrides.mediaKind ?? "image") as never,
      createdAt: "2026-10-28T00:00:00.000Z",
      ...(url === null ? {} : { url })
    }]
  } as unknown as ServerCanvas;
}

describe("宿主默认图片聚焦目标", () => {
  it("已就绪的图片节点可聚焦，并解析出受控同源地址", () => {
    const target = resolveImageFocusTarget(canvasWith(), "node-1");
    expect(target).not.toBeNull();
    expect(target?.url).toContain("/api/media/canvas-1/asset-1.png");
    expect(isImageFocusTarget(canvasWith(), "node-1")).toBe(true);
  });

  it("非图片节点、未就绪资产、非图片媒体类型、缺输出都不可聚焦", () => {
    expect(isImageFocusTarget(canvasWith({ nodeType: "model3d" }), "node-1")).toBe(false);
    expect(isImageFocusTarget(canvasWith({ status: "generating" }), "node-1")).toBe(false);
    expect(isImageFocusTarget(canvasWith({ mediaKind: "video" }), "node-1")).toBe(false);
    expect(isImageFocusTarget(canvasWith({ outputAssetId: null }), "node-1")).toBe(false);
    expect(isImageFocusTarget(canvasWith({ outputAssetId: "missing" }), "node-1")).toBe(false);
  });

  it("media 地址不受控时不可聚焦（外部/协议相对/路径回溯/缺失）", () => {
    for (const url of ["https://cdn.example.com/a.png", "//cdn/a.png", "/api/media/../a.png", "/other/a.png", null]) {
      expect(isImageFocusTarget(canvasWith({ url }), "node-1"), String(url)).toBe(false);
    }
  });

  it("空画布/未知节点不可聚焦", () => {
    expect(isImageFocusTarget(null, "node-1")).toBe(false);
    expect(isImageFocusTarget(canvasWith(), "nope")).toBe(false);
  });

  it("目标集合只含可聚焦图片节点，并保持节点顺序", () => {
    const base = createEmptyWoohaa3ServerCanvas("canvas-1", "2026-10-28T00:00:00.000Z");
    const canvas = {
      ...base,
      document: {
        ...base.document,
        nodes: [
          { id: "a", type: "image", position: { x: 0, y: 0 } },
          { id: "b", type: "model3d", position: { x: 0, y: 0 } },
          { id: "c", type: "image", position: { x: 0, y: 0 } },
          { id: "d", type: "image", position: { x: 0, y: 0 } }
        ]
      },
      nodeData: { a: { outputAssetId: "asset-a" }, c: { outputAssetId: "asset-c" }, d: { outputAssetId: "asset-pending" } },
      assets: [
        { id: "asset-a", title: "", source: "uploaded", status: "ready", mediaKind: "image", createdAt: "2026-10-28T00:00:00.000Z", url: "/api/media/x/a.png" },
        { id: "asset-c", title: "", source: "uploaded", status: "ready", mediaKind: "image", createdAt: "2026-10-28T00:00:00.000Z", url: "/api/media/x/c.png" },
        { id: "asset-pending", title: "", source: "uploaded", status: "generating", mediaKind: "image", createdAt: "2026-10-28T00:00:00.000Z", url: "/api/media/x/d.png" }
      ]
    } as never;
    expect(imageFocusTargetIds(canvas)).toEqual(["a", "c"]);
  });

  it("adapter 判定：扩展注册为空集合时回落到 canonical（这就是本次缺陷）", () => {
    // 图片编辑器扩展缺席 → 集合从未写入 → registered=false。旧实现直接返回 false，
    // 于是每次双击都得到「聚焦目标不可用」。
    expect(imageFocusTargetValid({ registered: false, canvas: canvasWith(), nodeId: "node-1" })).toBe(true);
    // 素材确实不可用时仍然拒绝（兜底不放宽 canonical 条件）。
    expect(imageFocusTargetValid({ registered: false, canvas: canvasWith({ status: "generating" }), nodeId: "node-1" })).toBe(false);
    expect(imageFocusTargetValid({ registered: false, canvas: null, nodeId: "node-1" })).toBe(false);
    // 扩展注册了目标 → 直接采信（扩展拥有自己的会话与校验）。
    expect(imageFocusTargetValid({ registered: true, canvas: null, nodeId: "node-1" })).toBe(true);
  });

  it("与图片编辑器扩展的判定同义：同一节点不会给出相反结论", () => {
    // 扩展侧（marketplace/extensions/photocraft/web/src/focus-targets.ts）的四条条件在这里逐条对齐：
    // 节点类型、outputAssetId、资产 ready+image、受控 /api/media/ 地址。
    const cases = [
      canvasWith(),
      canvasWith({ nodeType: "video" }),
      canvasWith({ status: "missing" }),
      canvasWith({ mediaKind: "audio" }),
      canvasWith({ url: "https://x/a.png" }),
      canvasWith({ outputAssetId: null })
    ];
    for (const canvas of cases) {
      const host = resolveImageFocusTarget(canvas as never, "node-1") !== null;
      expect(host).toBe(isImageFocusTarget(canvas as never, "node-1"));
    }
  });
});
