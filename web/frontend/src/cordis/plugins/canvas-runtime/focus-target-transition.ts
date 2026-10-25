/**
 * Canvas Runtime focus target transition
 * （change: refactor-frontend-file-size；从 `host.ts` 拆出以遵守文件体积守卫）。
 *
 * 图片聚焦由图片编辑 feature 拥有实际 session；这里只维护 history owner 标记与投影清除，
 * 并把有效 transition 转交给 controller。
 */
import type { InteractionController } from "../canvas-shell/interaction-controller.js";
import { isDocumentFocusTarget, type CanvasFocusTarget } from "../../navigation/contracts.js";

export type FocusTransitionHost = {
  /** 设置图片聚焦目标 id（`null` 清除）。 */
  setImageFocusTargetId(nodeId: string | null): void;
  /** 设置视频聚焦目标 id（`null` 清除）。 */
  setVideoFocusTargetId(nodeId: string | null): void;
  /** 有活动模型聚焦时退出。 */
  hasModelFocus(): boolean;
  exitModelFocus(): void;
  /** 清除图片聚焦投影。 */
  clearImageFocus(): void;
  /** 清除视频聚焦投影。 */
  clearVideoFocus(): void;
  getHistoryFocus(): { nodeId: string } | null;
  setHistoryFocus(nodeId: string | null): void;
};

/**
 * 应用一次焦点目标 transition。
 *
 * - 节点目标（image/video/model/extension）：由对应 feature 拥有实际 session，这里维护 owner
 *   标记与投影清除。
 * - `{ kind: "document" }`（编辑扩展工作区，D4）：独立文件
 *   文档没有画布节点身份。清除所有节点聚焦目标与投影（含模型/历史 override），**不**进入任何
 *   节点相机、也不委托 controller；文档自己的取景由编辑 feature 的呈现层负责。
 */
export function applyFocusTargetTransition(input: {
  host: FocusTransitionHost;
  controller: InteractionController;
  target: CanvasFocusTarget | null;
  transition: { preserveSession: boolean; restoreDirectCamera?: boolean };
}): { ok: true } | { ok: false; reason: string } {
  const { host, controller, target, transition } = input;
  // 独立文件文档：清空全部节点聚焦状态，不为文件文档伪造节点。
  if (isDocumentFocusTarget(target)) {
    host.setImageFocusTargetId(null);
    host.clearImageFocus();
    host.setVideoFocusTargetId(null);
    host.clearVideoFocus();
    host.setHistoryFocus(null);
    if (host.hasModelFocus()) host.exitModelFocus();
    return { ok: true };
  }
  // 图片/视频聚焦由各自 feature 拥有实际 session；host 只维护 history owner 标记与投影清除。
  // 两个二维媒体聚焦互斥：进入其一必须清除另一个的目标与投影。
  if (target?.kind === "image") {
    host.setImageFocusTargetId(target.nodeId);
    if (host.hasModelFocus()) host.exitModelFocus();
    host.setVideoFocusTargetId(null);
    host.clearVideoFocus();
    host.setHistoryFocus(target.owner === "history" ? target.nodeId : null);
    return { ok: true };
  }
  if (target?.kind === "video") {
    host.setVideoFocusTargetId(target.nodeId);
    if (host.hasModelFocus()) host.exitModelFocus();
    host.setImageFocusTargetId(null);
    host.clearImageFocus();
    host.setHistoryFocus(target.owner === "history" ? target.nodeId : null);
    return { ok: true };
  }
  // extension 工作区聚焦：走纯模型通道（与 model 相同的相机取景/投影），工作区覆盖层由 extension
  // 贡献；history 只读语义同 model（change: 2026-10-10-add-game-furnace-extension）。
  if (target?.kind === "extension") {
    host.setImageFocusTargetId(null);
    host.clearImageFocus();
    host.setVideoFocusTargetId(null);
    host.clearVideoFocus();
    const previousOwner = host.getHistoryFocus();
    host.setHistoryFocus(target.owner === "history" ? target.nodeId : null);
    const result = controller.applyFocusTarget({ nodeId: target.nodeId, kind: target.kind, owner: target.owner }, transition);
    if (!result.ok) {
      host.setHistoryFocus(previousOwner?.nodeId ?? null);
      return result;
    }
    return { ok: true };
  }
  host.setImageFocusTargetId(null);
  host.clearImageFocus();
  host.setVideoFocusTargetId(null);
  host.clearVideoFocus();
  // 先更新 owner，再驱动 controller：projection/editor 同步回调必须看到一致的 mode。
  const previousOwner = host.getHistoryFocus();
  host.setHistoryFocus(target && target.owner === "history" ? target.nodeId : null);
  const result = controller.applyFocusTarget(target, transition);
  if (!result.ok) {
    host.setHistoryFocus(previousOwner?.nodeId ?? null);
    return result;
  }
  return { ok: true };
}