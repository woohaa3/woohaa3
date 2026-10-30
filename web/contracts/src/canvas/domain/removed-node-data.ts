/**
 * 已从文档模型删除的 nodeData 展示字段（change: 2026-10-30-remove-group-badge-scaling）。
 *
 * 这些字段不再参与呈现，也不得写回权威文档：读取、复制与旧片场迁移都按未知展示字段丢弃。
 * 集中在这里可以让读取收敛、剪贴板和迁移共用同一份清单，而不是各自复制字段名。
 */
export const NODE_DATA_REMOVED_FIELDS = ["groupBadgeScale"] as const;

/** 原地删除已移除字段；输入必须是纯 JSON 对象。 */
export function omitRemovedNodeDataFields<T extends Record<string, unknown>>(value: T): T {
  for (const field of NODE_DATA_REMOVED_FIELDS) delete value[field];
  return value;
}
