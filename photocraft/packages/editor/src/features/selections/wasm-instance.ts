/**
 * 本域真实 glue 签名（`packages/editor/dist/wasm` 的 `photocraft_editor.js`）。
 *
 * U17–U24 的新导出是**可选**成员：旧运行时（或只装配部分端口的宿主 / 测试替身）没有这些
 * 导出，类型面必须允许它存在——真正的门禁在 `wasm-handle.ts` 里逐条检查并返回明确失败，
 * 而不是让整个 `EditorInstance` 在缺少导出时无法构造。这样"加载旧运行时"是一个可测试的
 * 拒绝路径，而不是编译期错误。
 */
export type FeatureEditorInstance = {
beginSelectionModify(paramsJson: string): string;
updateSelectionModify(paramsJson: string): string;
commitSelectionModify(): string;
cancelSelectionModify(): string;
prepareRefineEdge(paramsJson: string): string;
beginSelectionTransform(): void;

// ---- U17–U24（旧运行时可能缺失） ----
selectLine?(paramsJson: string): string;
beginMagneticLasso?(paramsJson: string): string;
updateMagneticLasso?(paramsJson: string): string;
saveNamedSelection?(paramsJson: string): string;
loadNamedSelection?(paramsJson: string): string;
beginColorGrow?(similar: boolean, paramsJson: string): string;
updateColorGrow?(paramsJson: string): string;
beginQuickMask?(): string;
paintQuickMask?(paramsJson: string): string;
exitQuickMask?(cancel: boolean): string;
beginSmartSelect?(kind: string, paramsJson: string): string;
beginColorRange?(paramsJson: string): string;
updateColorRange?(paramsJson: string): string;
beginRefineEdge?(paramsJson: string): string;
updateRefineEdge?(paramsJson: string): string;
editLayerMask?(paramsJson: string): string;
layerMaskProperties?(layer?: number): string;
viewLayerMask?(paramsJson: string): string;
selectionDraftStateJson?(): string;
selectionDraftOutlineJson?(): string;
commitSelectionDraft?(): string;
cancelSelectionDraft?(): string;
};
