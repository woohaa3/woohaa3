import { filmSetNodeDataCodec, filmSetObjectOwnershipOf, isFilmSetNode, shotPreviewNodeId, managedNodeRelationOf, readFilmSetGroupMarker, type ManagedNodeCopyContext, type ManagedNodeCopyEntry, type Woohaa3CanvasJsonObject } from "@woohaa3/contracts";

/** Copy group orchestration and live resource identities as one closure. */
export function remapFilmSetManagedCopy({ nodes, nodeData, nodeIds, createId }: ManagedNodeCopyContext): readonly ManagedNodeCopyEntry[] {
  const copiedGroups = new Map<string, { data: unknown; remap: Readonly<Record<string, string>> }>();
  for (const node of nodes) {
    const data = nodeData[node.id];
    if (filmSetObjectOwnershipOf(data) || isFilmSetNode(node.type, data)) throw Error("managed-copy-migration-required");
    const group = node.type === "group" ? readFilmSetGroupMarker(data) : null;
    if (!group) continue;
    copiedGroups.set(node.id, filmSetNodeDataCodec.copy(data, { nodeIds, createId }));
  }
  const entries: ManagedNodeCopyEntry[] = [];
  for (const node of nodes) {
    const data = nodeData[node.id];
    const copied = copiedGroups.get(node.id);
    if (copied) {
      const owner = nodeIds.get(node.id);
      if (!owner) throw Error("managed-copy-owner-missing");
      entries.push({ sourceNodeId: node.id, nodeId: owner, data: copied.data as Woohaa3CanvasJsonObject });
      continue;
    }
    const relation = managedNodeRelationOf(data);
    if (relation?.extensionId !== "film-set") continue;
    const owner = nodeIds.get(relation.ownerNodeId);
    const clip = copiedGroups.get(relation.ownerNodeId)?.remap[`clip:${relation.entityId}`];
    if (!owner || !clip) throw Error("managed-copy-owner-missing");
    entries.push({ sourceNodeId: node.id, nodeId: shotPreviewNodeId(owner, clip), data: {
      managedBy: { ...relation, ownerNodeId: owner, entityId: clip },
      mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: owner, clipId: clip } }
    } });
  }
  return entries;
}
