import { MAX_INLINE_TEXT_CHARS, MAX_INLINE_SNAPSHOT_CHARS, type GameFurnaceState } from "../shared/index.js";
import type { Runtime } from "./runtime.js";

/** 权威校验后的完整原件转存；全部成功前不发布项目关联。 */
export async function persistResourceOriginals(rt: Runtime, state: GameFurnaceState): Promise<GameFurnaceState> {
  const media = rt.services.media.resources;
  if (!media) throw Error("缺少媒体存储能力");
  let total = 0;
  const resources = [];
  const verified = new Set<string>();
  for (const resource of state.resources) {
    for (const asset of resource.payload.assets ?? []) {
      if (verified.has(asset.storageKey)) continue;
      const stored = await media.read(asset.storageKey);
      total += stored.bytes.length;
      if (stored.bytes.length > 16 * 1024 * 1024 || total > 256 * 1024 * 1024) throw Error("依赖素材超过站点预算");
      verified.add(asset.storageKey);
    }
    const snapshot = resource.payload.snapshot;
    if (!snapshot) { resources.push(resource); continue; }
    const isText = resource.kind === "text";
    const text = snapshot.text;
    const serialized = JSON.stringify(snapshot);
    const oversized = isText ? typeof text === "string" && text.length > MAX_INLINE_TEXT_CHARS
      : serialized.length > MAX_INLINE_SNAPSHOT_CHARS;
    if (!oversized) { resources.push(resource); continue; }
    const original = { ...snapshot };
    delete original.overBudget;
    const bytes = new TextEncoder().encode(isText ? text as string : JSON.stringify(original));
    total += bytes.length;
    if (bytes.length > 16 * 1024 * 1024 || total > 256 * 1024 * 1024) throw Error("素材原件超过存储预算");
    const mime = isText ? "text/plain" : "application/json";
    const saved = await media.write({ bytes, contentType: mime });
    resources.push({ ...resource,
      metadata: { ...resource.metadata, storageKey: saved.storageKey, mime, size: bytes.length },
      payload: { ...resource.payload, assetIds: [...new Set([saved.storageKey, ...resource.payload.assetIds])],
        snapshot: { overBudget: true, sourceAssetId: saved.storageKey,
          ...(isText ? { textChars: (text as string).length } : { snapshotChars: serialized.length }) } }
    });
  }
  return resources.some((resource, index) => resource !== state.resources[index]) ? { ...state, resources } : state;
}
