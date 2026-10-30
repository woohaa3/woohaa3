import { useState } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { filmSetClipPrecondition, filmSetItemAdapterHash, type FilmSetAnimationClip, type FilmSetAnimations, type FilmSetItem } from "@woohaa3/contracts";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";

/** 镜头动作关联经带 precondition 的公共编辑日志提交，不控制对象可见性。 */
export function FilmSetObjectBinding({ ctx, nodeId, item, clip, collection, writable }: {
  ctx: FilmSetHostContext; nodeId: string; item: FilmSetItem; clip: FilmSetAnimationClip; collection: FilmSetAnimations; writable: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (clip.kind === "static") return <p className="film-set-object-hint">静态镜头使用场景基础姿态，不启用对象动作。</p>;
  const bound = clip.bindings.some(binding => binding.itemId === item.id);
  const bind = async () => {
    if (!writable || busy) return;
    setBusy(true); setError(null);
    const op = { kind: "binding" as const, itemId: item.id, expectedAdapterHash: filmSetItemAdapterHash(item),
      binding: bound ? null : { itemId: item.id, playback: { startTime: 0, duration: 0, timeScale: 1, loop: false } } };
    try {
      const result = await ctx.canvasEdit.record([{ type: "filmSet.clipPatch", nodeId, clipId: clip.id, op,
        expectedHash: filmSetClipPrecondition(collection, clip.id, op) }], bound ? "移除当前镜头动作" : "启用当前镜头动作");
      if (!result.ok) setError(`${clip.name} / ${item.name}：${result.reason}`);
    } catch { setError("镜头动作修改失败，请重试。"); }
    finally { setBusy(false); }
  };
  return <div className="film-set-object-binding" key={`${clip.id}:${item.id}`}>
    <p className="film-set-object-hint">在镜头 {clip.name} 中的动作 · 仅影响此镜头</p>
    <Button size="sm" title={bound ? "仅解除此镜头的动作关联，保留场景对象。" : "启用动作关联，不改变可见性或自动生成运动。"} disabled={!writable} loading={busy} onClick={() => void bind()}>{bound ? "移除当前镜头动作" : "为此镜头启用对象动作"}</Button>
    {error ? <p className="film-set-object-error">{error}</p> : null}
  </div>;
}
