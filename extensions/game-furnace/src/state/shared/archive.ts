import type { ApplicationExtensionArchiveDefinition, Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import { validateGameFurnaceState, GAME_FURNACE_SCHEMA_VERSION, type GameFurnaceState } from "./index.js";
import { decodeManifest, decodeSourcePackage } from "./package.js";

/** Offline snapshot dependency traversal; no plugin activation or task restoration. */
export async function collectGameFurnaceMediaKeys({ nodeData, read }: Parameters<ApplicationExtensionArchiveDefinition["collectMediaKeys"]>[0]) {
    const root = nodeData.projectStorageKey;
    if (root === undefined || root === null || root === "") return [];
    if (typeof root !== "string") throw Error("炼丹炉项目引用非法");
    const keys = new Set<string>([root]);
    const readJson = async (key: string): Promise<unknown> => {
      keys.add(key);
      return JSON.parse(new TextDecoder().decode((await read(key)).bytes));
    };
    const raw = await readJson(root);
    const version = raw && typeof raw === "object" ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
    if (version !== undefined && version !== GAME_FURNACE_SCHEMA_VERSION) {
      throw Error(`炼丹炉项目版本 ${version} 未知，无法证明媒体引用完整；原文保持不变`);
    }
    validateGameFurnaceState(raw as Woohaa3CanvasJsonObject);
    const state = raw as GameFurnaceState;
    for (const resource of state.resources) {
      if (resource.metadata?.storageKey) keys.add(resource.metadata.storageKey);
      for (const asset of resource.payload.assets ?? []) keys.add(asset.storageKey);
    }
    for (const generation of state.generations) {
      if (!generation.inputManifestAssetId) continue;
      const input = await readJson(generation.inputManifestAssetId) as { resources?: { storageKey?: string; assets?: { storageKey: string }[] }[] };
      if (!Array.isArray(input.resources)) throw Error("炼丹炉输入清单非法");
      for (const resource of input.resources) {
        if (resource.storageKey) keys.add(resource.storageKey);
        for (const asset of resource.assets ?? []) keys.add(asset.storageKey);
      }
    }
    for (const build of state.builds) {
      const manifest = decodeManifest(await readJson(build.manifestAssetId));
      keys.add(build.sourceAssetId);
      const source = decodeSourcePackage((await read(build.sourceAssetId)).bytes);
      if (manifest.buildId !== build.buildId || source.manifest.buildId !== build.buildId) throw Error("炼丹炉构建关联不一致");
      // 当前素材可已移除；仍须保留旧版本冻结的素材和每个 dist 静态文件。
      for (const resource of [...manifest.resources, ...source.manifest.resources]) {
        if (resource.storageKey) keys.add(resource.storageKey);
        else {
          const current = state.resources.find(value => value.resourceId === resource.resourceId);
          if (current?.metadata?.storageKey) keys.add(current.metadata.storageKey);
          else if (resource.usage === "used" && resource.assetId) throw Error("历史构建缺少冻结媒体引用");
        }
      }
      for (const file of source.site?.files ?? []) keys.add(file.storageKey);
    }
    return [...keys].sort();
}
