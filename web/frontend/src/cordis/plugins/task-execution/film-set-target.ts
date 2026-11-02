/**
 * 片场 AI 目标的内容版本解析
 * （change: 2026-10-12-add-agent-conversation-panel 引入片段目标；
 *   change: 2026-10-31-redesign-film-set-workspace 改为场景 AI 固定整个片场）。
 *
 * 画布片场节点面板与聚焦场景 AI 都以**整个片场**为目标：版本前提使用完整快照哈希，
 * 不再把当前镜头冻结成 clipId。只有历史局部回合显式带 `clipId` 时，续聊仍沿用该镜头的哈希。
 */
import { animationSnapshotHash, filmSetAnimationsOf, filmSetClipHash, readFilmSetAnimationProjection } from "@woohaa3/contracts";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";

function animationOf(nodeId: string) {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  return readFilmSetAnimationProjection(canvas, nodeId);
}

/**
 * 片场目标的内容哈希。
 *
 * - 整个片场目标（`clipId` 缺省）：完整快照哈希，与 `get_model_node` 的 `snapshotHash` 一致；
 * - 历史局部回合（显式 `clipId`）：该镜头的内容哈希；镜头已不存在时返回 undefined（由调用方保留文本、不重跑）。
 */
export function resolveFilmSetTargetHash(nodeId: string, clipId?: string): string | undefined {
  const animation = animationOf(nodeId);
  if (!animation) return undefined;
  if (!clipId) return animationSnapshotHash(animation);
  const clip = filmSetAnimationsOf(animation).clips.find((entry) => entry.id === clipId);
  return clip ? filmSetClipHash(clip) : undefined;
}
