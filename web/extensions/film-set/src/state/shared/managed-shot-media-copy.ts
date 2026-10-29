import { filmSetObjectOwnershipOf, isFilmSetNode, shotPreviewNodeId, managedNodeRelationOf, readFilmSetGroupMarker, type ManagedNodeCopyContext, type ManagedNodeCopyEntry, type Woohaa3CanvasJsonObject } from "@woohaa3/contracts";

/** Copy group orchestration and live resource identities as one closure. */
export function remapFilmSetManagedCopy({ nodes, nodeData, nodeIds, createId }: ManagedNodeCopyContext): readonly ManagedNodeCopyEntry[] {
  const clipIds = new Map<string, Map<string, string>>();
  const bindingIds = new Map<string, Map<string, string>>();
  for (const node of nodes) {
    const data = nodeData[node.id];
    if (filmSetObjectOwnershipOf(data) || isFilmSetNode(node.type, data)) throw Error("managed-copy-migration-required");
    const group = node.type === "group" ? readFilmSetGroupMarker(data) : null;
    if (!group) continue;
    clipIds.set(node.id, new Map((group.clips ?? []).map((clip, index) => [clip.id, createId("clip", index)])));
    bindingIds.set(node.id, new Map(group.sceneBindings.map((binding, index) => [binding.bindingId, createId("film-binding", index)])));
  }
  const entries: ManagedNodeCopyEntry[] = [];
  for (const node of nodes) {
    const data = nodeData[node.id];
    const group = node.type === "group" ? readFilmSetGroupMarker(data) : null;
    if (group) {
      const owner = nodeIds.get(node.id);
      if (!owner) throw Error("managed-copy-owner-missing");
      const remapBinding = (id: string) => bindingIds.get(node.id)?.get(id) ?? (() => { throw Error("managed-copy-binding-missing"); })();
      const sceneBindings = group.sceneBindings.map(binding => ({ ...binding, bindingId: remapBinding(binding.bindingId),
        sourceNodeId: nodeIds.get(binding.sourceNodeId) ?? (() => { throw Error("managed-copy-group-source-missing"); })() }));
      const clips = (group.clips ?? []).map(clip => ({ ...clip, id: clipIds.get(node.id)!.get(clip.id)!,
        ...(clip.bindings ? { bindings: clip.bindings.map(binding => ({ ...binding, itemId: remapBinding(binding.itemId) })) } : {}) }));
      const activeClip = group.activeClip ? clipIds.get(node.id)!.get(group.activeClip) ?? null : group.activeClip;
      const { migration: _migration, ...orchestration } = group;
      entries.push({ sourceNodeId: node.id, nodeId: owner, data: { ...data, filmSetGroup: { ...orchestration, sceneBindings, clips,
        ...(activeClip === undefined ? {} : { activeClip }) } } as Woohaa3CanvasJsonObject });
      continue;
    }
    const relation = managedNodeRelationOf(data);
    if (relation?.extensionId !== "film-set") continue;
    const owner = nodeIds.get(relation.ownerNodeId), clip = clipIds.get(relation.ownerNodeId)?.get(relation.entityId);
    if (!owner || !clip) throw Error("managed-copy-owner-missing");
    entries.push({ sourceNodeId: node.id, nodeId: shotPreviewNodeId(owner, clip), data: {
      managedBy: { ...relation, ownerNodeId: owner, entityId: clip },
      mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: owner, clipId: clip } }
    } });
  }
  return entries;
}
