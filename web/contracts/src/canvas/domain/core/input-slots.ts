type Woohaa3CanvasSlotMapping = {
  slotId?: string;
  sourceNodeId: string;
  sortKey?: string;
};

const INPUT_MENTION_TYPE_LABELS: Record<string, string> = {
  input_image: "图片",
  input_video: "视频",
  input_audio: "音频",
  input_text: "文本",
};

/**
 * Creates a repeatable slot identity for legacy mappings. New mappings should
 * persist this value immediately; the deterministic fallback keeps read-time
 * migration stable before the first write.
 */
export function createWoohaa3CanvasInputSlotId(
  sourceNodeId: string,
  sortKey?: string,
): string {
  const stableKey = sortKey ?? "source";
  return `slot-${encodeURIComponent(sourceNodeId)}-${encodeURIComponent(stableKey)}`;
}

export function ensureWoohaa3CanvasInputMappingSlotId<T extends Woohaa3CanvasSlotMapping>(
  mapping: T,
): T & { slotId: string } {
  return mapping.slotId
    ? mapping as T & { slotId: string }
    : {
        ...mapping,
        slotId: createWoohaa3CanvasInputSlotId(mapping.sourceNodeId, mapping.sortKey),
      };
}

export function sortWoohaa3CanvasInputMappings<T extends Woohaa3CanvasSlotMapping>(
  mappings: readonly T[],
): T[] {
  return mappings
    .map((mapping, index) => ({ mapping, index }))
    .sort((left, right) => {
      const leftKey = String(left.mapping.sortKey ?? left.index);
      const rightKey = String(right.mapping.sortKey ?? right.index);
      const leftNumber = Number(leftKey);
      const rightNumber = Number(rightKey);
      const sort = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
        ? leftNumber - rightNumber
        : leftKey.localeCompare(rightKey);
      return sort || left.index - right.index;
    })
    .map(({ mapping }) => mapping);
}

export function woohaa3CanvasInputMentionDisplayLabel(type: string, ordinal: number): string {
  return `@${INPUT_MENTION_TYPE_LABELS[type] ?? "素材"} ${ordinal}`;
}

export function woohaa3CanvasInputMentionLabel(type: string, ordinal: number): string {
  return woohaa3CanvasInputMentionDisplayLabel(type, ordinal).slice(1);
}

/** `nodeData` 里记录「本节点自带主图」的资产 id；空串或缺失表示没有。 */
export const SELF_REFERENCE_ASSET_FIELD = "selfReferenceAssetId";

/**
 * 「节点自带主图」映射：节点把自己当前的图当作参考输入（上传图 → 添加到对话框 → 结果回到本节点）。
 *
 * 为什么不用 `inputMapping`：画布规则是「映射 ⇔ 入边」，自连边会被连线规则拒绝，规范化也会清掉没有
 * 入边的映射；所以单独用一个 `nodeData` 字段记资产 id，在读取解析时合成这条映射，排在所有入边之前。
 * 固定到记录时的资产（`sourceAssetIds`），生成后节点显示新图也不影响这次的参考。
 */
export function selfReferenceMapping(
  nodeId: string,
  data: Record<string, unknown> | undefined,
): { slotId: string; sourceNodeId: string; sourceAssetIds: string[]; role: string; sortKey: string; label: string } | null {
  const assetId = data?.[SELF_REFERENCE_ASSET_FIELD];
  if (typeof assetId !== "string" || assetId === "") return null;
  return {
    slotId: createWoohaa3CanvasInputSlotId(nodeId, "self"),
    sourceNodeId: nodeId,
    sourceAssetIds: [assetId],
    role: "reference_image",
    sortKey: "-1",
    label: "主图像",
  };
}
