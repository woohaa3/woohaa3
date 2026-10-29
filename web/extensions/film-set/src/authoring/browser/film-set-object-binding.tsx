import { useState } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { filmSetClipPatchCommand, filmSetClipPrecondition, filmSetItemAdapterHash, type FilmSetAnimationClip, type FilmSetAnimations, type FilmSetItem } from "@woohaa3/contracts";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";

/** 对象加入当前镜头仍经带 precondition 的领域命令提交。 */
export function FilmSetObjectBinding({ ctx, nodeId, item, clip, collection, writable }: {
  ctx: FilmSetHostContext; nodeId: string; item: FilmSetItem; clip: FilmSetAnimationClip; collection: FilmSetAnimations; writable: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (clip.bindings.some(binding => binding.itemId === item.id)) return <p className="film-set-object-binding film-set-object-hint">当前镜头：{clip.name} · 已加入</p>;
  const bind = async () => {
    if (!writable || busy) return;
    setBusy(true); setError(null);
    const op = { kind: "binding" as const, itemId: item.id, expectedAdapterHash: filmSetItemAdapterHash(item),
      binding: { itemId: item.id, playback: { startTime: 0, duration: 0, timeScale: 1, loop: false } } };
    try {
      const result = ctx.canvasSession.submitCommands([filmSetClipPatchCommand({ nodeId, clipId: clip.id, op, expectedHash: filmSetClipPrecondition(collection, clip.id, op) })], `web-bind-${crypto.randomUUID()}`);
      if (!result.ok) { setError("加入镜头未提交，请检查连接和写入权限。"); return; }
      const outcome = await result.handle.settled;
      if (outcome.state === "rejected") setError(outcome.error ?? "加入镜头被拒绝，请重新读取后重试。");
    } catch { setError("加入镜头失败，请重试。"); }
    finally { setBusy(false); }
  };
  return <div className="film-set-object-binding" key={`${clip.id}:${item.id}`}>
    <p className="film-set-object-hint">当前镜头：{clip.name}</p>
    <Button size="sm" disabled={!writable} loading={busy} onClick={() => void bind()}>加入该镜头</Button>
    {error ? <p className="film-set-object-error">{error}</p> : null}
  </div>;
}
