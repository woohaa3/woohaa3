/**
 * 构图叠加层的域内状态源（裁剪框 / 整图旋转预览 / 变形网格）。
 *
 * 叠加层要画在共享画布上，但它们的几何属于**本域**（裁剪框在面板里编辑、旋转预览由角度推导、
 * 变形网格来自变形会话）。共享装配只提供 `renderOverlay(origin, zoom)` 槽位，不转发域状态，
 * 因此这里用一个极小的外部 store 在「面板/工具控制器」与「叠加层」之间传值：
 *
 * - 面板在进入对应交互时 `publish` 自己的状态，退出时 `release` 自己的槽位；
 * - 共享装配挂载 `<MountedCompositionOverlay …/>`，它自己订阅，不需要第二个开关属性。
 *
 * 画布上同一时刻只画**一个**构图叠加层，但持有者可以有多个：裁剪面板与工作流面板同属一节、
 * 会同时挂载，因此每个持有者只用 `publish(state, slot)` 覆盖自己那个槽位，撤回时用
 * `release(slot)` 只让出自己那一个——否则后渲染的面板会静默清掉另一个面板的叠加层。
 * 多个槽位同时有值时按 `SLOT_PRIORITY` 挑一个画（显式编辑会话优先于角度副产物）。
 *
 * 约束：这是**纯展示状态**，不参与内容身份、不进历史、不写修订。它只在同一渲染树内传递
 * 指针几何，因此不需要跨标签或跨文档隔离。
 */
import type { CompositionOverlaySlot, CompositionOverlayState } from "./overlays.js";

type Listener = (state: CompositionOverlayState | null) => void;

/**
 * 槽位优先级：越靠前越「显式」。
 *
 * 裁剪框与变形网格都是主动进入的编辑会话（用户点了按钮、当前有目标图层），旋转预览是
 * 副产物（改角度时顺带显示）。因此旋转放最后：只要有人显式进入裁剪或变形，就不该被
 * 「角度不是 0」压掉。
 */
const SLOT_PRIORITY: readonly CompositionOverlaySlot[] = ["composition.crop", "composition.warp", "composition.rotate"];

const owners = new Map<CompositionOverlaySlot, CompositionOverlayState | null>();
const listeners = new Set<Listener>();

/** 按优先级挑出当前该画的那一个。 */
function resolve(): CompositionOverlayState | null {
  for (const slot of SLOT_PRIORITY) {
    const state = owners.get(slot);
    if (state && state.active !== null) return state;
  }
  return null;
}

let current: CompositionOverlayState | null = null;

/** 当前叠加层状态（无监听者的读取方也拿到同一份）。 */
export function compositionOverlayState(): CompositionOverlayState | null {
  return current;
}

function sync(): void {
  const next = resolve();
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener(current);
}

/**
 * 发布某个槽位的叠加层状态。`null` 表示「这个槽位不再占用画布」。
 *
 * 只影响自己槽位；别的槽位若仍持有状态且优先级更高，画布上画的仍是它。引用相等时跳过通知，
 * 避免面板每次渲染都触发整棵叠加层重绘。
 */
export function publishCompositionOverlay(next: CompositionOverlayState | null, slot: CompositionOverlaySlot = "composition.crop"): void {
  if (owners.get(slot) === next) return;
  owners.set(slot, next);
  sync();
}

/** 订阅叠加层状态，返回退订函数。 */
export function subscribeCompositionOverlay(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 让出某个槽位（面板卸载时调用，避免残留旧框）。 */
export function releaseCompositionOverlay(slot: CompositionOverlaySlot = "composition.crop"): void {
  publishCompositionOverlay(null, slot);
}

/** 测试与「关闭文档」用：清空全部槽位。 */
export function resetCompositionOverlay(): void {
  owners.clear();
  if (current !== null) {
    current = null;
    for (const listener of [...listeners]) listener(current);
  }
}
