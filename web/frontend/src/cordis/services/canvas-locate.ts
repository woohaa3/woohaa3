/**
 * 统一节点定位服务（change: 2026-10-09-improve-canvas-workflow，任务 4.1 / design D6）。
 *
 * 搜索定位、任务定位与「定位当前作品」共用：取规范结构的世界坐标与有效渲染尺寸，
 * 用现有本地视口在可用画布矩形居中容纳并留边距，避让打开的 DOM 面板，遵守缩放范围。
 * 只改本地 selection/viewport，不写规范 viewport、不提交命令；只读仍可定位。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import { computeCenteredViewport, nodeWorldRect, unionRects, type Rect } from "@woohaa3/contracts";
import type { InteractionController } from "../plugins/canvas-shell/interaction-types.js";

export type LocateNodesResult =
  | { ok: true }
  | { ok: false; reason: string };

export type CanvasLocateService = {
  /**
   * 定位一批节点：`select=false` 时不改选区（例如定位当前多选）。
   * 默认保持缩放居中；fit 显式按实际呈现边界容纳整批节点。
   * 返回 `ok:false` 表示目标已失效或宿主未就绪，不改变视口。
   */
  locateNodes(nodeIds: readonly string[], options?: { select?: boolean; fit?: boolean; safeArea?: {left:number;top:number;right:number;bottom:number} }): LocateNodesResult;
  /** 定位当前选区中心（不改选区）。 */
  locateSelection(nodeIds: readonly string[]): LocateNodesResult;
};

export type CanvasLocateOptions = {
  getCanvas: () => ServerCanvas | null;
  getController: () => InteractionController | null;
  /** 可用画布矩形尺寸；缺省用 controller.surface()。 */
  surface?: () => { width: number; height: number } | null;
  /** 打开 DOM 面板造成的遮挡（像素，相对宿主）。 */
  safeArea?: () => { left: number; top: number; right: number; bottom: number };
  /** Accepted Render Scene world bounds; fit waits if any target is missing. */
  renderBounds?: () => readonly ({id:string} & Rect)[] | null;
  /**
   * 带动画地平移视口到目标（保持缩放）。缺省回退到即时 restoreViewport。
   * 由控制器提供（利用其 rAF 调度与减少动态效果门禁）。
   */
  panViewportTo?: (viewport: { x: number; y: number; zoom: number }) => void;
};

export function createCanvasLocateService(options: CanvasLocateOptions): CanvasLocateService {
  return {
    locateNodes(nodeIds, settings = {}) {
      const canvas = options.getCanvas();
      const controller = options.getController();
      if (!canvas || !controller) return { ok: false, reason: "画布尚未就绪" };
      const byId = new Map(canvas.document.nodes.map((node) => [node.id, node]));
      const nodes = nodeIds.map((id) => byId.get(id));
      if (nodes.length === 0) return { ok: false, reason: "没有可定位的作品" };
      if (nodes.some((node) => node === undefined)) {
        return { ok: false, reason: "目标作品已不存在" };
      }
      const visibleNodes = nodes.map(node => node!);
      const rects: Rect[] = visibleNodes.map(node => nodeWorldRect(node, byId));
      if (settings.fit && options.renderBounds) {
        const rendered = new Map(options.renderBounds()?.map(node => [node.id,node]));
        if (nodeIds.some(id => !rendered.has(id))) return {ok:false,reason:"场景边界尚未就绪"};
        rects.splice(0,rects.length,...nodeIds.map(id => rendered.get(id)!));
      }
      const bounds = unionRects(rects);
      if (!bounds) return { ok: false, reason: "目标作品没有有效尺寸" };
      const hostSize = options.surface?.() ?? controller.surface();
      const safe = settings.safeArea ?? options.safeArea?.() ?? {left:0,top:0,right:0,bottom:0};
      const width = (hostSize?.width ?? 0)-safe.left-safe.right;
      const height = (hostSize?.height ?? 0)-safe.top-safe.bottom;
      if (width <= 0 || height <= 0) return {ok:false,reason:"可用画布区域太小"};
      const zoom = settings.fit ? Math.min(width/bounds.width,height/bounds.height) : controller.viewport().zoom;
      const viewport = computeCenteredViewport({
        bounds,
        hostSize: hostSize ? { width: hostSize.width, height: hostSize.height } : null,
        zoom,
        safeArea: safe
      });
      if (!viewport) return { ok: false, reason: "当前视口不可用于定位" };
      if (settings.select !== false) {
        controller.selectNode(visibleNodes[0]!.id);
      }
      if (options.panViewportTo) options.panViewportTo(viewport);
      else controller.restoreViewport(viewport);
      return { ok: true };
    },
    locateSelection(nodeIds) {
      return this.locateNodes(nodeIds, { select: false });
    }
  };
}

