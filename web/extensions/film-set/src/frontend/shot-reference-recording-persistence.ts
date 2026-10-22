/**
 * 录制成功后立即登记真实资产，不依赖下游镜头参考映射。
 * 等待权威提交成功后，录制方才发布 ready；刷新后由画布 assets 回填版本缓存。
 */
import type { FilmSetContext as Context } from "./context.js";
import {
  buildShotReferenceAsset,
  shotReferenceAssetId,
  type ShotReferenceFreezeRequest,
  type ShotReferenceReadyAsset
} from "./shot-reference-canonical.js";

export async function persistShotReferenceRecording(
  ctx: Context,
  ref: ShotReferenceFreezeRequest,
  asset: ShotReferenceReadyAsset,
  title: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  // 幂等判断只认权威资产，不能把尚未提交成功的工作副本当作已保存。
  const canvas = ctx.canvasState.getCanvas();
  if (!canvas || canvas.id !== ref.canvasId) return { ok: false, error: "画布已切换，镜头视频未能登记" };
  if (!ctx.canvasSession.isWritable()) return { ok: false, error: "画布不可写，镜头视频未能登记" };
  const existing = canvas.assets.find(entry => entry.id === shotReferenceAssetId(ref));
  if (existing?.status === "ready"
    && existing.metadata?.storageKey === asset.storageKey
    && existing.metadata?.checksum === asset.checksum) return { ok: true };

  try {
    const submitted = ctx.canvasSession.submitCommands([{
      type: "asset.upsert",
      asset: buildShotReferenceAsset(ref, asset, title, new Date().toISOString())
    }], `shot-reference-recording-${crypto.randomUUID()}`);
    if (!submitted.ok) return { ok: false, error: `镜头视频登记失败：${submitted.reason}` };
    const settled = await submitted.handle.settled;
    if (settled.state === "rejected") return { ok: false, error: `镜头视频登记失败：${settled.error ?? "提交被拒绝"}` };
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: `镜头视频登记失败：${cause instanceof Error ? cause.message : String(cause)}` };
  }
}
