import { createHash } from "node:crypto";
import { duplicateGameFurnace, projectIdFor, validateGameFurnaceState, type GameFurnaceState } from "../shared.js";
import { decodeManifest, decodeSourcePackage, encodeSourcePackage, type GamePackageManifest } from "../package.js";
import type { Runtime } from "./support.js";

/** 剪贴板共享不可变对象，打开新节点时才创建独立项目；全过程不查询/取消原 Task。 */
export async function forkProjectForTarget(
  rt: Runtime,
  input: { canvasId: string; nodeId: string; projectStorageKey: string },
  source: GameFurnaceState
): Promise<{ state: GameFurnaceState; projectStorageKey: string }> {
  const targetId = projectIdFor(input.canvasId, input.nodeId);
  const owner = source.projectOwner;
  const copied = owner ? owner.canvasId !== input.canvasId || owner.nodeId !== input.nodeId
    : /^gf-[0-9a-f]{16}$/.test(source.projectId) && source.projectId !== targetId;
  if (!copied) return { state: source, projectStorageKey: input.projectStorageKey };
  const media = rt.services.media.resources;
  if (!media) throw Error("缺少项目复制存储能力");
  let sequence = 0;
  const newId = () => `copy-${createHash("sha256").update(JSON.stringify([targetId, input.projectStorageKey, sequence++])).digest("hex")}`;
  const state = duplicateGameFurnace(source, newId) as GameFurnaceState;
  state.projectId = targetId;
  state.projectOwner = { canvasId: input.canvasId, nodeId: input.nodeId };
  const resourceIds = new Map(source.resources.map((resource, index) => [resource.resourceId, state.resources[index]!.resourceId]));
  for (let index = 0; index < source.builds.length; index++) {
    source.builds[index]!.resources.forEach((resource, resourceIndex) => resourceIds.set(resource.resourceId, state.builds[index]!.resources[resourceIndex]!.resourceId));
  }
  // 运行文件/路径和源码保持固定；仅重新封装本地身份，宿主不构建游戏。
  const remapManifest = (manifest: GamePackageManifest, buildId: string): GamePackageManifest => ({
    ...manifest, buildId, resources: manifest.resources.map(resource => ({ ...resource, resourceId: resourceIds.get(resource.resourceId) ?? resource.resourceId }))
  });
  for (let index = 0; index < source.builds.length; index++) {
    const old = source.builds[index]!;
    const build = state.builds[index]!;
    const manifest = decodeManifest(JSON.parse(new TextDecoder().decode((await media.read(old.manifestAssetId)).bytes)));
    const pkg = decodeSourcePackage((await media.read(old.sourceAssetId)).bytes);
    if (manifest.buildId !== old.buildId || pkg.manifest.buildId !== old.buildId) throw Error("复制构建关联不一致");
    build.manifestAssetId = (await media.write({ bytes: new TextEncoder().encode(JSON.stringify(remapManifest(manifest, build.buildId))), contentType: "application/json" })).storageKey;
    build.sourceAssetId = (await media.write({ bytes: encodeSourcePackage({ ...pkg, manifest: remapManifest(pkg.manifest, build.buildId) }), contentType: "application/json" })).storageKey;
  }
  // 所有构建重封装成功后才发布新 envelope；失败不注册半成品项目。
  validateGameFurnaceState(state);
  const projectStorageKey = (await media.write({ bytes: new TextEncoder().encode(JSON.stringify(state)), contentType: "application/json" })).storageKey;
  return { state, projectStorageKey };
}
