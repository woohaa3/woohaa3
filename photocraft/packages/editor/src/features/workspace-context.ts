import type { EditorHandle, EditorResult, EditorFailure } from "../editor-wasm.js";
import type { EditorViewModel } from "../editor-view-model.js";

/**
 * 文档归属（宿主提供的稳定身份）
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
 *
 * 只看「修订 + 内容指纹」认不出一种情况：关闭后重新打开同一节点、或权威内容被替换
 * （`beginContentReplacement`）时，新文档可能恰好又是修订 1 且内容 hash 相同。此时旧计划
 * 在数值上完全匹配，却来自已经销毁的文档。`generation` 由宿主持有并在重建时递增，是唯一
 * 能区分「同一份内容的旧会话」与「当前会话」的信号。
 */
export type FeatureDocumentOwner = {
  /** 宿主文档 id；不接宿主的场景（dev、测试替身）为 null。 */
  documentId: string | null;
  /** 文档代际：重新打开同一节点/替换内容后递增。 */
  generation: number;
};

/**
 * 矢量命令的文档代际令牌（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3）。
 *
 * 手势开始时取得，提交时回传：文档已切换/会话已重建时命令被丢弃，绝不写入后来活动文档。
 * 只含**文档身份**，不含 revision——一次手势本来就会推进 revision（曲率钢笔还是两条命令）。
 */
export type VectorDocumentToken = { generation: number; session: number | null };

/** Shared lifecycle authority. Domain sessions never replace the document/history/save owner. */
export interface WorkspaceFeatureContext {
  readonly handle: EditorHandle | null;
  readonly view: EditorViewModel;
  /**
   * 工作区阶段（`idle`/`editing`/`freezing`/`saving`/`failed`）。
   *
   * 域会话需要它来拒绝「导出/保存进行中」的写入（change: 2026-10-22-add-photocraft-file-workflows，
   * 任务 3.3）；只读，不暴露控制器本身，域不能借此推进状态。精简宿主可省略（按「不阻塞」处理）。
   */
  readonly phase?: string;
  /** 仍有未权威确认的冻结产物（上次保存失败后待重试）：与 `saving` 同样拒绝新的写入。 */
  readonly pendingArtifacts?: boolean;
  /** 当前文档归属；`generation` 变化即说明计划已属于旧文档。 */
  readonly owner: FeatureDocumentOwner;
  /** 冻结/保存进行中：此时不得接受新的内容修改。 */
  readonly saving: boolean;
  selectionModifyActive: boolean;
  retouchActive: boolean;
  filterActive: boolean;
  composeActive: boolean;
  hasActiveDraft(): boolean;
  blockingDraft(): EditorFailure | null;
  /**
   * 冻结/保存期的写入门（change: 2026-10-22-add-photocraft-painting-color-workflows，任务 3.3）。
   *
   * 为什么不能只靠 {@link blockingDraft}：它只描述「用户尚未结算的草稿」，看不到控制器私有的
   * `pendingArtifacts` 与 `freezing`/`saving` 阶段。域里绕过 `dispatch()` 直连内核的写入口
   * （绘画像素命令、矢量命令、排版、参考线）如果只查草稿门，就能在导出期间改内容，而
   * `performSave` 成功后会无条件 `commitBaseline` 清 dirty——保存后的改动会被当成已保存。
   *
   * 返回 `null` 表示可写；否则返回与共享 `dispatch()` 完全一致的 `frozen` 失败，调用方原样返回。
   */
  frozen(): EditorFailure | null;
  /**
   * 文档代际：打开／关闭／`dispose()` 时递增。
   *
   * 跨文档误写靠它判失效：异步结果（如吸管采样、预设列表）带回发起时的代际，落地前与当前
   * 代际比较，不一致即丢弃，绝不写进后来打开的另一份文档。
   */
  documentGeneration(): number;
  /** 排除「当前正在提交的矢量草稿」后的门禁：矢量命令不该被自己的草稿拦下。 */
  blockingDraftExceptVector(): EditorFailure | null;
  /** 导出/保存的冻结窗口内拒绝内容写入（与 `dispatch` 同一判定）。 */
  writesFrozen(): boolean;
  /** 当前文档代际令牌（矢量手势开始时捕获）。 */
  vectorToken(): VectorDocumentToken;
  unavailable(): EditorFailure;
  fail<T>(failure: EditorFailure): EditorResult<T>;
  afterWrite(establishBaseline?: boolean): EditorResult<EditorViewModel>;
}
