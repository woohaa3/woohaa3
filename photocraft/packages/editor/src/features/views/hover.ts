/**
 * Info 跟随光标的源像素读数（U73）。
 *
 * ## 为什么需要这一层
 *
 * 读数必须来自**内核**（客户坐标→源坐标的反算经视图矩阵，取色用同一份合成采样），因此只有
 * 挂着画布的应用能拿到；显示它的 Info 面板在另一个组件里。中间用一个最小的订阅式存储传递
 * 已经解码好的读数：
 *
 * - 画布移动 → 应用限频调用 `viewPointer("probe")` → `publishHover`；
 * - 画布离开 → `publishHover(null)`；
 * - Info 面板订阅，显示源坐标与 RGB/CMYK。
 *
 * ## 边界
 *
 * 读数**不是文档数据**：不写文档、不造历史、不进保存。画布外时必须是 `null`（面板显示「—」），
 * 不允许拿上一次读数冒充当前位置，也不许界面自己按缩放估一个像素。
 *
 * ## 已知边界
 *
 * 与 `placement.ts` 一样是模块级单例：同一窗口里挂载多个编辑器（例如智能对象子编辑器）时，
 * 后一次发布覆盖前一次。目前只有主编辑器发布/订阅，实际不会串；若将来子编辑器也要读数，
 * 应改成按编辑器实例持有。
 */

import type { ProbeReading } from "./decode.js";

let current: ProbeReading | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 发布一次读数；`null` 表示光标不在画布上。相同引用/相同内容不重复通知。 */
export function publishHover(reading: ProbeReading | null): void {
  if (reading === current) return;
  current = reading;
  emit();
}

/** 当前读数；没有则为 `null`。 */
export function activeHover(): ProbeReading | null {
  return current;
}

/** 订阅读数变化；返回取消订阅。 */
export function subscribeHover(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试用：清空读数与订阅者。 */
export function resetHoverForTests(): void {
  current = null;
  listeners.clear();
}
