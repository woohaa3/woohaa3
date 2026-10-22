/**
 * 当前片段对象动作适配确认
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 6.7 / design D9）。
 *
 * 适配状态从**当前有效片段**的 selected item binding 读取，确认使用 `filmSet.clipPatch` 的
 * `confirm-adaptation`，携带稳定 clipId/itemId、`expectedAdapterHash` 与 `filmSetClipPrecondition`
 * 的 expectedHash。界面不再发送已被协议拒绝的对象级适配确认（reducer 会以 clip-required 拒绝）。
 */
import { useState, useSyncExternalStore } from "react";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import { decodeFilmSetNodeData, filmSetAnimationsOf, filmSetClipPrecondition, filmSetItemAdapterHash, type FilmSetNodeData, type FilmSetAnimationClip, type FilmSetItem } from "@woohaa3/contracts";
import { Button } from "@woohaa3/frontend/extension-api";

export type AdaptationState = {
  /** 当前绑定是否存在动作且与对象内容失配。 */
  changed: boolean;
  /** 阻断原因（只读/无绑定动作/无选中对象）；可确认时为 null。 */
  disabledReason: string | null;
};

/** 从当前有效片段 binding 计算适配状态（纯函数，供组件与测试复用）。 */
export function resolveAdaptation(input: {
  animation: FilmSetNodeData;
  clip: FilmSetAnimationClip | undefined;
  item: FilmSetItem | undefined;
  writable: boolean;
}): AdaptationState {
  const { animation, clip, item, writable } = input;
  if (!item) return { changed: false, disabledReason: "先选择场景对象" };
  if (!clip) return { changed: false, disabledReason: "当前没有可用的动画片段" };
  const binding = clip.bindings.find((entry) => entry.itemId === item.id);
  if (!binding?.motion) return { changed: false, disabledReason: null };
  const changed = binding.motion.basedOnModelVersion.contentHash !== filmSetItemAdapterHash(item);
  void animation;
  void writable;
  return { changed, disabledReason: changed ? (writable ? null : "当前会话不可写") : null };
}

export function FilmSetAdaptationConfirm({
  ctx,
  nodeId,
  itemId,
  clipId,
  writable
}: {
  ctx: Context;
  nodeId: string;
  itemId: string | null;
  clipId: string | null;
  writable: boolean;
}) {
  const canvasState = useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = ctx.compositeAssets.projectCanvas(canvasState);
  const decoded = decodeFilmSetNodeData(canvas?.nodeData[nodeId]);
  if (!decoded.ok) return null;
  const animation = decoded.value;
  const clips = filmSetAnimationsOf(animation);
  const clip = clips.clips.find((entry) => entry.id === clipId);
  const item = itemId ? animation.filmSetContent.items.find((entry) => entry.id === itemId) : undefined;
  const state = resolveAdaptation({ animation, clip, item, writable });
  if (!state.changed) {
    return state.disabledReason ? <p className="film-set-object-hint">{state.disabledReason}</p> : null;
  }
  const confirm = async () => {
    if (!writable || !clip || !item || busy) return;
    setBusy(true);
    setError(null);
    const op = { kind: "confirm-adaptation" as const, itemId: item.id, expectedAdapterHash: filmSetItemAdapterHash(item) };
    const result = ctx.canvasSession.submitCommands(
      [{ type: "filmSet.clipPatch", nodeId, clipId: clip.id, op, expectedHash: filmSetClipPrecondition(clips, clip.id, op) }],
      `web-adapt-${crypto.randomUUID()}`
    );
    if (!result.ok) {
      setError("适配确认未提交，请检查连接和写入权限");
      setBusy(false);
      return;
    }
    const outcome = await result.handle.settled;
    if (outcome.state === "rejected") setError(outcome.error ?? "适配确认被拒绝，请重新读取后重试");
    setBusy(false);
  };
  return (
    <div className="film-set-adaptation" role="status">
      <p>对象动作与当前内容失配，确认后仅更新本片段 {clip?.name ?? clip?.id} 的适配关联。</p>
      <Button size="sm" loading={busy} disabled={!writable} onClick={() => void confirm()}>确认动作适配</Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
