
import { type GameFurnaceState } from "../shared/index.js";
import { type GamePackageManifest } from "../shared/package.js";
import { type Runtime } from "./runtime.js";

export async function readBuildResources(rt: Runtime, manifest: GamePackageManifest): Promise<Map<string, { bytes: Uint8Array; contentType: string }>> {
  const out = new Map<string, { bytes: Uint8Array; contentType: string }>();
  if (!rt.services.media.resources) return out;
  const project = [...rt.projects.values()].find((candidate) => candidate.state.builds.some((build) => build.buildId === manifest.buildId));
  const resourceByAssetId = new Map<string, GameFurnaceState["resources"][number]>();
  if (project) {
    for (const resource of project.state.resources) {
      for (const id of resource.payload.assetIds) resourceByAssetId.set(id, resource);
      if (resource.metadata?.previewAssetId) resourceByAssetId.set(resource.metadata.previewAssetId, resource);
    }
  }
  for (const entry of manifest.resources) {
    // 冻结键优先（不依赖当前素材仍然存在）；否则回退到当前项目的稳定键（旧 manifest）。
    const storageKey = entry.storageKey || (entry.assetId ? resourceByAssetId.get(entry.assetId)?.metadata?.storageKey : undefined);
    if (typeof storageKey !== "string" || storageKey === "") continue;
    try {
      const value = await rt.services.media.resources.read(storageKey);
      out.set(entry.assetId, { bytes: value.bytes, contentType: value.contentType });
    } catch { throw Error(`构建素材不可读：${entry.path}`); }
  }
  return out;
}
