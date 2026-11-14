import { decodeSceneAreaData, decodeWorldInstanceData, executeModelScriptVersioned, directorCharacterScript, type SomaBodyPresetId, type DirectorCapsulePreset, v2SceneAabb,
  type ServerCanvas, type WorldObjectIdentity } from "@woohaa3/contracts";
import { instanceFootprint, worldObjectVersion, type AuthorityCache } from "./authority.js";
import { SpatialLeaseError } from "./spatial-leases.js";

/** Called inside the canonical SQLite transaction, after user access checks. */
export function directorCharacterCommitTargets(before: ServerCanvas, after: ServerCanvas,
  cacheFor: (areaId: string, scopeVersion: string) => AuthorityCache | null): WorldObjectIdentity[] {
  const targets: WorldObjectIdentity[] = [];
  const createdBoxes: Array<{ min: {u:number;v:number}; max: {u:number;v:number} }> = [];
  for (const node of after.document.nodes) {
    if (before.nodeData[node.id]) continue;
    const fields = after.nodeData[node.id];
    const marker = fields?.directorCharacterCreation as { areaId?: unknown; scopeVersion?: unknown; kind?: unknown; bodyPreset?: unknown; capsulePreset?: unknown } | undefined;
    if (!marker) continue;
    if (typeof marker.areaId !== "string" || typeof marker.scopeVersion !== "string" || (marker.kind !== "capsule" && marker.kind !== "humanoid")) throw new SpatialLeaseError("invalid-data");
    const areaNode = before.document.nodes.find(n => { const a = decodeSceneAreaData(before.nodeData[n.id]?.sceneArea); return a.ok && a.value.areaId === marker.areaId; });
    const area = decodeSceneAreaData(areaNode && before.nodeData[areaNode.id]?.sceneArea);
    const afterArea = decodeSceneAreaData(areaNode && after.nodeData[areaNode.id]?.sceneArea);
    if (!area.ok || !afterArea.ok || area.value.scopeVersion !== marker.scopeVersion || JSON.stringify(area.value) !== JSON.stringify(afterArea.value)) throw new SpatialLeaseError("outside-scope");
    let expectedScript: string;
    try { expectedScript = directorCharacterScript(marker.kind, marker.bodyPreset as SomaBodyPresetId | undefined, marker.capsulePreset as DirectorCapsulePreset | undefined); }
    catch { throw new SpatialLeaseError("invalid-data"); }
    if (fields.modelScriptLanguage !== "javascript" || fields.modelScript !== expectedScript || fields.modelScriptVersion !== "woohaa-model-js-v2") throw new SpatialLeaseError("invalid-data");
    const model = decodeWorldInstanceData(fields.sharedWorldInstance);
    if (!model.ok || model.value.transform.scale !== 1 || JSON.stringify(model.value.transform.rotation) !== "[0,0,0,1]" || model.value.transform.position.h !== 0) throw new SpatialLeaseError("invalid-data");
    const compiled = executeModelScriptVersioned(fields.modelScript as string, fields.modelScriptVersion);
    const local = compiled.ok ? v2SceneAabb(compiled.scene.ops) : null;
    if (!local) throw new SpatialLeaseError("unavailable");
    const box = instanceFootprint(local, model.value.transform), bounds = area.value.bounds;
    if (box.min.u < bounds.min.u || box.min.v < bounds.min.v || box.max.u > bounds.max.u || box.max.v > bounds.max.v) throw new SpatialLeaseError("outside-scope");
    for (const other of createdBoxes) if (box.min.u < other.max.u + 0.08 && box.max.u > other.min.u - 0.08 && box.min.v < other.max.v + 0.08 && box.max.v > other.min.v - 0.08) throw new SpatialLeaseError("outside-scope");
    createdBoxes.push(box);
    const cache = cacheFor(marker.areaId, marker.scopeVersion);
    if (!cache || cache.kind !== "scene-area") throw new SpatialLeaseError("unavailable");
    for (const existing of before.document.nodes) {
      const decoded = decodeWorldInstanceData(before.nodeData[existing.id]?.sharedWorldInstance);
      if (!decoded.ok) continue;
      const record = cache.instances.get(decoded.value.instanceId);
      if (!record?.localAabb || worldObjectVersion(before, record.identity) !== record.version) throw new SpatialLeaseError("unavailable");
      const other = instanceFootprint(record.localAabb, decoded.value.transform);
      const touchesArea = other.min.u <= bounds.max.u && other.max.u >= bounds.min.u && other.min.v <= bounds.max.v && other.max.v >= bounds.min.v;
      if (touchesArea) targets.push(record.identity);
      if (box.min.u < other.max.u + 0.08 && box.max.u > other.min.u - 0.08 && box.min.v < other.max.v + 0.08 && box.max.v > other.min.v - 0.08) throw new SpatialLeaseError("outside-scope");
    }
    for (const record of cache.cameras.values()) {
      const p = record.data.position;
      if (p.u >= bounds.min.u && p.u <= bounds.max.u && p.v >= bounds.min.v && p.v <= bounds.max.v) targets.push(record.identity);
    }
  }
  return targets;
}
