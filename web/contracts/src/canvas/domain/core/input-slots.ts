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
