/**
 * 模型 placement 预览解析
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 interaction-controller 拆出）。
 *
 * 合并输入期 gesture preview 与 working 权威值：working projection 已含相同值即丢弃 preview。
 */
import type { BevyModelPlacement } from "@woohaa3/contracts";
import { parameterPreviewStore } from "../../services/parameter-preview.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";

/** 从规范 nodeData 读取参考格式的 modelPlacement。 */
export function readCanonicalPlacement(nodeData: unknown): BevyModelPlacement | null {
  if (!nodeData || typeof nodeData !== "object") return null;
  const placement = (nodeData as { modelPlacement?: unknown }).modelPlacement;
  if (!placement || typeof placement !== "object") return null;
  const record = placement as Record<string, unknown>;
  const offset = (record.offset as Record<string, unknown> | undefined) ?? {};
  return {
    offset: { x: Number(offset.x) || 0, y: Number(offset.y) || 0, z: Number(offset.z) || 0 },
    scale: typeof record.scale === "number" ? record.scale : 1,
    yaw: typeof record.yaw === "number" ? record.yaw : 0
  };
}

export function placementsEqual(a: BevyModelPlacement, b: BevyModelPlacement): boolean {
  return (
    Math.abs(a.offset.x - b.offset.x) < 1e-6 &&
    Math.abs(a.offset.y - b.offset.y) < 1e-6 &&
    Math.abs(a.offset.z - b.offset.z) < 1e-6 &&
    Math.abs(a.scale - b.scale) < 1e-6 &&
    Math.abs(a.yaw - b.yaw) < 1e-6
  );
}

/** 输入期 gesture draft 优先；提交后由 pending nodeData.patch（working projection）接管。 */
export function collectModelPlacements(): ReadonlyMap<string, BevyModelPlacement> {
  const map = new Map<string, BevyModelPlacement>();
  const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
  for (const [nodeId, entry] of parameterPreviewStore.entries()) {
    const placement = entry.patch.modelPlacement;
    if (!placement) continue;
    const workingPlacement = readCanonicalPlacement(canvasState?.nodeData?.[nodeId]);
    // working projection 已含相同值：丢弃 gesture preview，避免重复。
    if (workingPlacement && placementsEqual(workingPlacement, placement)) {
      parameterPreviewStore.resolve(nodeId);
      continue;
    }
    map.set(nodeId, placement);
  }
  return map;
}
