/** 修饰域真实 glue 的签名（与 Rust `features/retouch/wasm.rs` 逐项一致）。 */
export type FeatureEditorInstance = {
  beginRetouch(id: string, paramsJson: string): string;
  appendRetouch(pointsJson: string): string;
  commitRetouch(): string;
  cancelRetouch(): string;
  retouchStateJson(): string;
  /**
   * 区域修饰（修补／内容识别移动／红眼）：开始算出候选，不写正式文档。
   *
   * 这四个端口是 change `2026-10-22-add-photocraft-retouch-workflows` 新加的 glue 导出。
   * 类型上保持可选：宿主侧的 `EditorInstance` 替身与旧 glue 未必同步升级，那时应当**明确拒绝**
   * 而不是让调用点在运行时抛 `not a function`。`wasm-handle` 对缺失端口返回 `missing-port`
   * 失败，界面据此提示未接通，不伪造成功。
   */
  beginRetouchRegion?(id: string, paramsJson: string): string;
  commitRetouchRegion?(): string;
  cancelRetouchRegion?(): string;
  /** 历史画笔可用的历史源（只读）。 */
  retouchHistorySourcesJson?(): string;
  /**
   * 仿制源槽位与叠加选项（只读）。它走会话而不是 `execute`，因此落笔期间也能查询：
   * 叠加取样框与面板刷新要用同一份取景。
   */
  retouchCloneSourcesJson?(): string;
};
