/**
 * 批量导入状态、身份与确定性布局
 * （change: add-paste-import-workflows，任务 2.3 / 2.4 / 4.1 / design D4/D6）。
 *
 * 纯数据与纯函数：文件选择、paste、drop 都形成 `ImportRequest`，由 Import Service 逐文件
 * 独立原子提交。这里不接触 DOM / fetch / store。
 */
import { createHighEntropyId, DEFAULT_NODE_DIMS, type Woohaa3CanvasPosition } from "@woohaa3/contracts";

export type ImportSource = "picker" | "paste" | "drop";

/** 逐文件导入阶段；失败阶段可精确诊断（spec「失败阶段」）。 */
export type ImportItemStage =
  | "pending"
  | "reading"
  | "hashing"
  | "uploading"
  | "submitting"
  | "done"
  | "failed"
  | "cancelled";

export type ImportItem = {
  /** 稳定 item/operation identity；迟到异步结果据此忽略。 */
  id: string;
  name: string;
  kind: "image" | "video" | "audio" | "text" | null;
  size: number;
  stage: ImportItemStage;
  /** 安全错误摘要（不含 URL/授权信息）。 */
  error?: string;
  /** 提交成功后的新节点 ID。 */
  nodeId?: string;
};

/** 结果汇总；成功项保留，失败项可诊断。 */
export type ImportBatchResult = {
  ok: boolean;
  succeeded: number;
  failed: number;
  items: readonly ImportItem[];
};

/** 单文件读取文本的字节上限（spec「受控大小/编码」）。 */
export const MAX_TEXT_FILE_BYTES = 1 * 1024 * 1024;

/** 单次批量并发上传上限。 */
export const IMPORT_CONCURRENCY = 3;

/** 多文件布局的确定性网格间距（含节点默认尺寸，避免完全重叠）。 */
const LAYOUT_GAP_X = 32;
const LAYOUT_GAP_Y = 32;
const LAYOUT_COLUMNS = 3;

let importSequence = 0;

/** 与执行面板一致的“是否进行中”判定（替换资格与重试共用）。 */
export function isProcessingStatus(status: unknown): boolean {
  return status === "pending" || status === "processing";
}

/** 稳定 import item ID（同一次请求内唯一，跨请求不冲突）。 */
export function createImportItemId(): string {
  importSequence += 1;
  return `${createHighEntropyId("import-item")}-${importSequence.toString(36)}`;
}

/**
 * 确定性多文件布局：锚点为首项位置，后续按固定列数网格排列，考虑节点默认尺寸。
 * `zoom` 仅用于让间距在世界坐标中保持可读（缩放越大间距越小）。
 */
export function planImportLayout(
  anchor: Woohaa3CanvasPosition,
  count: number,
  zoom = 1
): Woohaa3CanvasPosition[] {
  const safeZoom = zoom > 0 ? zoom : 1;
  const stepX = (DEFAULT_NODE_DIMS.width + LAYOUT_GAP_X) / safeZoom;
  const stepY = (DEFAULT_NODE_DIMS.height + LAYOUT_GAP_Y) / safeZoom;
  const positions: Woohaa3CanvasPosition[] = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % LAYOUT_COLUMNS;
    const row = Math.floor(index / LAYOUT_COLUMNS);
    positions.push({ x: anchor.x + column * stepX, y: anchor.y + row * stepY });
  }
  return positions;
}

export function summarizeItems(items: readonly ImportItem[]): ImportBatchResult {
  const succeeded = items.filter((item) => item.stage === "done").length;
  const failed = items.filter((item) => item.stage === "failed").length;
  return { ok: failed === 0, succeeded, failed, items };
}
