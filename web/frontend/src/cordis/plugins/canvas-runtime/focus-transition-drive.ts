/**
 * 三维聚焦过渡的驱动（从 `host.ts` 的同名私有方法原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`host.ts` 曾越过 800 物理行上限。这段逻辑只依赖
 * `FocusTransitionCoordinator` 与一个 「请下一帧重算画面」的回调，不读宿主其它状态，
 * 因此做成纯函数后 host 里只剩一行调用。
 */
import type { CanvasFocusTarget } from "../../navigation/contracts.js";
import type { FocusTransitionCoordinator } from "./focus-transition-coordinator.js";

/** 聚焦切换时宿主需要暴露的全部读写入口（原为 `applyFocusTarget` 里的内联对象）。 */
export type FocusTransitionHostPorts = {
  setImageFocusTargetId: (nodeId: string | null) => void;
  setVideoFocusTargetId: (nodeId: string | null) => void;
  hasModelFocus: () => boolean;
  exitModelFocus: () => void;
  clearImageFocus: () => void;
  clearVideoFocus: () => void;
  getHistoryFocus: () => { nodeId: string } | null;
  setHistoryFocus: (nodeId: string | null) => void;
};

/** 装配 `applyFocusTargetTransition` 需要的 host 对象（纯字段搬运）。 */
export function focusTransitionHost(ports: FocusTransitionHostPorts) {
  return {
    setImageFocusTargetId: ports.setImageFocusTargetId,
    setVideoFocusTargetId: ports.setVideoFocusTargetId,
    hasModelFocus: ports.hasModelFocus,
    exitModelFocus: ports.exitModelFocus,
    clearImageFocus: ports.clearImageFocus,
    clearVideoFocus: ports.clearVideoFocus,
    getHistoryFocus: ports.getHistoryFocus,
    setHistoryFocus: ports.setHistoryFocus
  };
}

/**
 * 驱动三维聚焦公共进度（design D6/D7）。
 *
 * 进入/切换 model/extension：起跑唯一进度，Rust 按进度求值，不再独立计时；退出（target 为
 * null）时保留刚聚焦的实体节点身份继续推进到终点。目标不可用或切换为非三维聚焦时取消在途进度
 * （旧请求不悬挂），交由底层内部计时/二维 adapter 处理。
 */
export function driveModelFocusTransition(input: {
  /** 聚焦目标切换的结算结果；`false` 表示这次切换被拒绝。 */
  ok: boolean;
  target: CanvasFocusTarget | null;
  focusTransition: FocusTransitionCoordinator;
  /** 请求下一帧重算画面（画面依赖过渡进度）。 */
  invalidate: () => void;
}): void {
  const { ok, target, focusTransition, invalidate } = input;
  if (!ok) {
    if (focusTransition.hasModelProgress()) focusTransition.cancel();
    return;
  }
  // 独立文件文档不是三维聚焦：取消任何在途三维进度（不为文件文档伪造节点相机）。
  if (target && "documentId" in target) {
    if (focusTransition.hasModelProgress()) focusTransition.cancel();
    return;
  }
  if (target && (target.kind === "model" || target.kind === "extension")) {
    void focusTransition.runModel({
      nodeId: target.nodeId,
      kind: target.kind === "extension" ? "extension" : "model",
      onProgress: invalidate
    });
    invalidate();
    return;
  }
  if (!target && focusTransition.hasModelProgress()) {
    // 退出：`model_focus` 已清空，但 Rust `rig.focus_node` 仍保留退出中的实体节点，沿用同一身份。
    const nodeId = focusTransition.currentModelNodeId();
    if (nodeId !== null) {
      void focusTransition.runModel({
        nodeId,
        kind: focusTransition.currentModelKind(),
        onProgress: invalidate
      });
      invalidate();
    }
    return;
  }
  // 切到二维媒体聚焦或非三维目标：取消任何在途三维进度，避免两个驱动并存。
  if (focusTransition.hasModelProgress()) focusTransition.cancel();
}
