/**
 * 编辑器会话端口
 * （change: 2026-10-21-extract-photocraft-subproject，design D3/D4）。
 *
 * 控制器只依赖这两个**结构接口**：
 * - `EditorDocumentSession`：文档草稿的净变化、冻结/保存阶段与基线推进。语义实现由宿主适配包
 *   提供（旧标注转换、权威基线与只读判断），编辑器不拥有资产或服务端回执类型。
 * - `EditorSavePort`：把同一修订的成对产物交给宿主上传并等待权威回执。编辑器只根据结果的
 *   `retriable` 决定保留还是丢弃冻结产物，不生成请求身份、不读后端状态。
 *
 * 所以核心包不需要 import 宿主 contracts、frontend 或 services。
 */
import type { PhotocraftContentState } from "@woohaa3/photocraft-protocol";
import type { ProjectExportArtifacts } from "./editor-artifacts.js";

/** 文档草稿阶段（界面据此呈现「只读/编辑/保存中」）。 */
export type EditorSessionPhase =
  | "view"
  | "annotation"
  | "loading"
  | "editing"
  | "freezing"
  | "saving"
  | "readonly-project"
  | "error";

/** 控制器与宿主会话之间的最小契约。 */
export type EditorDocumentSession = {
  /** 是否有未提交的内容变化（由会话比较内容身份，不看取景/工具偏好）。 */
  isDirty(): boolean;
  /** 冻结导出开始；实现可拒绝当前阶段。 */
  beginFreeze(): void;
  /** 冻结取消/失败后恢复编辑（保留草稿）。 */
  resumeEditing(): void;
  /** 产物已交给宿主，等待权威回执。 */
  beginSave(): void;
  /** 保存成功：推进基线并回到编辑。 */
  commitBaseline(contentHash: string): void;
  /** 保存失败：保留现场并记录原因。 */
  failSave(message: string): void;
  /** 建立进入基线（打开 ≠ 修改）。 */
  establishBaseline(): void;
  /** 应用一次内核内容状态（内容 hash、修订号与净变化来源）。 */
  applyContentState(state: PhotocraftContentState): void;
};

/** 一次冻结保存交给宿主的载荷：产物 + 本次会话引用过的来源资产。 */
export type EditorSaveRequest = {
  artifacts: ProjectExportArtifacts;
  sourceAssetIds: string[];
  /** 会话是否仍是当前代际；退出/释放后迟到步骤必须停止，不得提交回执。 */
  isCurrent: () => boolean;
  /**
   * 宿主上报的真实保存进度（0–100）。
   *
   * 只在宿主确实能测量时调用（例如上传字节进度）；编辑器不估算百分比，也不把冻结/摘要
   * 校验折算成假进度。未调用即表示该阶段没有可报告的进度。
   */
  onProgress?: (percent: number) => void;
};

/** 保存结果。`status` 只用于呈现（历史待登记），不改变基线推进时机。 */
export type EditorSaveOutcome =
  | { ok: true; status?: "completed" | "history-pending" }
  | { ok: false; code: string; message: string; retriable: boolean };

/** 宿主保存端口：上传、回执对账与请求身份都由适配包持有。 */
export type EditorSavePort = (request: EditorSaveRequest) => Promise<EditorSaveOutcome>;
