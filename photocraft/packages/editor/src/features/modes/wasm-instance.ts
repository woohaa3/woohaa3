/**
 * 本域真实 wasm glue 签名（与 Rust `features/modes/wasm.rs` 的导出逐一对应）。
 *
 * 预览返回的是 JSON 字符串（含 base64 预览像素），不把像素数组塞进状态响应。
 */
export type FeatureEditorInstance = {
  /** 只读模式信息：模式、颜色表、油墨、目标矩阵、陷印状态。 */
  modeInfo(): string;
  /** 预览模式转换（`target` 为 rgb|grayscale|bitmap|indexed|duotone）。 */
  planMode(target: string, paramsJson: string): string;
  /** 确认模式转换；要求 baseRevision/baseContentHash 与预览时一致。 */
  applyMode(target: string, paramsJson: string): string;
  /** 预览颜色表编辑（仅索引色）。 */
  planColorTable(paramsJson: string): string;
  /** 确认颜色表编辑（仅索引色）。 */
  applyColorTable(paramsJson: string): string;
};
