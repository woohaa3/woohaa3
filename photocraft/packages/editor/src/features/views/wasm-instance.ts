/**
 * 本域在 wasm-bindgen 实例上的端口。
 *
 * U70 的四条既有端口是必需项；U71–U73 新增的五条是**可选**的：旧运行时（未重新构建的
 * `.wasm`）与精简宿主/测试替身没有它们时仍要能通过类型检查，并在调用时给出「能力关闭」
 * 而不是抛 `undefined is not a function`。这正是 spec 要求的「缺宿主端口 → 拒绝相关写入」。
 */
export type FeatureEditorInstance = {
  viewAidsJson(): string;
  setViewAids(paramsJson: string): string;
  snapPoint(paramsJson: string): string;
  guideCommand(id: string, paramsJson: string): string;
  /** U71 参考线布局（列/行/间距/边距、从形状建线、清空画布参考线）。 */
  guideLayoutCommand?(id: string, paramsJson: string): string;
  /** U73 统一写入口（取样、测量、计数、注释）。 */
  viewCommand?(id: string, paramsJson: string): string;
  /** U70–U73 只读快照（参考线/原点/取样/测量/计数/注释与持久归属）。 */
  viewSnapshotJson?(): string;
  /** U73 单个取样点读数（来自真实源像素）。 */
  samplerReadoutJson?(index: number): string;
  /** U73 按源单位格式化长度。 */
  formatLengthJson?(paramsJson: string): string;
  /**
   * U70/U72 画布指针几何：参考线命中/拖动、标尺原点拖动。
   *
   * `action` = `hit-guide` | `drag-guide` | `drag-origin`；参数是客户坐标，返回源坐标结果。
   * 只读，不改文档、不造历史。
   */
  viewPointerJson?(action: string, paramsJson: string): string;
};
