/**
 * 滤镜域真实 glue 的签名（与 Rust `features/filters/wasm.rs` 逐项一致）。
 *
 * `beginFilter` / `updateFilter` / `commitFilter` / `cancelFilter` 是 P6 起就有的端口，宿主替身
 * 一律提供，因此保持必填。清单、上次滤镜、重复与图内控制点是本 change
 * （`2026-10-22-add-photocraft-filter-workflows`）新加的导出：类型上保持可选，这样宿主侧的
 * `EditorInstance` 替身与旧 glue 不必同一提交升级。`wasm-handle` 对缺失端口返回
 * `missing-port` 失败（面板显示「当前运行时不支持…」），而不是在调用点抛 `not a function`，
 * 也不伪造成功。
 */
export type FeatureEditorInstance = {
  beginFilter(id: string, paramsJson: string): string;
  updateFilter(paramsJson: string): string;
  commitFilter(): string;
  cancelFilter(): string;
  /** 滤镜清单：命令、归类、交互形态与参数 schema（面板不再手写范围）。 */
  filterCatalogueJson?(): string;
  /** 画廊目录（滤镜库分类与单个滤镜参数）。 */
  filterGalleryCatalogueJson?(): string;
  /** 滤镜库默认组合（首次打开即可预览候选）。 */
  filterGalleryDefaultStackJson?(): string;
  /** 活动草稿状态；没有草稿时为 `null`。 */
  filterDraftStateJson?(): string;
  /** 上次滤镜（命令 + 规范参数）或不可用原因。 */
  filterLastJson?(): string;
  /** 重复上次滤镜：内核重建草稿，仍需显式确认。 */
  repeatLastFilter?(): string;
  /** 文档坐标 → 0–1 相对坐标（模糊画廊／消失点／广角约束共用）。 */
  filterNormalizePoint?(x: number, y: number, width: number, height: number): string;
  /** 位移图来源：会话里已打开的文档（置换滤镜只从文档取图，不读本机路径）。 */
  filterMapSourcesJson?(): string;
  /** 消失点粘贴的图层来源：当前文档里可见且带像素的图层。 */
  filterLayerSourcesJson?(): string;
  /** 火焰滤镜的路径来源：已保存路径名（`path` 是名字，不是坐标）。 */
  filterPathSourcesJson?(): string;
};
