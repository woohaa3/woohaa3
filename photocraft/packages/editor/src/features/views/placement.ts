/**
 * 一次性的「在画布上点一下」请求（U73）。
 *
 * ## 为什么需要这一层
 *
 * 计数标记与注释都要落在**用户点的那个源像素**上。面板只能给数值框，画布才知道客户点对应
 * 哪个源坐标；两者分属不同组件，中间又隔着共享的 `photo-editor-app.tsx`。
 *
 * 因此这里放一个最小的订阅式请求：
 *
 * - 面板按下「在画布上放置」→ `requestPlacement`，带上说明与落点回调；
 * - 画布点击 → 应用读 `activePlacement()`，有请求就调用回调并**立即清空**；
 * - 没有请求时画布行为完全不变（`onViewPoint` 不消费这次点击）。
 *
 * 请求是**一次性**的：消费、取消或组件卸载都会清空，不会留下「下次点击意外加点」的捕获状态。
 * 不写文档、不造历史；真正写入仍走面板/应用里的同一条 `viewCommand`。
 *
 * ## 已知边界
 *
 * 请求是模块级单例，因此同一窗口里同时挂载多个编辑器（例如智能对象子编辑器）时，先点击的那个
 * 画布会消费它。目前的发起方只有视图工作区面板，而面板只在主编辑器里出现，所以实际不会串；
 * 若将来子编辑器也要落点，应把请求改成按编辑器实例持有，而不是继续用模块级状态。
 */

export type PlacementRequest = {
  /** 界面上显示给用户的动作说明（例如「点击画布放置计数标记」）。 */
  label: string;
  /** 落点回调：源像素坐标。 */
  place: (point: readonly [number, number]) => void;
};

let current: PlacementRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 发起一次落点请求；同一时刻只有一个（后发覆盖先发）。 */
export function requestPlacement(request: PlacementRequest): void {
  current = request;
  emit();
}

/** 取消当前请求（用户按取消，或面板切换页签）。 */
export function cancelPlacement(): void {
  if (!current) return;
  current = null;
  emit();
}

/** 当前请求；没有则为 `null`。 */
export function activePlacement(): PlacementRequest | null {
  return current;
}

/**
 * 消费一次落点：调用回调并清空。
 *
 * 回调里抛出的错误不吞掉——落点写入失败要让调用方（应用）显示消息，而不是静默丢一次点击。
 */
export function consumePlacement(point: readonly [number, number]): boolean {
  const request = current;
  if (!request) return false;
  current = null;
  emit();
  request.place(point);
  return true;
}

/** 订阅请求变化；返回取消订阅函数。 */
export function subscribePlacement(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 仅供测试：重置模块级请求。 */
export function resetPlacementForTests(): void {
  current = null;
  listeners.clear();
}
