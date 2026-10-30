/**
 * 便签节点的规范类型常量。
 *
 * 便签是一张独立的纸色卡片：能写、能拖、能贴在卡片上，但**不连线、不执行、不可聚焦**。
 * 它和普通素材卡（text/image/video/audio）是两种东西，绘制走完全不同的路径
 * （`bevy/src/canvas2d/sticky_note.rs`）。
 *
 * 单独成文件只为一件事：让 `normalization.ts` 的类型白名单与别处的判定引用**同一个字面量**。
 * 白名单漏掉的类型会被当成未知类型收敛为 `custom`，连带 nodeData 一起剪掉 ——
 * 便签踩过这个坑：类型变 `custom`、正文丢失，画出来就是一张没有内容的普通卡片。
 */
export const STICKY_NOTE_NODE_TYPE = "sticky-note" as const;

export type StickyNoteNodeType = typeof STICKY_NOTE_NODE_TYPE;

/** 便签正文在 nodeData 里的字段名。只有这一个字段，没有任务/生成语义。 */
export const STICKY_NOTE_TEXT_FIELD = "note" as const;

/** 是否为便签节点类型。 */
export function isStickyNoteNodeType(type: string | undefined): boolean {
  return type === STICKY_NOTE_NODE_TYPE;
}
