/** Old shot codecs are interpreted only at this explicit offline boundary. */
import { decodeFilmSetNodeData, decodeShotPreviewData, filmSetAnimationsOf, isFilmSetNode, managedNodeRelationOf, ManagedNodeLifecycleRegistry, planManagedNodeLifecycles, type ManagedNodeMigrationAdapter } from "@woohaa3/contracts";
import { managedShotMediaData, managedShotMediaNodeId, managedShotMediaType } from "./managed-shot-media.js";
import { filmSetManagedLifecycle } from "./managed-shot-media-lifecycle.js";

export const filmSetManagedMediaMigration: ManagedNodeMigrationAdapter = {
  extensionId: "film-set", schemaVersion: 1,
  migrate(input) {
    const canvas = structuredClone(input), entities = new Set<string>();
    for (const node of canvas.document.nodes) {
      const data = canvas.nodeData[node.id];
      const relation = managedNodeRelationOf(data);
      const legacy = node.type === "film-set-shot-preview" || data?.shotPreview !== undefined;
      if (!legacy && relation?.extensionId !== "film-set") continue;
      if (data?.managedBy !== undefined && (!relation || relation.extensionId !== "film-set")) throw Error(`managed-media-migration-conflict: ${canvas.id}/${node.id}`);
      const decoded = legacy ? decodeShotPreviewData(data) : null;
      if (legacy && !decoded?.ok) throw Error(`managed-media-migration-invalid-owner: ${canvas.id}/${node.id}`);
      if (legacy && relation && decoded?.ok && (relation.ownerNodeId !== decoded.value.shotPreview.filmSetNodeId || relation.entityId !== decoded.value.shotPreview.clipId)) throw Error(`managed-media-migration-conflict: ${canvas.id}/${node.id}`);
      const ownerId = relation?.ownerNodeId ?? (decoded?.ok ? decoded.value.shotPreview.filmSetNodeId : "");
      const clipId = relation?.entityId ?? (decoded?.ok ? decoded.value.shotPreview.clipId : "");
      const owner = canvas.document.nodes.find(n => n.id === ownerId);
      if (!owner || !isFilmSetNode(owner.type, canvas.nodeData[ownerId])) throw Error(`managed-media-migration-source-missing: ${canvas.id}/${node.id}`);
      const source = decodeFilmSetNodeData(canvas.nodeData[ownerId]);
      const clip = source.ok ? filmSetAnimationsOf(source.value).clips.find(c => c.id === clipId) : null;
      if (!clip || node.id !== managedShotMediaNodeId(ownerId, clipId) || (node.parentId ?? null) !== (owner.parentId ?? null)) throw Error(`managed-media-migration-conflict: ${canvas.id}/${node.id}`);
      const key = JSON.stringify([ownerId, clipId]);
      if (entities.has(key)) throw Error(`managed-media-migration-duplicate: ${canvas.id}/${node.id}`);
      entities.add(key);
      if (!legacy) {
        const media = data?.mediaContent;
        if (node.type !== managedShotMediaType(clip) || relation?.schemaVersion !== 1 || relation.extensionId !== "film-set" || relation.lifecycle !== "owner-managed"
          || !media || media.providerId !== "film-set.shot" || media.schemaVersion !== 1
          || media.payload.filmSetNodeId !== ownerId || media.payload.clipId !== clipId) throw Error(`managed-media-migration-conflict: ${canvas.id}/${node.id}`);
        continue;
      }
      const oldContent = data?.mediaContent;
      if (oldContent && (oldContent.providerId !== "film-set.shot" || oldContent.schemaVersion !== 1 || oldContent.payload.filmSetNodeId !== ownerId || oldContent.payload.clipId !== clipId)) throw Error(`managed-media-migration-conflict: ${canvas.id}/${node.id}`);
      node.type = managedShotMediaType(clip);
      const next = { ...data, ...managedShotMediaData(ownerId, clip) };
      delete next.shotPreview;
      canvas.nodeData[node.id] = next;
    }
    const registry = new ManagedNodeLifecycleRegistry(); registry.register(filmSetManagedLifecycle);
    const result = planManagedNodeLifecycles({ before: canvas, canvas, positionedNodeIds: [] }, registry);
    return { canvas: result, changed: JSON.stringify(result) !== JSON.stringify(input) };
  }
};
