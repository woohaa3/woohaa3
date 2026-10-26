import { filmSetObjectOwnershipOf, filmSetObjectContainerId, filmSetObjectModelNodeId, filmSetObjectContainerData, remapFilmSetItemIds, decodeFilmSetNodeData, canonicalFilmSetFields, filmSetAnimationsOf, cloneFilmSetAnimations, LEGACY_FILM_SET_ANIMATION_FIELDS, isFilmSetNode, shotPreviewNodeId, managedNodeRelationOf, type ManagedNodeCopyContext, type ManagedNodeCopyEntry, type Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
/** Film-set owns all object/clip identities; the clipboard host only remaps topology. */
export function remapFilmSetManagedCopy({ nodes, nodeData, nodeIds, createId }: ManagedNodeCopyContext): readonly ManagedNodeCopyEntry[] {
  const idMap = new Map(nodeIds);
  const filmSetClipIds = new Map<string, Map<string, string>>();
  const filmSetItemIds = new Map<string, Map<string, string>>();
  for (const node of nodes) {
    const data = nodeData[node.id];
    if (!data || !isFilmSetNode(node.type, data)) continue;
    const decoded = decodeFilmSetNodeData(data);
    if (!decoded.ok) continue;
    filmSetItemIds.set(node.id, new Map(decoded.value.filmSetContent.items.map((item, index) => [item.id, createId("film-object", index)])));
    const clips = filmSetAnimationsOf(decoded.value).clips;
    filmSetClipIds.set(node.id, new Map(clips.map((clip, index) => [clip.id, createId("clip", index)])));
  }
  // 预览节点 ID 是 (filmSetNodeId, clipId) 的纯派生值：粘贴后所属片场与镜头都是新 ID，
  // 必须重算节点 ID 与归属。源片场不在载荷内（不应发生）时丢弃该预览，不产生悬空归属。
  const entries: ManagedNodeCopyEntry[] = [];
  for (const node of nodes) {
    const object = filmSetObjectOwnershipOf(nodeData[node.id]);
    if (object) {
      const newOwner = idMap.get(object.filmSetNodeId), newItem = filmSetItemIds.get(object.filmSetNodeId)?.get(object.itemId);
      if (!newOwner || !newItem) throw Error("managed-copy-owner-missing");
      // The nested model3d child has the same ownership record as its outer shell,
      // but keeps its own stable derived identity and complete model snapshot.
      const isModelChild = node.type === "model3d"
        && node.id === filmSetObjectModelNodeId(object.filmSetNodeId, object.itemId);
      idMap.set(node.id, isModelChild
        ? filmSetObjectModelNodeId(newOwner, newItem)
        : filmSetObjectContainerId(newOwner, newItem));
      entries.push({ sourceNodeId: node.id, nodeId: idMap.get(node.id)!, data: isModelChild
        ? { ...nodeData[node.id], filmSetObject: { schemaVersion: 1, filmSetNodeId: newOwner, itemId: newItem } } as import("@woohaa3/contracts").CanvasNodeData
        : filmSetObjectContainerData(newOwner, newItem) });
      continue;
    }
    const managed = managedNodeRelationOf(nodeData[node.id]);
    if (managed?.extensionId !== "film-set") continue;
    const newOwner = idMap.get(managed.ownerNodeId);
    const newClipId = filmSetClipIds.get(managed.ownerNodeId)?.get(managed.entityId);
    if (!newOwner || !newClipId) throw Error("managed-copy-owner-missing");
    idMap.set(node.id, shotPreviewNodeId(newOwner, newClipId));
    // Cached output belongs to the original source. The new owner resolves its
    // own immutable media through the provider after the atomic paste.
    entries.push({ sourceNodeId: node.id, nodeId: idMap.get(node.id)!, data: {
      managedBy: { ...managed, ownerNodeId: newOwner, entityId: newClipId },
      mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: newOwner, clipId: newClipId } }
    } });
  }

  for (const node of nodes) {
    const data = nodeData[node.id];
    if (!data || !isFilmSetNode(node.type, data)) continue;
    const remapped = remapFilmSetNodeData(data, filmSetItemIds.get(node.id), filmSetClipIds.get(node.id));
    if (!remapped) throw Error("managed-copy-invalid-source");
    entries.push({ sourceNodeId: node.id, nodeId: idMap.get(node.id)!, data: remapped });
  }
  return entries;
}

function remapFilmSetNodeData(
  data: Woohaa3CanvasJsonObject,
  itemIds: Map<string, string> | undefined,
  clipIds: Map<string, string> | undefined
): Woohaa3CanvasJsonObject | null {
  const decoded = decodeFilmSetNodeData(data);
  if (!decoded.ok) return null;
  if (!clipIds || !itemIds) return null;
  const content = remapFilmSetItemIds(decoded.value.filmSetContent, item => itemIds.get(item.id)!);
  const collection = cloneFilmSetAnimations(filmSetAnimationsOf(decoded.value));
  collection.defaultClipId = collection.defaultClipId ? clipIds.get(collection.defaultClipId)! : null;
  for (const clip of collection.clips) {
    clip.id = clipIds.get(clip.id)!;
    for (const binding of clip.bindings) binding.itemId = itemIds.get(binding.itemId)!;
  }
  const shared = { ...data };
  if (Array.isArray(shared.filmSetObjectContainersHidden)) shared.filmSetObjectContainersHidden = shared.filmSetObjectContainersHidden.flatMap(id => typeof id === "string" && itemIds.has(id) ? [itemIds.get(id)!] : []);
  delete shared.filmSetShotPreviewsHidden;
  for (const field of LEGACY_FILM_SET_ANIMATION_FIELDS) delete shared[field];
  return { ...shared, ...canonicalFilmSetFields({ ...decoded.value, filmSetContent: content, filmSetAnimations: collection }) } as Woohaa3CanvasJsonObject;
}
