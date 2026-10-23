/**
 * 历史/动作/数据驱动域的内核类型面
 * （change: 2026-10-22-add-photocraft-history-automation-workflows，U74/U75/U76）。
 *
 * 与 Rust `features/history/wasm.rs` 的导出逐项对齐：参数一律是 JSON 字符串，字节一律是
 * base64 字符串（ATN、批处理输入/交付、数据集导出），因此这一层不会出现路径或 `Uint8Array`
 * 的 JS/Rust 边界差异。
 */
export type FeatureEditorInstance = {
  historyStateJson(): string;
  historyCommand(id: string, paramsJson: string): string;
  newSnapshot(paramsJson: string): string;
  selectSnapshot(paramsJson: string): string;
  renameSnapshot(paramsJson: string): string;
  deleteSnapshot(paramsJson: string): string;
  deleteState(paramsJson: string): string;
  newDocumentFromHistory(paramsJson: string): string;
  sampleHistory(paramsJson: string): string;
  purgePlanJson(what: string): string;
  purge(what: string, paramsJson: string): string;

  actionsStateJson(paramsJson: string): string;
  recordAction(paramsJson: string): string;
  playAction(paramsJson: string): string;
  actionCommand(id: string, paramsJson: string): string;
  loadActions(paramsJson: string): string;
  saveActions(paramsJson: string): string;
  actionShortcutsJson(): string;

  variablesStateJson(): string;
  defineVariables(paramsJson: string): string;
  setDataSets(paramsJson: string): string;
  importDataSets(paramsJson: string, csvText: string): string;
  exportDataSetsCsv(): string;
  applyDataSet(paramsJson: string): string;
  exportDataSetsAsFiles(paramsJson: string): string;

  beginBatch(paramsJson: string): string;
  stepBatch(queue: number): string;
  cancelBatch(queue: number): string;
  finishBatch(queue: number): string;
  takeBatchFile(queue: number, index: number): string;
  batchStateJson(queue: number): string;
  runScript(paramsJson: string): string;
};
