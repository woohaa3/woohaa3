/**
 * Canvas Runtime 的拖动吸附策略注入（内置插件 `alignment-guides`）。
 *
 * 与 `model-editor-gestures` 同形：只做字段保存与向已挂载 controller 转发，不持有规范状态。
 * 单独成文件是为了不把 `host.ts` 继续推高（它已在文件体积守卫的历史债务清单里）。
 */
import type { AlignmentSnapPolicy } from "../../contract/alignment-snap.js";
import type { InteractionController } from "../canvas-shell/interaction-controller.js";

export type AlignmentSnapRef = { current: AlignmentSnapPolicy | null };

export function createAlignmentSnapRef(): AlignmentSnapRef {
  return { current: null };
}

/** 当前拖动的辅助对齐线（世界坐标）；未挂载或不在拖动中时为空。 */
export function readAlignmentGuides(controller: InteractionController | null): readonly import("../../contract/alignment-snap.js").AlignmentGuide[] {
  return controller?.alignmentGuides() ?? [];
}

/** 参考线版本号；内容变化才递增。 */
export function readAlignmentGuidesVersion(controller: InteractionController | null): number {
  return controller?.alignmentGuidesVersion() ?? 0;
}

/** 保存策略并同步到当前 controller（未挂载时只保存，挂载后由构造期读取）。 */
export function applyAlignmentSnapPolicy(
  ref: AlignmentSnapRef,
  controller: InteractionController | null,
  policy: AlignmentSnapPolicy | null
): void {
  ref.current = policy ?? null;
  controller?.setAlignmentSnapPolicy(ref.current);
}
