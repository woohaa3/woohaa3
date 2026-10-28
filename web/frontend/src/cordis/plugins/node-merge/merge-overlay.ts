/**
 * 合并目标 DOM 高亮（change: 2026-10-27-merge-same-type-node-history，任务 2.3 / design D2）。
 *
 * 只在浏览器 DOM 画一层描边与文案，不进 Render Scene / 协议：高亮是瞬时 UI，不参与渲染调度、
 * 不进入截图或导出。目标矩形取自共享节点索引的 `mergeRectsByType`（已排除折叠组隐藏节点、
 * 使用有效尺寸），经 `worldToClient` 换算成屏幕矩形；viewport/画布变化时由插件重新调用
 * `update` 重算，候选消失（节点删除/被托管/折叠）立即移除。
 *
 * 本模块不拦截指针输入，也不持有拖动生命周期。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import type { CanvasRuntimeService } from "../../contract/canvas-runtime.js";
import type { NodeMergeDrag } from "../../services/node-merge/index.js";
import { sharedCanvasNodeIndex } from "../canvas-shell/canvas-node-index.js";
import "./merge-overlay.css";

/** 高亮文案：不承诺一定成功（服务端仍可能以进行中生成/会话拒绝，design Risks）。 */
export const NODE_MERGE_OVERLAY_LABEL = "松手合并到此节点";

export type NodeMergeOverlayDeps = Pick<CanvasRuntimeService, "worldToClient">;

type OverlayElement = {
  container: HTMLDivElement;
  label: HTMLSpanElement;
};

export function createNodeMergeOverlay(deps: NodeMergeOverlayDeps) {
  let root: HTMLDivElement | null = null;
  let element: OverlayElement | null = null;
  const clear = () => {
    root?.remove();
    root = null;
    element = null;
  };
  return {
    clear,
    update(canvas: ServerCanvas | null, drag: NodeMergeDrag | null) {
      if (!canvas || !drag || drag.sourceNodeIds.length !== 1 || typeof document === "undefined") {
        clear();
        return;
      }
      const index = sharedCanvasNodeIndex(canvas);
      const target = index?.byId.get(drag.targetNodeId);
      if (!index || !target) {
        clear();
        return;
      }
      // 只认索引里的合并候选桶：目标被删除、被托管或折叠隐藏时自然不再命中。
      const rect = (index.mergeRectsByType.get(target.type) ?? [])
        .find((entry) => entry.nodeId === target.id);
      if (!rect) {
        clear();
        return;
      }
      const topLeft = deps.worldToClient({ x: rect.x, y: rect.y });
      const bottomRight = deps.worldToClient({ x: rect.x + rect.width, y: rect.y + rect.height });
      if (!topLeft || !bottomRight) {
        clear();
        return;
      }
      const left = Math.min(topLeft.x, bottomRight.x);
      const top = Math.min(topLeft.y, bottomRight.y);
      const width = Math.max(1, Math.abs(bottomRight.x - topLeft.x));
      const height = Math.max(1, Math.abs(bottomRight.y - topLeft.y));
      if (!root) {
        root = document.createElement("div");
        root.className = "node-merge-overlays";
        document.body.appendChild(root);
      }
      if (!element) {
        element = createElement();
        root.appendChild(element.container);
      }
      if (element.container.dataset.nodeId !== drag.targetNodeId) {
        element.container.dataset.nodeId = drag.targetNodeId;
      }
      const style = { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` };
      for (const key of ["left", "top", "width", "height"] as const) {
        if (element.container.style[key] !== style[key]) element.container.style[key] = style[key];
      }
      // 只写净变化：同帧合并的重复更新不得产生 DOM mutation。
      if (element.label.textContent !== NODE_MERGE_OVERLAY_LABEL) {
        element.label.textContent = NODE_MERGE_OVERLAY_LABEL;
      }
    }
  };
}

function createElement(): OverlayElement {
  const container = document.createElement("div");
  container.className = "node-merge-overlay";
  const label = document.createElement("span");
  label.className = "node-merge-overlay-label";
  container.appendChild(label);
  return { container, label };
}
