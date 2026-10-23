import type { DocumentPoint } from "../../photo-editor-tools.js";
import type { LineAxis } from "./draft-state.js";

/**
 * 「面板布防 → 画布下一次单击落点 → 自动解除」的单击认领机制。
 *
 * 有两处 spec 明确要求**在画布上点**，而共享外壳只提供一次单击回调：
 *
 * - U17「缩放后**单击**形成准确的一源像素行/列」（选框组里的单行/单列子工具）；
 * - U22「色彩范围支持**画布多点**、增减取样」。
 *
 * 两者都不能靠新增工具 id 表达（`FEATURE_TOOLS` 是共享冻结清单，由
 * `features/boundaries.test.ts` 锁定），所以统一表达为**一次性待命**：域面板布防并附带
 * 自己的处理函数，共享外壳的单击只问一句"这次单击有没有被域认领"。
 *
 * 状态按**控制器实例**隔离（`WeakMap`），不放模块级单例：宿主可同时挂多个编辑器标签，
 * 否则在 A 里布防会让 B 的单击也变成建行/取样。
 */
export type CanvasPick =
  | { kind: "line"; axis: LineAxis }
  | { kind: "sample"; operation: "+" | "-" };

type Armed = { pick: CanvasPick; onPoint: (point: DocumentPoint) => void };

const armed = new WeakMap<object, Armed>();

/** 当前待命项；没有布防时为 `null`（面板据此显示"已布防"提示）。 */
export function canvasPickOf(controller: object): CanvasPick | null {
  return armed.get(controller)?.pick ?? null;
}

/**
 * 布防：下一次画布单击交给 `onPoint`。
 *
 * 处理函数由域面板提供，点位编译、图外拒绝、参数语义都留在面板/域内；共享外壳不解释参数。
 */
export function armCanvasPick(controller: object, pick: CanvasPick, onPoint: (point: DocumentPoint) => void): void {
  armed.set(controller, { pick, onPoint });
}

/** 解除布防（用户放弃，或换到不相干的工具）。 */
export function disarmCanvasPick(controller: object): void {
  armed.delete(controller);
}

/**
 * 消费一次画布单击。
 *
 * 返回 `true` 表示这次单击已被域认领——**无论处理成功与否都已解除布防**，避免用户点在图外后
 * 下一次无关单击又被当成建行/取样。返回 `false` 时调用方继续走原本的单击语义
 * （例如点空白处取消选择）。
 */
export function takeCanvasPick(controller: object, point: DocumentPoint): boolean {
  const entry = armed.get(controller);
  if (!entry) return false;
  armed.delete(controller);
  entry.onPoint(point);
  return true;
}
