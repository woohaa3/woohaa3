/**
 * 并排双视图的**布局决定**（U72）。
 *
 * ## 职责边界
 *
 * 内核持有视图清单与会话开关（`viewAids.views` / `viewAids.sideBySide`）；这里只回答两个纯问题：
 *
 * 1. 现在该渲染几个画布、分别对应哪个视图（[`splitPanes`]）；
 * 2. 每个画布用哪份取景（[`paneViewport`]）。
 *
 * 不读 DOM、不调内核、不持有像素，因此「什么条件下并排、活动视图用哪份取景」这类规则可以
 * 直接单元测试，而不用挂载整个编辑器。
 *
 * ## 为什么活动视图用宿主视口
 *
 * 单视图时画布的缩放/平移由宿主持有：状态栏、快捷键、画布手势都直接改宿主视口，Woohaa 的
 * Bevy 相机也读它。并排时若把活动画布也换成另一份状态，就会出现「状态栏显示的缩放和眼前
 * 画布不一致」。因此规则是：**活动视图 = 宿主视口**，非活动视图 = 各自记住的取景。
 *
 * 切换活动视图时用同一个 [`paneViewport`] 取「那个窗格此刻正在显示的取景」交给宿主，因此
 * 激活前后画面不跳：它原先显示什么，成为活动视图后还是什么。
 */

import type { EditorViewport } from "../../viewport.js";

/** 决定并排所需的视图辅助字段（`viewAids` 原样传进来即可）。 */
export type PaneSource = {
  sideBySide?: boolean;
  views?: ReadonlyArray<{ id: string; label: string; active: boolean }>;
};

/** 一个画布窗格：渲染几块画布、各自绑定哪个视图。 */
export type CanvasPane = {
  /** 视图 id（内核 `views[].id`），也是画布的 React key。 */
  id: string;
  /** 内核给的视图名（「视图 1」…），界面直接显示，不自己编号。 */
  label: string;
  /** 是否活动视图：它的取景就是宿主视口。 */
  active: boolean;
};

/**
 * 是否并排、以及每个窗格绑定哪个视图。
 *
 * 返回 `null` 表示**不并排**：调用方沿用原来的单画布路径（宿主视口），行为零变化。
 * 只有「开关打开 且 确有至少两个视图」才返回窗格列表——只有一个视图时内核已经拒绝打开开关，
 * 这里再判一次是为了不依赖内核版本：旧运行时没有 `sideBySide` 字段时按 `false` 处理。
 */
export function splitPanes(aids: PaneSource | null | undefined): CanvasPane[] | null {
  if (!aids?.sideBySide) return null;
  const views = aids.views;
  if (!Array.isArray(views) || views.length < 2) return null;
  return views.map((view) => ({ id: view.id, label: view.label, active: view.active }));
}

/**
 * 一个窗格此刻的取景。
 *
 * - 活动视图用宿主视口（`host`），保证状态栏、快捷键与画布一致；
 * - 非活动视图用它自己记住的取景；还没单独调过时沿用 `host`——这与内核「新视图从当前取景
 *   开始」一致，不会让新开的窗格突然跳到 100%，也不会让两个窗格看起来是两个不同文档。
 */
export function paneViewport(
  pane: CanvasPane,
  host: EditorViewport,
  stored: Readonly<Record<string, EditorViewport>>,
): EditorViewport {
  if (pane.active) return host;
  return stored[pane.id] ?? host;
}

/**
 * 维护每个窗格记住的取景。
 *
 * 规则：
 * - 活动窗格**持续跟随宿主视口**（状态栏、快捷键、空格拖拽改的都是它，两处必须一致）；
 * - 非活动窗格一旦有记录就不再跟随——否则用户平移活动画布时，另一块画布会跟着一起动，
 *   那就不是「取景独立」了；
 * - 新出现的窗格从**当前取景**开始（与内核「新视图沿用当前视图」一致），不会突然跳到 100%；
 * - 窗格消失（关并排/关视图）就丢掉它的记录，避免一堆再也用不到的键。
 *
 * 没有任何变化时返回**同一个引用**：调用方可以放心把它放进 effect 而不触发重渲染。
 */
export function syncPaneViewports(
  panes: readonly CanvasPane[] | null,
  current: Readonly<Record<string, EditorViewport>>,
  host: EditorViewport,
): Record<string, EditorViewport> {
  if (!panes) return current as Record<string, EditorViewport>;
  const next: Record<string, EditorViewport> = {};
  let changed = Object.keys(current).length !== panes.length
    || panes.some((pane) => !(pane.id in current));
  for (const pane of panes) {
    const previous = current[pane.id];
    if (pane.active) {
      // 活动视图永远取宿主视口；值相等时保留原对象，避免每帧造新引用。
      const value = previous && sameViewport(previous, host) ? previous : { ...host };
      if (value !== previous) changed = true;
      next[pane.id] = value;
      continue;
    }
    const value = previous ?? { ...host };
    if (value !== previous) changed = true;
    next[pane.id] = value;
  }
  return changed ? next : (current as Record<string, EditorViewport>);
}

function sameViewport(a: EditorViewport, b: EditorViewport): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}
