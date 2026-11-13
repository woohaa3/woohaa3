/**
 * 模型聚焦会话生命周期
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 model-gesture-family 拆出；
 *   change: 2026-09-28-fix-model-focus-navigation-and-camera-parity，task 3.1/3.5）。
 *
 * 进入/退出/重新取景/有效期校验；只操作 `ModelFocusSession` 与注入的上下文，不持有
 * gizmo 手势或 DOM 状态。placement 门禁与 gesture 推进仍在 `model-gesture-family`。
 *
 * 关键不变式（design D4/D5）：
 * - `enter` 只在 `idle -> focused` 写入进入快照；已聚焦的 reframe 不再覆盖 saved viewport。
 * - 目标失效**只上报** Navigation（`onInvalidate`），由 Navigation 原子收敛后再调用
 *   adapter exit；普通 selection 变化不再直接结束 focus。
 */
import {
  modelBounds,
  ModelFocusSession,
  type FocusTargetInput
} from "./model-focus-session.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";

export type Surface = { width: number; height: number; pixelRatio: number };

export type FocusLifecycleDeps = {
  focus: ModelFocusSession;
  getTargets: () => readonly FocusTargetInput[];
  /** 只查询目标成员资格，避免每帧派生完整包围盒。 */
  hasTarget?: (nodeId: string) => boolean;
  activeViewport: () => { x: number; y: number; zoom: number };
  surfaceSize: () => Surface;
  localViewportSet: (viewport: { x: number; y: number; zoom: number }) => void;
  emit: () => void;
  /** 清理 held input / 活动 preview；由 family 注入（含镜头与焦点手势取消）。 */
  clearHeld: () => void;
  /** 聚焦目标/runtime projection 失效上报（Navigation 原子收敛）。 */
  onInvalidate: (reason: string) => void;
};

export function createFocusLifecycle(deps: FocusLifecycleDeps) {
  const { focus } = deps;

  const exit = () => {
    if (!focus.active) return;
    const { restored } = focus.exit();
    const saved = restored as { viewport?: { x: number; y: number; zoom: number } } | null;
    if (saved?.viewport) deps.localViewportSet(saved.viewport);
    deps.clearHeld();
    deps.emit();
  };

  /** 以 canonical nodeId 请求进入聚焦；找不到合法目标返回 false。 */
  const enterForNode = (nodeId: string): boolean => {
    if (focus.active && focus.nodeId === nodeId) return true;
    const surface = deps.surfaceSize();
    const target = deps.getTargets().find((entry) => entry.nodeId === nodeId);
    if (!target) return false;
    const bounds = modelBounds(target);
    if (!bounds) return false;
    // 已聚焦其它节点：由 Navigation owner 切换协调；这里仍允许替换目标（保留 saved）。
    const entered = focus.enter({
      nodeId,
      target: bounds.center,
      radius: bounds.radius,
      distance: focus.framingDistance(bounds.radius, surface),
      saved: { viewport: deps.activeViewport() }
    });
    if (entered) {
      deps.emit();
    }
    return entered;
  };

  /** 从双击模型命中进入聚焦（canonical 校验由调用方完成）。 */
  const enterFromHit = (input: { nodeId: string; target: [number, number, number]; radius: number }): boolean => {
    if (focus.active && focus.nodeId === input.nodeId) return true;
    const surface = deps.surfaceSize();
    const entered = focus.enter({
      nodeId: input.nodeId,
      target: input.target,
      radius: input.radius,
      distance: focus.framingDistance(input.radius, surface),
      saved: { viewport: deps.activeViewport() }
    });
    if (entered) {
      deps.emit();
    }
    return entered;
  };

  /** 按未遮挡左侧区域更新聚焦取景。 */
  const setContentRect = (rect: { right: number; left?: number; top?: number; bottom?: number }): void => {
    // 必须同时提供 surface 高度，否则 content rect → 世界偏移会退化。
    const changed = focus.setContentRect({ ...rect, surfaceHeight: deps.surfaceSize().height });
    if (changed && focus.active) deps.emit();
  };

  /**
   * 按当前本地 Scene IR override 重新取景（design D4）。
   *
   * 只更新目标/半径与 auto-fit distance，不覆盖 `savedProjection2d`。历史 preview 才需要
   * auto-fit；content rect 变化只更新偏移（`setContentRect`），不重置用户观察缩放。
   */
  const reframe = (nodeId: string): void => {
    if (!focus.active || focus.nodeId !== nodeId) return;
    const target = deps.getTargets().find((entry) => entry.nodeId === nodeId);
    if (!target) return;
    const bounds = modelBounds(target);
    if (!bounds) return;
    focus.reframe({
      nodeId,
      target: bounds.center,
      radius: bounds.radius,
      distance: focus.framingDistance(bounds.radius, deps.surfaceSize())
    });
    deps.emit();
  };

  /** 切换为 history owner：保存当前 direct 主观察相机（design D2）。 */
  const saveDirectCamera = (): void => {
    focus.cameraSnapshot();
  };

  /** 当前聚焦目标是否仍有效：canonical 存在且仍有可用 Scene IR 目标。 */
  const targetsValid = (): boolean => {
    const nodeId = focus.nodeId;
    if (nodeId === null) return true;
    const canonical = woohaa3CanvasStore.getState().canvas;
    if (!canonical || !canonical.document.nodes.some((node) => node.id === nodeId)) return false;
    return deps.hasTarget?.(nodeId) ?? deps.getTargets().some((target) => target.nodeId === nodeId);
  };

  /**
   * 聚焦目标失效（删除 / Scene IR 移除）→ 上报 Navigation（design D5）。
   * 普通 selection 变化**不**触发；只依赖 canonical 与 Scene IR 的有效性。
   */
  const syncValid = (): void => {
    if (!focus.active) return;
    if (!targetsValid()) deps.onInvalidate("focus-target-invalid");
  };

  return { exit, enterForNode, enterFromHit, setContentRect, reframe, saveDirectCamera, targetsValid, syncValid };
}
