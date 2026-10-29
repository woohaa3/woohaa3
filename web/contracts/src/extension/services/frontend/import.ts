// 定义处：@woohaa3/contracts —— 前端 Cordis 根的服务契约；web/frontend 只做实现与 re-export。
/**
 * 本地文件导入 capability 契约（Media Import / Paste Import 提供）。
 * 从 `contracts.ts` façade 拆分（change: 2026-09-28-split-frontend-god-plugins，task 1.5）。
 */

export type ImportAnchor = {
  world: { x: number; y: number; z?: number } | null;
  connectFrom?: { nodeId: string; nodeType: string };
};

/** 导入入口来源（picker 右键上传 / clipboard paste / 拖放）。 */
export type ImportSource = "picker" | "paste" | "drop";

/** 逐文件导入阶段；失败阶段用于精确诊断。 */
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
  kind: "image" | "video" | "audio" | "text" | "model3d" | null;
  size: number;
  stage: ImportItemStage;
  /** 安全错误摘要（不含 URL、授权信息或完整正文）。 */
  error?: string;
  /** 提交成功后的新节点 ID。 */
  nodeId?: string;
};

export type ImportBatchResult = {
  ok: boolean;
  succeeded: number;
  failed: number;
  items: readonly ImportItem[];
};

/** 一次批量导入请求：文件选择、paste、drop 复用同一 coordinator。 */
export type ImportBatchInput = {
  files: readonly File[];
  anchor: ImportAnchor;
  source: ImportSource;
  selectedNodeIds: readonly string[];
};

export type ImportState = {
  uploading: boolean;
  error: string | null;
  /** 最近一次批量结果（逐项状态）；无则为空数组。 */
  items: readonly ImportItem[];
};

/** 本地文件导入（feature-owned capability；复用 Media Remote 与 Canvas Session）。 */
export interface ImportService {
  /** 打开单选文件选择器；选中后走批量 coordinator。 */
  requestFile(anchor: ImportAnchor): void;
  /** 打开可多选文件选择器；选中后走 importBatch。 */
  requestFiles(anchor: ImportAnchor): void;
  /** 批量 coordinator：逐文件独立原子提交，允许部分成功。 */
  importBatch(input: ImportBatchInput): Promise<ImportBatchResult>;
  /** 用当前页面存活期的 File 重试单个失败项。 */
  retryItem(itemId: string): Promise<{ ok: boolean; error?: string }>;
  /** 单图替换：上传新图片后以一个批次 upsert 资产并 patch 目标节点。 */
  replaceSelectedImage(input: { file: File; nodeId: string }): Promise<{ ok: boolean; error?: string }>;
  getState(): ImportState;
  subscribe(listener: () => void): () => void;
}
