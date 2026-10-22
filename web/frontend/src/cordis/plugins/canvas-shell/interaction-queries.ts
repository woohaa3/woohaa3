/**
 * 2D interaction 查询适配
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 4.1/4.2/4.3/5.4）。
 *
 * 把指针坐标/模式跨 WASM 边界交给 Rust interaction snapshot 命中，绝不重建 CanvasRenderScene、
 * 不采样边、不扫描全场景。generation 不匹配或运行时缺新导出时返回 `ok:false`；调用方 MUST NOT
 * 回退到已删除的 TS 几何实现。
 */
import type { BevyRuntime, ProbeCandidate } from "../canvas-runtime/bevy-runtime.js";
import type { HitTarget, Point } from "./hit-test.js";
import type { GizmoQuery } from "./model-gizmo-hit.js";
import type { InteractionQuery } from "./interaction-core.js";

export type InteractionQueries = {
  queryPoint(world: Point, zoom: number, hoveredEdgeId?: string | null): InteractionQuery<HitTarget | null>;
  queryMarquee(rect: { x: number; y: number; width: number; height: number }): InteractionQuery<string[]>;
  queryProbe(source: string, direction: "prev" | "next"): InteractionQuery<ProbeCandidate[]>;
  /**
   * 通用 drop target 查询（change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
   *
   * 按既有顺序固定最上层实际节点（排除来源），只返回 identity；`ok:true` 且 `value=null` 表示
   * 查询成功但该点无节点。`ok:false` 时调用方 MUST NOT 回退 TS 矩形几何或提交移动。
   */
  queryDropTarget(point: Point, excludedIds?: readonly string[]): InteractionQuery<string | null>;
  /** 复合资产范围几何读取（拖动提示消费，按 accepted generation）。 */
  queryCompositeAssetScopes(): InteractionQuery<import("../canvas-runtime/bevy-runtime.js").CompositeAssetScopeGeometryEntry[]>;
  /**
   * 模型网格（渲染在卡片下方）命中：返回最近模型节点 identity。
   *
   * 模型动画门禁以 `hover.nodeId` 为触发，因此悬停模型本体（而非只悬停卡片）时也要建立
   * 节点 hover（change: play-model-animations-on-hover）。`point` 为 canvas 内 CSS 坐标，
   * `surface` 为 CSS 尺寸（与 Rust `pick_nearest` 同一映射）。
   */
  queryModelPick(
    point: Point,
    surface: { width: number; height: number }
  ): InteractionQuery<{ nodeId: string } | null>;
  /** gizmo 命中与轴拖动约束（相机/bounds/gizmo 事实源）。 */
  queryGizmo: GizmoQuery;
};

export function createInteractionQueries(deps: {
  getRuntime: () => BevyRuntime | null;
  /** WASM 尚未接受任何场景时调用：提交一次当前场景以建立 snapshot（冷路径，仅首个 sample）。 */
  publishNow: () => void;
  /** Native 精确查询前，把同一输入周期尚未结算的导航排入视口通道。 */
  beforeQuery?: () => void;
}): InteractionQueries {
  const generationOf = (runtime: BevyRuntime | null): number | null => {
    if (!runtime?.queryPoint || !runtime.interactionGeneration) return null;
    return runtime.interactionGeneration();
  };
  /** 首个查询前建立 snapshot：generation 为 0 时提交一次当前场景。 */
  const ensurePublished = () => {
    deps.beforeQuery?.();
    const runtime = deps.getRuntime();
    if (!runtime?.queryPoint || !runtime.interactionGeneration) return;
    if (runtime.interactionGeneration() === 0) deps.publishNow();
  };

  return {
    queryPoint(world, zoom, hoveredEdgeId = null) {
      const runtime = deps.getRuntime();
      ensurePublished();
      const generation = generationOf(runtime);
      if (!runtime?.queryPoint || generation === null) return { ok: false, reason: "unavailable" };
      return runtime.queryPoint({ generation, x: world.x, y: world.y, zoom, hoveredEdgeId }) as InteractionQuery<HitTarget | null>;
    },
    queryMarquee(rect) {
      const runtime = deps.getRuntime();
      ensurePublished();
      const generation = generationOf(runtime);
      if (!runtime?.queryMarquee || generation === null) return { ok: false, reason: "unavailable" };
      return runtime.queryMarquee({ generation, x: rect.x, y: rect.y, width: rect.width, height: rect.height }) as InteractionQuery<string[]>;
    },
    queryProbe(source, direction) {
      const runtime = deps.getRuntime();
      ensurePublished();
      const generation = generationOf(runtime);
      if (!runtime?.queryProbe || generation === null) return { ok: false, reason: "unavailable" };
      return runtime.queryProbe({ generation, source, direction }) as InteractionQuery<ProbeCandidate[]>;
    },
    queryDropTarget(point, excludedIds = []) {
      const runtime = deps.getRuntime();
      ensurePublished();
      const generation = generationOf(runtime);
      if (!runtime?.queryDropTarget || generation === null) return { ok: false, reason: "unavailable" };
      return runtime.queryDropTarget({ generation, x: point.x, y: point.y, excludedIds }) as InteractionQuery<string | null>;
    },
    queryCompositeAssetScopes() {
      const runtime = deps.getRuntime();
      ensurePublished();
      const generation = generationOf(runtime);
      if (!runtime?.queryCompositeAssetScopes || generation === null) return { ok: false, reason: "unavailable" };
      return runtime.queryCompositeAssetScopes({ generation }) as InteractionQuery<import("../canvas-runtime/bevy-runtime.js").CompositeAssetScopeGeometryEntry[]>;
    },
    queryModelPick(point, surface) {
      const runtime = deps.getRuntime();
      ensurePublished();
      const generation = generationOf(runtime);
      if (!runtime?.queryModelPick || generation === null) return { ok: false, reason: "unavailable" };
      const result = runtime.queryModelPick({
        generation,
        x: point.x,
        y: point.y,
        width: surface.width,
        height: surface.height
      });
      if (!result.ok) return result;
      return { ok: true, generation: result.generation, value: result.value ? { nodeId: result.value.nodeId } : null };
    },
    queryGizmo: (input) => deps.getRuntime()?.queryGizmoHit?.(input) ?? null
  };
}
