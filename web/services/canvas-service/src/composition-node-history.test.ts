/**
 * 模型编辑历史登记（change: 模型编辑历史）。
 *
 * 验证命令提交观察者只对「模型节点 + 已提交 modelPlacement patch」留档编辑版本，
 * 且不处理其它命令/节点。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { recordModelPlacementHistory } from "./composition.js";

const CANVAS = "canvas-1";
const NOW = "2026-09-27T00:00:00.000Z";

function canvasWithModel(placement: Record<string, unknown> | null = null): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  return {
    ...base,
    revision: 2,
    document: {
      ...base.document,
      nodes: [
        { id: "model-1", type: "model3d", position: { x: 0, y: 0 }, width: 248, height: 232 },
        { id: "image-1", type: "image", position: { x: 300, y: 0 }, width: 248, height: 232 }
      ]
    },
    nodeData: {
      "model-1": {
        title: "M",
        modelScript: "build(()=>{})",
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        ...(placement ? { modelPlacement: placement } : {})
      },
      "image-1": { title: "I" }
    }
  } as ServerCanvas;
}

function fakeNodeHistory() {
  const record = vi.fn(async () => ({ ok: true as const, status: "inserted" as const, entryId: "ngh-x" }));
  return { service: { recordCurrentModelVersion: record }, record };
}

describe("recordModelPlacementHistory", () => {
  it("模型节点 + modelPlacement patch → 留档一条编辑版本", async () => {
    const { service, record } = fakeNodeHistory();
    await recordModelPlacementHistory({ service }, {
      canvasId: CANVAS,
      canvas: canvasWithModel({ offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 }),
      commands: [{ type: "nodeData.patch", nodeId: "model-1", value: { modelPlacement: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 } } }]
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ canvasId: CANVAS, nodeId: "model-1" });
  });

  it("非模型节点或非 placement 命令不留档", async () => {
    const { service, record } = fakeNodeHistory();
    await recordModelPlacementHistory({ service }, {
      canvasId: CANVAS,
      canvas: canvasWithModel(null),
      commands: [
        { type: "nodeData.patch", nodeId: "image-1", value: { modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } } },
        { type: "nodeData.patch", nodeId: "model-1", value: { title: "x" } },
        { type: "node.add", node: { id: "n2", type: "image", position: { x: 0, y: 0 } } }
      ]
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("nodeHistory 缺失时安全 no-op", async () => {
    await expect(
      recordModelPlacementHistory(null, { canvasId: CANVAS, canvas: canvasWithModel(), commands: [] })
    ).resolves.toBeUndefined();
  });

  it("活跃编辑会话内抑制逐手势用户历史（change: 图片聚焦编辑，design D5/D6）", async () => {
    const { service, record } = fakeNodeHistory();
    const hasActiveSession = vi.fn(async () => true);
    await recordModelPlacementHistory(
      { service, hasActiveSession },
      {
        canvasId: CANVAS,
        canvas: canvasWithModel({ offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 }),
        commands: [{ type: "nodeData.patch", nodeId: "model-1", value: { modelPlacement: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 } } }]
      }
    );
    expect(hasActiveSession).toHaveBeenCalledWith(CANVAS, "model-1");
    expect(record).not.toHaveBeenCalled();
  });

  it("未关联会话的外部模型写入保持既有来源历史（design D5）", async () => {
    const { service, record } = fakeNodeHistory();
    const hasActiveSession = vi.fn(async () => false);
    await recordModelPlacementHistory(
      { service, hasActiveSession },
      {
        canvasId: CANVAS,
        canvas: canvasWithModel({ offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 }),
        commands: [{ type: "nodeData.patch", nodeId: "model-1", value: { modelPlacement: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 } } }]
      }
    );
    expect(record).toHaveBeenCalledTimes(1);
  });
});
