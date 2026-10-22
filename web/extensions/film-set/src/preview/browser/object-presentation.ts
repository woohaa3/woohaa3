import { decodeFilmSetNodeData, filmSetMediaPlanesForNode, encodeFilmSetPartId, type FilmSetLocalTransform } from "@woohaa3/contracts";
import type { CompositeAssetAdapter } from "@woohaa3/frontend/extension-api";

export type ObjectPreviewMap = ReadonlyMap<string, { itemId: string; transform: FilmSetLocalTransform }>;
export function projectObjectPresentation(preview: ObjectPreviewMap): NonNullable<CompositeAssetAdapter["projectPresentation"]> {
  return (node, data, resource) => {
        const object = preview.get(node.id);
        if (!object || !node.compositeAsset) return;
        const decoded = decodeFilmSetNodeData(data);
        if (!decoded.ok) return;
        if (node.compositeAsset.media?.some(plane => plane.itemId === object.itemId)) {
          const content = decoded.value.filmSetContent;
          node.compositeAsset.media = filmSetMediaPlanesForNode({ nodeId: node.id,
            data: { ...data, filmSetContent: { ...content, items: content.items.map(item => item.id === object.itemId ? { ...item, localTransform: object.transform } : item) } } as never,
            contentExtent: resource?.extent,
            readyPlaneIds: new Set(node.compositeAsset.media.filter(plane => plane.hasTexture).map(plane => plane.id))
          });
        }
        if (node.compositeAsset.itemPlacements) {
          const transform = object.transform;
          node.compositeAsset.itemPlacements[encodeFilmSetPartId(object.itemId, "")] = { offset: { ...transform.offset }, scale: transform.scale, yaw: transform.yaw * 180 / Math.PI };
        }
      };
}
