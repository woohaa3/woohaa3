/**
 * DOM drop 目标提示（change: 2026-10-10-add-game-furnace-extension，任务 4.4；
 *  change: remove-canvas-groups-and-film-set —— 只按节点矩形提示，不再有复合资产范围或组徽标）。
 *
 * 拖动期间按 **accepted** 目标查询绘制矩形提示；目标 identity 由 accepted
 * `queryDropTarget` 固定；查询不可用时隐藏全部提示，**不**回退 TS 猜测目标。接收方声明
 * `acceptsSources` 且这批来源不被接收时，该目标不绘制提示。
 *
 * 反馈状态（active/reject/unavailable）与文案保持既有语义；本模块不拦截指针输入。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import type { CanvasRuntimeService } from "../../contract/canvas-runtime.js";
import { ownerAcceptsSources, previewNodeDrop, type NodeDropTarget } from "../canvas-shell/node-drop-dispatch.js";
import "./drop-overlay.css";

type Drag = { sourceNodeIds: readonly string[]; point: { x: number; y: number } };

type OverlayElement = {
  container: HTMLDivElement;
  label: HTMLSpanElement;
};

/** 提示定位与目标查询依赖。 */
export type NodeDropOverlayDeps = Pick<
  CanvasRuntimeService,
  "worldToClient" | "queryDropTarget"
>;

/** Feedback shares the drag lifecycle and runtime coordinate conversion with the drop dispatcher. */
export function createNodeDropOverlay(deps: NodeDropOverlayDeps) {
  let root: HTMLDivElement | null = null;
  const elements = new Map<string, OverlayElement>();
  const clear = () => { root?.remove(); root = null; elements.clear(); };
  return {
    clear,
    update(canvas: ServerCanvas | null, targets: readonly NodeDropTarget[], drag: Drag | null) {
      if (!canvas || !drag || typeof document === "undefined") { clear(); return; }
      const excluded = new Set(drag.sourceNodeIds);
      const targetResult = deps.queryDropTarget(drag.point, drag.sourceNodeIds);
      const activeId = targetResult.ok ? targetResult.value : null;
      for (const node of canvas.document.nodes) {
        if (excluded.has(node.id)) continue;
        let owners: NodeDropTarget[] = [];
        try {
          owners = targets.filter((target) => target.nodeType === node.type
            && (!target.matchesTarget || target.matchesTarget({ canvas, targetNodeId: node.id })));
        } catch { /* Invalid extension ownership must not interrupt the pointer lifecycle. */ }
        // 没有接收方的节点不是素材容器，不展示接收提示。
        if (!owners.length) continue;
        const owner = owners.length === 1 ? owners[0] : undefined;
        // 该接收方不接受这批来源时不点亮目标、不显示接收提示。
        if (owner && !ownerAcceptsSources(owner, canvas, node.id, drag.sourceNodeIds)) continue;
        const topLeft = deps.worldToClient({ x: node.position.x, y: node.position.y });
        const bottomRight = deps.worldToClient({
          x: node.position.x + (node.width ?? 0),
          y: node.position.y + (node.height ?? 0)
        });
        if (!topLeft || !bottomRight) continue;
        if (!root) {
          root = document.createElement("div");
          root.className = "node-drop-overlays";
          document.body.appendChild(root);
        }
        let element = elements.get(node.id);
        if (!element) {
          element = createElement();
          root.appendChild(element.container);
          elements.set(node.id, element);
        }
        const minX = Math.min(topLeft.x, bottomRight.x);
        const minY = Math.min(topLeft.y, bottomRight.y);
        const width = Math.max(1, Math.abs(bottomRight.x - topLeft.x));
        const height = Math.max(1, Math.abs(bottomRight.y - topLeft.y));
        const style = { left: `${minX}px`, top: `${minY}px`, width: `${width}px`, height: `${height}px` };
        for (const key of ["left", "top", "width", "height"] as const) {
          if (element.container.style[key] !== style[key]) element.container.style[key] = style[key];
        }
        const active = activeId !== null && activeId === node.id;
        const feedback = active
          ? previewNodeDrop(targets, canvas, drag.sourceNodeIds, { status: "target", nodeId: node.id })
          : null;
        const text = feedback ?? owner?.dropLabel ?? "放到此处加入素材";
        if (element.label.textContent !== text) element.label.textContent = text;
        const activeState = String(active);
        if (element.container.dataset.active !== activeState) element.container.dataset.active = activeState;
      }
      for (const [nodeId, element] of elements) {
        if (!canvas.document.nodes.some((node) => node.id === nodeId)) {
          element.container.remove();
          elements.delete(nodeId);
        }
      }
    }
  };
}

function createElement(): OverlayElement {
  const container = document.createElement("div");
  container.className = "node-drop-overlay";
  const label = document.createElement("span");
  container.appendChild(label);
  return { container, label };
}
