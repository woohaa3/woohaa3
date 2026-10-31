/**
 * DOM drop 目标提示（change: 2026-10-10-add-game-furnace-extension，任务 4.4；
 *  change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5；
 *  change: 2026-10-18-restrict-film-set-drop-to-models）。
 *
 * 拖动期间按 **accepted** 范围几何绘制提示：复合资产菱形用 SVG polygon 描边（四顶点经统一
 * `worldToClient` 转换），其它复合资产（含炉体）的平行四边形同样来自同一公式。展开 group 的
 * 徽标也作为 accepted 范围条目；命中最上层成员卡片时点亮它的容器。目标 identity 由 accepted
 * `queryDropTarget` 固定；查询不可用时隐藏全部提示，**不**回退 TS 矩形几何或猜测目标。接收方
 * 声明 `acceptsSources` 且这批来源不被接收时，该目标不绘制提示。
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
  svg: SVGSVGElement;
  polygon: SVGPolygonElement;
  label: HTMLSpanElement;
};

/** 提示定位与几何读取依赖（accepted query + world→client 换算）。 */
export type NodeDropOverlayDeps = Pick<
  CanvasRuntimeService,
  "worldToClient" | "queryCompositeAssetScopes" | "queryDropTarget"
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
      // 几何与目标使用同一 accepted generation；范围读取不可用时隐藏旧提示，等待 dirty 刷新。
      const scopesResult = deps.queryCompositeAssetScopes();
      if (!scopesResult.ok) { clear(); return; }
      const excluded = new Set(drag.sourceNodeIds);
      const targetResult = deps.queryDropTarget(drag.point, drag.sourceNodeIds);
      const activeId = targetResult.ok ? targetResult.value : null;
      const visible = new Set<string>();
      const byId = new Map(canvas.document.nodes.map((entry) => [entry.id, entry]));
      for (const scope of scopesResult.value) {
        if (excluded.has(scope.nodeId)) continue;
        const node = byId.get(scope.nodeId);
        if (!node) continue;
        // 来源全部已经在目标 group 里：松手是组内移动，不是拖入复制，不绘制接收提示。
        if (node.type === "group" && drag.sourceNodeIds.length > 0
          && drag.sourceNodeIds.every((id) => isDescendantOf(byId, id, scope.nodeId))) continue;
        let owners: NodeDropTarget[] = [];
        try {
          owners = targets.filter((target) => target.nodeType === node.type
            && (!target.matchesTarget || target.matchesTarget({ canvas, targetNodeId: node.id })));
        } catch { /* Invalid extension ownership must not interrupt the pointer lifecycle. */ }
        // 没有接收方的复合节点不是素材容器，不展示接收提示。
        if (!owners.length) continue;
        const owner = owners.length === 1 ? owners[0] : undefined;
        // 该接收方不接受这批来源时不点亮目标、不显示接收提示
        // （change: 2026-10-18-restrict-film-set-drop-to-models）。
        if (owner && !ownerAcceptsSources(owner, canvas, node.id, drag.sourceNodeIds)) continue;
        // 四顶点统一 world→client；任一转换失败（未挂载控制器）跳过该提示。
        const clients = scope.vertices
          .map(([x, y]) => deps.worldToClient({ x, y }))
          .filter((point): point is { x: number; y: number } => point !== null);
        if (clients.length !== 4) continue;
        if (!root) {
          root = document.createElement("div");
          root.className = "node-drop-overlays";
          document.body.appendChild(root);
        }
        let element = elements.get(scope.nodeId);
        if (!element) {
          element = createElement(scope.nodeId);
          root.appendChild(element.container);
          elements.set(scope.nodeId, element);
        }
        const xs = clients.map((point) => point.x);
        const ys = clients.map((point) => point.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const width = Math.max(1, Math.max(...xs) - minX);
        const height = Math.max(1, Math.max(...ys) - minY);
        // 仅写净变化：同帧合并的重复更新不得产生 DOM mutation（任务 A2.4）。
        const points = clients.map((point) => `${point.x},${point.y}`).join(" ");
        if (element.polygon.getAttribute("points") !== points) element.polygon.setAttribute("points", points);
        const viewBox = `${minX} ${minY} ${width} ${height}`;
        if (element.svg.getAttribute("viewBox") !== viewBox) element.svg.setAttribute("viewBox", viewBox);
        const style = { left: `${minX}px`, top: `${minY}px`, width: `${width}px`, height: `${height}px` };
        for (const key of ["left", "top", "width", "height"] as const) {
          if (element.container.style[key] !== style[key]) element.container.style[key] = style[key];
        }
        // 命中成员卡片时，接收方实际上是它的容器 group：提示应点亮容器范围，
        // 而不是因为最上层 identity 是成员就熄灭。
        const active = activeId !== null && (activeId === scope.nodeId
          || isDescendantOf(byId, activeId, scope.nodeId));
        const feedback = active
          ? previewNodeDrop(targets, canvas, drag.sourceNodeIds, { status: "target", nodeId: scope.nodeId })
          : null;
        const text = feedback ?? owner?.dropLabel ?? "放到此处加入素材";
        if (element.label.textContent !== text) element.label.textContent = text;
        const activeState = String(active);
        if (element.container.dataset.active !== activeState) element.container.dataset.active = activeState;
        const unavailable = String(Boolean(feedback) || !owner);
        if (element.container.dataset.unavailable !== unavailable) element.container.dataset.unavailable = unavailable;
        if (element.container.dataset.shape !== scope.shape) element.container.dataset.shape = scope.shape;
        visible.add(scope.nodeId);
      }
      for (const [id, element] of elements) {
        if (!visible.has(id)) { element.container.remove(); elements.delete(id); }
      }
      if (!elements.size) clear();
    },
  };
}

function isDescendantOf(
  byId: ReadonlyMap<string, { parentId?: string }>,
  nodeId: string,
  ancestorId: string
): boolean {
  const seen = new Set<string>([nodeId]);
  let current = byId.get(nodeId);
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    if (seen.has(current.parentId)) return false;
    seen.add(current.parentId);
    current = byId.get(current.parentId);
  }
  return false;
}

function createElement(nodeId: string): OverlayElement {
  const container = document.createElement("div");
  container.className = "node-drop-overlay";
  container.dataset.nodeId = nodeId;
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("preserveAspectRatio", "none");
  const polygon = document.createElementNS(namespace, "polygon");
  polygon.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(polygon);
  const label = document.createElement("span");
  label.className = "node-drop-overlay-label";
  container.append(svg, label);
  return { container, svg, polygon, label };
}
