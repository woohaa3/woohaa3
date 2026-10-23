import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";

/**
 * 历史/动作/数据驱动域的 wasm 适配
 * （change: 2026-10-22-add-photocraft-history-automation-workflows）。
 *
 * 只做 `JSON.stringify`/`JSON.parse` 与 base64 直传：内核已经返回结构化的历史/动作/数据集
 * 视图，这里不重新计算。字节参数保持 base64 字符串原样转交，避免在浏览器里多做一次
 * `Uint8Array` ↔ base64 往返。
 */

export function historyState(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.historyStateJson()));
}

export function historyCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.historyCommand(id, JSON.stringify(params))));
}

export function newSnapshot(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.newSnapshot(JSON.stringify(params))));
}

export function selectSnapshot(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.selectSnapshot(JSON.stringify(params))));
}

export function renameSnapshot(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.renameSnapshot(JSON.stringify(params))));
}

export function deleteSnapshot(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.deleteSnapshot(JSON.stringify(params))));
}

export function deleteState(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.deleteState(JSON.stringify(params))));
}

export function sampleHistory(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.sampleHistory(JSON.stringify(params))));
}

export function newDocumentFromHistory(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.newDocumentFromHistory(JSON.stringify(params))));
}

export function purgePlan(this: FeatureHandleContext, what: string): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.purgePlanJson(what)));
}

export function purge(this: FeatureHandleContext, what: string, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.purge(what, JSON.stringify(params))));
}

export function actionsState(this: FeatureHandleContext, params: unknown = {}): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.actionsStateJson(JSON.stringify(params))));
}

export function recordAction(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.recordAction(JSON.stringify(params))));
}

export function playAction(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.playAction(JSON.stringify(params))));
}

export function actionCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.actionCommand(id, JSON.stringify(params))));
}

export function loadActions(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.loadActions(JSON.stringify(params))));
}

export function saveActions(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.saveActions(JSON.stringify(params))));
}

export function actionShortcuts(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.actionShortcutsJson()));
}

export function variablesState(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.variablesStateJson()));
}

export function defineVariables(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.defineVariables(JSON.stringify(params))));
}

export function setDataSets(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.setDataSets(JSON.stringify(params))));
}

export function importDataSets(this: FeatureHandleContext, params: unknown, csvText: string): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.importDataSets(JSON.stringify(params), csvText)));
}

export function exportDataSetsCsv(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.exportDataSetsCsv()));
}

export function applyDataSet(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.applyDataSet(JSON.stringify(params))));
}

export function exportDataSetsAsFiles(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.exportDataSetsAsFiles(JSON.stringify(params))));
}

export function beginBatch(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.beginBatch(JSON.stringify(params))));
}

export function stepBatch(this: FeatureHandleContext, queue: number): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.stepBatch(queue)));
}

export function cancelBatch(this: FeatureHandleContext, queue: number): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.cancelBatch(queue)));
}

export function finishBatch(this: FeatureHandleContext, queue: number): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.finishBatch(queue)));
}

export function takeBatchFile(this: FeatureHandleContext, queue: number, index: number): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.takeBatchFile(queue, index)));
}

export function batchState(this: FeatureHandleContext, queue: number): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.batchStateJson(queue)));
}

export function runScript(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.runScript(JSON.stringify(params))));
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    historyState: (...args: Parameters<OmitThisParameter<typeof historyState>>) => historyState.apply(context(), args),
    historyCommand: (...args: Parameters<OmitThisParameter<typeof historyCommand>>) => historyCommand.apply(context(), args),
    newSnapshot: (...args: Parameters<OmitThisParameter<typeof newSnapshot>>) => newSnapshot.apply(context(), args),
    selectSnapshot: (...args: Parameters<OmitThisParameter<typeof selectSnapshot>>) => selectSnapshot.apply(context(), args),
    renameSnapshot: (...args: Parameters<OmitThisParameter<typeof renameSnapshot>>) => renameSnapshot.apply(context(), args),
    deleteSnapshot: (...args: Parameters<OmitThisParameter<typeof deleteSnapshot>>) => deleteSnapshot.apply(context(), args),
    deleteState: (...args: Parameters<OmitThisParameter<typeof deleteState>>) => deleteState.apply(context(), args),
    newDocumentFromHistory: (...args: Parameters<OmitThisParameter<typeof newDocumentFromHistory>>) => newDocumentFromHistory.apply(context(), args),
    sampleHistory: (...args: Parameters<OmitThisParameter<typeof sampleHistory>>) => sampleHistory.apply(context(), args),
    purgePlan: (...args: Parameters<OmitThisParameter<typeof purgePlan>>) => purgePlan.apply(context(), args),
    purge: (...args: Parameters<OmitThisParameter<typeof purge>>) => purge.apply(context(), args),
    actionsState: (...args: Parameters<OmitThisParameter<typeof actionsState>>) => actionsState.apply(context(), args),
    recordAction: (...args: Parameters<OmitThisParameter<typeof recordAction>>) => recordAction.apply(context(), args),
    playAction: (...args: Parameters<OmitThisParameter<typeof playAction>>) => playAction.apply(context(), args),
    actionCommand: (...args: Parameters<OmitThisParameter<typeof actionCommand>>) => actionCommand.apply(context(), args),
    loadActions: (...args: Parameters<OmitThisParameter<typeof loadActions>>) => loadActions.apply(context(), args),
    saveActions: (...args: Parameters<OmitThisParameter<typeof saveActions>>) => saveActions.apply(context(), args),
    actionShortcuts: (...args: Parameters<OmitThisParameter<typeof actionShortcuts>>) => actionShortcuts.apply(context(), args),
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
