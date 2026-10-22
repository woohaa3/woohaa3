/**
 * 片场面板的目标片段解析
 * （change: 2026-10-12-add-agent-conversation-panel，design D3 / `openspec/specs/model-authoring`）。
 *
 * 动作写入必须携带 `clipId`，工具 allowlist 据此捕获片段身份；无片段不签发片段写权限（调用被拒为
 * `tool-not-allowed`）。没有显式片段选择的面板（右侧模型节点编辑）用节点的默认片段作为目标，
 * 保证片场生成动作能被授权放行。
 */
import { decodeFilmSetNodeData, filmSetAnimationsOf, filmSetClipHash } from "@woohaa3/contracts";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";

function nodeDataOf(nodeId: string): unknown {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  return canvas?.nodeData?.[nodeId];
}

/** 默认目标片段 id；节点不是合法片场或没有片段时返回 undefined。 */
export function resolveFilmSetTargetClip(nodeId: string): string | undefined {
  const decoded = decodeFilmSetNodeData(nodeDataOf(nodeId));
  return decoded.ok ? filmSetAnimationsOf(decoded.value).defaultClipId ?? undefined : undefined;
}

/** 默认目标片段的内容哈希（并发生效 precondition）；缺失时返回 undefined。 */
export function resolveFilmSetClipHash(nodeId: string, clipId?: string): string | undefined {
  const decoded = decodeFilmSetNodeData(nodeDataOf(nodeId));
  if (!decoded.ok) return undefined;
  const collection = filmSetAnimationsOf(decoded.value);
  const clip = collection.clips.find((entry) => entry.id === (clipId ?? collection.defaultClipId));
  return clip ? filmSetClipHash(clip) : undefined;
}
