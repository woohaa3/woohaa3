/**
 * 路径工具的当前目标（U11–U15，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
 *
 * 面板里选的「工作路径 / 当前图层路径 / 已存命名路径」必须与画布上的钢笔落点和锚点编辑看
 * **同一个**目标，否则会出现「面板写着 P 路径、画布却在改 work」这种只有接线后才暴露的错位。
 * 目标是工具状态（不进文档、不进历史），因此用域内小 store，而不是往共享控制器里塞字段。
 */

/** 面板可选的目标：`work`、`layer`（当前图层路径）或已存命名路径。 */
export type PathChoice = string;

const WORK: PathChoice = "work";
let current: PathChoice = WORK;
const listeners = new Set<() => void>();

export function pathChoice(): PathChoice {
  return current;
}

export function setPathChoice(next: PathChoice): void {
  const value = next.trim() === "" ? WORK : next;
  if (current === value) return;
  current = value;
  for (const listener of listeners) listener();
}

export function subscribePathChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 解析出编辑目标。
 *
 * 规则（显式优先，默认落到图层自身路径）：
 * - 面板选了具体目标（命名路径或 `layer`）→ 就用它；
 * - 面板保持默认 `work` 且活动图层本身带路径（形状层或矢量蒙版）→ 改该图层路径。
 *   这样「选中形状层后用直接选择」开箱即用，而不会悄悄改工作路径；
 * - 其余情况 → 工作路径。
 *
 * 没有活动图层时 `layer` 选择不成立，退回工作路径（内核会拒绝空图层 id，不制造半成品）。
 */
export function resolvePathTarget(
  choice: PathChoice,
  layer: number | null,
  layerHasPath: boolean,
): { name: string; layer?: number | null } {
  if (choice === "layer") return layer === null ? { name: WORK } : { name: "layer", layer };
  if (choice !== WORK) return { name: choice };
  return layer !== null && layerHasPath ? { name: "layer", layer } : { name: WORK };
}
