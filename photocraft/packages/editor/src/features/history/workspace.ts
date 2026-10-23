import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import {
  decodeActionsState,
  decodeBatchProgress,
  decodeCsvImport,
  decodeExportedFiles,
  decodeHistorySample,
  decodeHistorySourceCheck,
  decodeHistoryState,
  decodePurgePlan,
  decodeQueueId,
  decodeScriptReport,
  decodeShortcuts,
  decodeUnsupported,
  decodeWarnings,
  decodeVariablesState,
  type ActionsStateView,
  type BatchProgressView,
  type ExportedFile,
  type HistorySampleView,
  type HistorySourceCheckView,
  type HistoryStateView,
  type PurgePlanView,
  type ScriptReportView,
  type UnsupportedStep,
  type VariablesStateView
} from "./model.js";

/**
 * 历史/动作/数据驱动域的领域会话
 * （change: 2026-10-22-add-photocraft-history-automation-workflows）。
 *
 * 三种工作流共用工作区的活动草稿门禁与发布路径，不复制文档或历史：
 * - **只读查询**（历史/动作/变量视图、清理范围说明、队列状态）：不产生 dirty、不推进修订；
 * - **内容写入**（快照、自历史新建、数据集应用、动作播放）：走一次内核事务后 `afterWrite()`；
 * - **会话/交付**（动作录制与编辑、ATN 字节往返、CSV 与前端队列）：只改内核的会话状态或返回
 *   字节，由面板自己展示，不伪造文档已保存。
 *
 * 清理是本域唯一不可恢复的操作：面板必须先取范围说明再显式确认；缺少 `confirm` 时内核会拒绝，
 * 这里也不替调用方补上。批量队列运行在内核的独立草稿会话里，因此不经过 `afterWrite()`。
 */

type PurgeRange = "undo" | "clipboard" | "histories" | "videoCache" | "all";

const PURGE_RANGES: readonly PurgeRange[] = ["undo", "clipboard", "histories", "videoCache", "all"];

function history(context: WorkspaceFeatureContext) {
  return context.handle?.features.history;
}

/** 只读查询的统一包装：句柄缺失、结构非法都给出可读失败。 */
function read<T>(
  context: WorkspaceFeatureContext,
  run: (feature: NonNullable<ReturnType<typeof history>>) => EditorResult<unknown>,
  decode: (value: unknown) => T | null,
  what: string
): EditorResult<T> {
  const feature = history(context);
  if (!feature) return context.unavailable();
  const result = run(feature);
  if (!result.ok) return context.fail(result);
  const decoded = decode(result.value);
  if (decoded === null) return context.fail({ ok: false, code: "invalid-message", message: `${what}的返回结构非法` });
  return { ok: true, value: decoded };
}

/** 写入的统一包装：内核错误原样上报，成功后刷新视图与命令表。 */
function write(
  context: WorkspaceFeatureContext,
  run: (feature: NonNullable<ReturnType<typeof history>>) => EditorResult<unknown>
): EditorResult<EditorViewModel> {
  const feature = history(context);
  if (!feature) return context.unavailable();
  const blocked = context.blockingDraft();
  if (blocked) return blocked;
  const result = run(feature);
  if (!result.ok) return context.fail(result);
  return context.afterWrite();
}

// ----------------------------------------------------------------- U74 历史与清理

export function historyState(this: WorkspaceFeatureContext): EditorResult<HistoryStateView> {
  return read(this, (feature) => feature.historyState(), decodeHistoryState, "历史视图");
}

export function newSnapshot(this: WorkspaceFeatureContext, params: { name?: string; from?: "fullDocument" | "mergedLayers" | "currentLayer" }): EditorResult<EditorViewModel> {
  return write(this, (feature) => feature.newSnapshot(params));
}

export function selectSnapshot(this: WorkspaceFeatureContext, snapshot: number): EditorResult<EditorViewModel> {
  return write(this, (feature) => feature.selectSnapshot({ snapshot }));
}

export function renameSnapshot(this: WorkspaceFeatureContext, snapshot: number, name: string): EditorResult<EditorViewModel> {
  return write(this, (feature) => feature.renameSnapshot({ snapshot, name }));
}

export function deleteSnapshot(this: WorkspaceFeatureContext, snapshot: number): EditorResult<EditorViewModel> {
  return write(this, (feature) => feature.deleteSnapshot({ snapshot }));
}

export function deleteState(this: WorkspaceFeatureContext, state: number): EditorResult<EditorViewModel> {
  return write(this, (feature) => feature.deleteState({ state }));
}

export function newDocumentFromHistory(this: WorkspaceFeatureContext, params: { state?: number; name?: string } = {}): EditorResult<{ name: string; bytes: Uint8Array }> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const created = feature.newDocumentFromHistory(params);
  if (!created.ok) return this.fail(created);
  const result = (created.value as { result?: { name?: unknown } } | null)?.result;
  const name = typeof result?.name === "string" && result.name ? result.name : "派生文档";
  // 内核的 `history.newDocument` 会把**活动文档**切到新文档，而宿主标签仍指向源文档。
  // 若就这么留着，下一次保存会把派生内容写回源节点（工程被改成别的东西），切标签也会
  // 落到错误的文档上。因此这里取走派生文档的字节后立即关闭它：用户拿到一份独立工程，
  // 保存目标与活动标签都不受影响。
  const saved = handle.saveProject();
  // 无论取字节是否成功都必须关闭：否则会话里留着一个顶包的活动文档。
  const closed = handle.closeDocument();
  this.afterWrite();
  if (!saved.ok) return this.fail(saved);
  if (!closed.ok) return this.fail(closed);
  return { ok: true, value: { name, bytes: saved.value } };
}

/**
 * 取样某个历史源：把 `epoch` 一起交给内核，由读取点判定句柄是否还有效。
 *
 * 这一步是**只读**的：它返回归档状态（或活文档）的合成预览，不写文档、不推进修订。判定失效
 * 必须在内核里做——界面自己比对 epoch 再按索引取样，会在「清理后同一个索引指向别的内容」时
 * 悄悄取到新像素（正是 U74 要防的「旧源误用」）。
 */
export function sampleHistory(
  this: WorkspaceFeatureContext,
  params: { epoch: string; state?: number; maxSide?: number; preview?: boolean }
): EditorResult<HistorySampleView> {
  return read(this, (feature) => feature.sampleHistory(params), decodeHistorySample, "历史源样本");
}

/**
 * 只校验历史源句柄：与 [`sampleHistory`] 同一套拒绝条件，但不合成像素。
 *
 * 历史画笔在**落笔前**问「这个源还能用吗」时用这条路径：拿一整张缩略图只为确认一句话，会让
 * 每次落笔都分配一次 RGBA 缓冲。身份判定仍在内核（过期句柄同样被拒），因此不会出现
 * 「界面以为可用、落笔却按旧索引取新像素」。
 */
export function checkHistorySource(
  this: WorkspaceFeatureContext,
  params: { epoch: string; state?: number }
): EditorResult<HistorySourceCheckView> {
  return read(
    this,
    (feature) => feature.sampleHistory({ ...params, preview: false }),
    decodeHistorySourceCheck,
    "历史源检查"
  );
}

/** 清理范围说明（只读）。 */
export function purgePlan(this: WorkspaceFeatureContext, what: string): EditorResult<PurgePlanView> {
  if (!PURGE_RANGES.includes(what as PurgeRange)) {
    return { ok: false, code: "bad-params", message: `未知的清理范围 \`${what}\`` };
  }
  return read(this, (feature) => feature.purgePlan(what), decodePurgePlan, "清理范围");
}

/**
 * 按范围清理。`confirm` 默认 **false**：不传确认时内核会拒绝并说明范围，界面必须先展示
 * [`purgePlan`] 的结果再让用户确认。
 */
export function purge(this: WorkspaceFeatureContext, what: string, confirm = false): EditorResult<EditorViewModel> {
  if (!PURGE_RANGES.includes(what as PurgeRange)) {
    return { ok: false, code: "bad-params", message: `未知的清理范围 \`${what}\`` };
  }
  const feature = history(this);
  if (!feature) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = feature.purge(what, { confirm });
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

// ----------------------------------------------------------------- U75 动作与 ATN

export function actionsState(this: WorkspaceFeatureContext, action?: string): EditorResult<ActionsStateView> {
  return read(this, (feature) => feature.actionsState(action === undefined ? {} : { action }), decodeActionsState, "动作面板");
}

export function actionShortcuts(this: WorkspaceFeatureContext): EditorResult<Array<{ action: string; shortcut: string }>> {
  return read(this, (feature) => feature.actionShortcuts(), (value) => decodeShortcuts(value), "动作快捷键");
}

/** 开始录制；`name` 省略时内核分配唯一名字。 */
export function startRecording(this: WorkspaceFeatureContext, name?: string): EditorResult<ActionsStateView> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const result = feature.recordAction(name === undefined ? {} : { name });
  if (!result.ok) return this.fail(result);
  return read(this, (each) => each.actionsState({}), decodeActionsState, "动作面板");
}

export function stopRecording(this: WorkspaceFeatureContext): EditorResult<ActionsStateView> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const result = feature.recordAction({ stop: true });
  if (!result.ok) return this.fail(result);
  return read(this, (each) => each.actionsState({}), decodeActionsState, "动作面板");
}

/**
 * 播放：内核先逐步骤预检，不可播放时不提交任何步骤。
 *
 * `actions.play` 在**中途某步失败**时仍返回成功（`{ran, failed:{step,id,error}}`，已跑完的步骤
 * 保留）。这是上游刻意的事务语义，但界面不能因此显示「播放成功」：这里读到 `failed` 后先刷新
 * 视图，再把失败如实上报，与脚本执行同一规则。
 */
export function playAction(this: WorkspaceFeatureContext, action: string, from?: number): EditorResult<EditorViewModel> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = feature.playAction(from === undefined ? { action } : { action, from });
  if (!result.ok) return this.fail(result);
  const failed = (result.value as { failed?: unknown }).failed;
  const refreshed = this.afterWrite();
  if (!refreshed.ok) return refreshed;
  if (failed !== undefined && failed !== null) {
    const step = typeof (failed as { step?: unknown }).step === "number" ? (failed as { step: number }).step : null;
    const id = typeof (failed as { id?: unknown }).id === "string" ? (failed as { id: string }).id : action;
    const error = typeof (failed as { error?: unknown }).error === "string"
      ? (failed as { error: string }).error
      : "该步骤执行失败";
    return this.fail({
      ok: false,
      code: "command-failed",
      message: step === null
        ? `播放停在 \`${id}\`：${error}（已完成的步骤已保留）`
        : `播放停在第 ${step + 1} 步 \`${id}\`：${error}（已完成的步骤已保留）`
    });
  }
  return refreshed;
}

/** 动作编辑（重命名/移动/条件/动作集/步骤开关）。 */
export function actionCommand(this: WorkspaceFeatureContext, id: string, params: Record<string, unknown>): EditorResult<ActionsStateView> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const result = feature.actionCommand(id, params);
  if (!result.ok) return this.fail(result);
  return read(this, (each) => each.actionsState({}), decodeActionsState, "动作面板");
}

/**
 * 测试条件（`actions.conditional`）。
 *
 * 这一步**会播放命中的分支**，因此它和其它内容写入一样：过草稿门禁、刷新视图，并把
 * `holds`/`played` 如实交给界面。不能走 [`actionCommand`]——那条路径把条件当成纯会话状态，
 * 分支写完文档后界面不会刷新，用户看到的是旧图层。
 */
export function testCondition(
  this: WorkspaceFeatureContext,
  params: { if: string; then?: string | null; else?: string | null }
): EditorResult<{ holds: boolean; played: string | null; failed: string | null }> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = feature.actionCommand("actions.conditional", params);
  if (!result.ok) return this.fail(result);
  const refreshed = this.afterWrite();
  if (!refreshed.ok) return refreshed;
  const value = result.value as { holds?: unknown; played?: unknown; failed?: unknown };
  const holds = value.holds === true;
  const played = typeof value.played === "string" ? value.played : null;
  const failure = value.failed;
  const failed = typeof failure === "string"
    ? failure
    : failure && typeof failure === "object" && typeof (failure as { error?: unknown }).error === "string"
      ? (failure as { error: string }).error
      : null;
  if (failed) return this.fail({ ok: false, code: "command-failed", message: `条件成立但分支失败：${failed}` });
  return { ok: true, value: { holds, played, failed } };
}

/** ATN 导入（base64 字节）；默认拒绝含未知步骤的动作组。 */
export function loadActions(this: WorkspaceFeatureContext, input: { data: string; acceptUnsupported?: boolean; set?: string }): EditorResult<{ unsupported: UnsupportedStep[]; actions: string[]; warnings: string[] }> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const result = feature.loadActions(input);
  if (!result.ok) return this.fail(result);
  const unsupported = decodeUnsupported(result.value);
  if (unsupported === null) {
    return this.fail({ ok: false, code: "invalid-message", message: "ATN 导入没有返回未知步骤报告" });
  }
  const actions = Array.isArray((result.value as { actions?: unknown }).actions)
    ? ((result.value as { actions: unknown[] }).actions.filter((name): name is string => typeof name === "string"))
    : [];
  // 警告必须往上传：`.atn` 有尾部字节被忽略时文件仍能导入，但内容可能不完整。
  // 只报「已导入」而不提警告，等于告诉用户文件被完整读入。
  return { ok: true, value: { unsupported, actions, warnings: decodeWarnings(result.value) } };
}

/**
 * ATN 导出：返回 base64 字节（写文件由宿主交付端口负责）与被跳过的步骤。
 *
 * 跳过必须能报告出来：`skipUnsupported` 会真的丢掉步骤，界面只显示「导出成功」等于把
 * 「这份 .atn 少了东西」藏起来，正好违反本域「未知步骤有报告、不静默跳过」的约束。
 */
export function saveActions(this: WorkspaceFeatureContext, params: { action?: string; set?: string; skipUnsupported?: boolean } = {}): EditorResult<{ data: string; skipped: Array<{ action: string; step: number; id: string }> }> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const result = feature.saveActions(params);
  if (!result.ok) return this.fail(result);
  const data = (result.value as { data?: unknown }).data;
  if (typeof data !== "string" || data.length === 0) {
    return this.fail({ ok: false, code: "invalid-message", message: "ATN 导出没有返回字节" });
  }
  const raw = (result.value as { skipped?: unknown }).skipped;
  const skipped = Array.isArray(raw)
    ? raw.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const { action, step, id } = entry as { action?: unknown; step?: unknown; id?: unknown };
        if (typeof action !== "string" || typeof step !== "number" || typeof id !== "string") return [];
        return [{ action, step, id }];
      })
    : [];
  return { ok: true, value: { data, skipped } };
}

// ----------------------------------------------------------------- U76 变量、数据集与自动化

export function variablesState(this: WorkspaceFeatureContext): EditorResult<VariablesStateView> {
  return read(this, (feature) => feature.variablesState(), decodeVariablesState, "变量与数据集");
}

export function defineVariables(this: WorkspaceFeatureContext, defs: Array<Record<string, unknown>>): EditorResult<EditorViewModel> {
  return write(this, (feature) => feature.defineVariables({ defs }));
}

/**
 * 直接设置（整份替换）数据集。
 *
 * `image.variables.dataSets` 是**整份替换**语义：没在 `dataSets` 里的数据集会被删掉。因此这条
 * 入口只用于「删一行」这类必须重发全集的编辑——新增走 CSV 导入或补 `append`，不要用它做增量。
 */
export function setDataSets(
  this: WorkspaceFeatureContext,
  dataSets: Array<{ name: string; values: Array<Record<string, unknown>> }>
): EditorResult<EditorViewModel> {
  return write(this, (feature) => feature.setDataSets({ dataSets }));
}

export function importDataSets(this: WorkspaceFeatureContext, csvText: string, params: { append?: boolean; delimiter?: string } = {}): EditorResult<{ imported: number; skipped: Array<{ column: string; reason: string }> }> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = feature.importDataSets(params, csvText);
  if (!result.ok) return this.fail(result);
  const decoded = decodeCsvImport(result.value);
  if (!decoded) return this.fail({ ok: false, code: "invalid-message", message: "CSV 导入没有返回报告" });
  // CSV 数据集是文档内容（`doc.variables`）：导入成功后必须像其它写入一样刷新视图，
  // 否则面板会显示旧的数据集清单。返回值仍是本次导入报告，不是视图。
  const refreshed = this.afterWrite();
  if (!refreshed.ok) return refreshed;
  return { ok: true, value: decoded };
}

/** CSV 导出：返回文本，由宿主写入用户选择的文件。 */
export function exportDataSetsCsv(this: WorkspaceFeatureContext): EditorResult<{ text: string; dataSets: number }> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const result = feature.exportDataSetsCsv();
  if (!result.ok) return this.fail(result);
  const value = result.value as { text?: unknown; dataSets?: unknown };
  if (typeof value.text !== "string") {
    return this.fail({ ok: false, code: "invalid-message", message: "CSV 导出没有返回文本" });
  }
  return { ok: true, value: { text: value.text, dataSets: typeof value.dataSets === "number" ? value.dataSets : 0 } };
}

/** 应用数据集：像素变量的字节由调用方按资源键交出（base64）。 */
export function applyDataSet(this: WorkspaceFeatureContext, params: { name?: string; index?: number; images?: Record<string, string> }): EditorResult<EditorViewModel> {
  return write(this, (feature) => feature.applyDataSet(params));
}

export function exportDataSetsAsFiles(this: WorkspaceFeatureContext, params: { format?: string; dataSets?: string[]; naming?: string; images?: Record<string, string> } = {}): EditorResult<ExportedFile[]> {
  return read(this, (feature) => feature.exportDataSetsAsFiles(params), decodeExportedFiles, "数据集导出");
}

/** 规划前台队列：超预算或步骤不可执行时在这里就失败，不会留下半批。 */
export function beginBatch(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<number> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const result = feature.beginBatch(params);
  if (!result.ok) return this.fail(result);
  const queue = decodeQueueId(result.value);
  if (queue === null) return this.fail({ ok: false, code: "invalid-message", message: "队列没有返回 id" });
  return { ok: true, value: queue };
}

export function stepBatch(this: WorkspaceFeatureContext, queue: number): EditorResult<BatchProgressView> {
  return read(this, (feature) => feature.stepBatch(queue), decodeBatchProgress, "批处理进度");
}

export function cancelBatch(this: WorkspaceFeatureContext, queue: number): EditorResult<BatchProgressView> {
  return read(this, (feature) => feature.cancelBatch(queue), decodeBatchProgress, "批处理进度");
}

export function finishBatch(this: WorkspaceFeatureContext, queue: number): EditorResult<BatchProgressView> {
  return read(this, (feature) => feature.finishBatch(queue), decodeBatchProgress, "批处理报告");
}

export function takeBatchFile(this: WorkspaceFeatureContext, queue: number, index: number): EditorResult<{ file: string; output: string | null; data: string }> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const result = feature.takeBatchFile(queue, index);
  if (!result.ok) return this.fail(result);
  const value = result.value as { file?: unknown; output?: unknown; data?: unknown };
  if (typeof value.file !== "string" || typeof value.data !== "string") {
    return this.fail({ ok: false, code: "invalid-message", message: "队列没有返回交付字节" });
  }
  return { ok: true, value: { file: value.file, output: typeof value.output === "string" ? value.output : null, data: value.data } };
}

export function batchState(this: WorkspaceFeatureContext, queue: number): EditorResult<BatchProgressView> {
  return read(this, (feature) => feature.batchState(queue), decodeBatchProgress, "队列状态");
}

/** 受限声明式脚本：任一未知/未开放步骤在执行前整组拒绝。 */
export function runScript(this: WorkspaceFeatureContext, params: { steps?: unknown[]; script?: string }): EditorResult<ScriptReportView> {
  const feature = history(this);
  if (!feature) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = feature.runScript(params);
  if (!result.ok) return this.fail(result);
  const report = decodeScriptReport(result.value);
  if (!report) return this.fail({ ok: false, code: "invalid-message", message: "脚本没有返回逐步报告" });
  const refreshed = this.afterWrite();
  if (!refreshed.ok) return refreshed;
  if (!report.ok) {
    // 脚本在中途失败：已经成功的步骤保留并已刷新视图，但界面必须看到失败，不能当作完成。
    const last = report.results.at(-1);
    return this.fail({ ok: false, code: "command-failed", message: last?.error ?? "脚本执行失败" });
  }
  return { ok: true, value: report };
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    historyState: (...args: Parameters<OmitThisParameter<typeof historyState>>) => historyState.apply(context(), args),
    newSnapshot: (...args: Parameters<OmitThisParameter<typeof newSnapshot>>) => newSnapshot.apply(context(), args),
    selectSnapshot: (...args: Parameters<OmitThisParameter<typeof selectSnapshot>>) => selectSnapshot.apply(context(), args),
    renameSnapshot: (...args: Parameters<OmitThisParameter<typeof renameSnapshot>>) => renameSnapshot.apply(context(), args),
    deleteSnapshot: (...args: Parameters<OmitThisParameter<typeof deleteSnapshot>>) => deleteSnapshot.apply(context(), args),
    deleteState: (...args: Parameters<OmitThisParameter<typeof deleteState>>) => deleteState.apply(context(), args),
    newDocumentFromHistory: (...args: Parameters<OmitThisParameter<typeof newDocumentFromHistory>>) => newDocumentFromHistory.apply(context(), args),
    sampleHistory: (...args: Parameters<OmitThisParameter<typeof sampleHistory>>) => sampleHistory.apply(context(), args),
    checkHistorySource: (...args: Parameters<OmitThisParameter<typeof checkHistorySource>>) => checkHistorySource.apply(context(), args),
    purgePlan: (...args: Parameters<OmitThisParameter<typeof purgePlan>>) => purgePlan.apply(context(), args),
    purge: (...args: Parameters<OmitThisParameter<typeof purge>>) => purge.apply(context(), args),
    actionsState: (...args: Parameters<OmitThisParameter<typeof actionsState>>) => actionsState.apply(context(), args),
    actionShortcuts: (...args: Parameters<OmitThisParameter<typeof actionShortcuts>>) => actionShortcuts.apply(context(), args),
    startRecording: (...args: Parameters<OmitThisParameter<typeof startRecording>>) => startRecording.apply(context(), args),
    stopRecording: (...args: Parameters<OmitThisParameter<typeof stopRecording>>) => stopRecording.apply(context(), args),
    playAction: (...args: Parameters<OmitThisParameter<typeof playAction>>) => playAction.apply(context(), args),
    actionCommand: (...args: Parameters<OmitThisParameter<typeof actionCommand>>) => actionCommand.apply(context(), args),
    testCondition: (...args: Parameters<OmitThisParameter<typeof testCondition>>) => testCondition.apply(context(), args),
    loadActions: (...args: Parameters<OmitThisParameter<typeof loadActions>>) => loadActions.apply(context(), args),
    saveActions: (...args: Parameters<OmitThisParameter<typeof saveActions>>) => saveActions.apply(context(), args),
    variablesState: (...args: Parameters<OmitThisParameter<typeof variablesState>>) => variablesState.apply(context(), args),
    defineVariables: (...args: Parameters<OmitThisParameter<typeof defineVariables>>) => defineVariables.apply(context(), args),
    setDataSets: (...args: Parameters<OmitThisParameter<typeof setDataSets>>) => setDataSets.apply(context(), args),
    importDataSets: (...args: Parameters<OmitThisParameter<typeof importDataSets>>) => importDataSets.apply(context(), args),
    exportDataSetsCsv: (...args: Parameters<OmitThisParameter<typeof exportDataSetsCsv>>) => exportDataSetsCsv.apply(context(), args),
    applyDataSet: (...args: Parameters<OmitThisParameter<typeof applyDataSet>>) => applyDataSet.apply(context(), args),
    exportDataSetsAsFiles: (...args: Parameters<OmitThisParameter<typeof exportDataSetsAsFiles>>) => exportDataSetsAsFiles.apply(context(), args),
    beginBatch: (...args: Parameters<OmitThisParameter<typeof beginBatch>>) => beginBatch.apply(context(), args),
    stepBatch: (...args: Parameters<OmitThisParameter<typeof stepBatch>>) => stepBatch.apply(context(), args),
    cancelBatch: (...args: Parameters<OmitThisParameter<typeof cancelBatch>>) => cancelBatch.apply(context(), args),
    finishBatch: (...args: Parameters<OmitThisParameter<typeof finishBatch>>) => finishBatch.apply(context(), args),
    takeBatchFile: (...args: Parameters<OmitThisParameter<typeof takeBatchFile>>) => takeBatchFile.apply(context(), args),
    batchState: (...args: Parameters<OmitThisParameter<typeof batchState>>) => batchState.apply(context(), args),
    runScript: (...args: Parameters<OmitThisParameter<typeof runScript>>) => runScript.apply(context(), args)
  };
}
