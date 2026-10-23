export type FeatureEditorInstance = {
  openImage(name: string, assetId: string, bytes: Uint8Array): string;
  openProject(bytes: Uint8Array, baseAssetId: string): string;
  hasDocument(): boolean;
  closeDocument(): string;
  /** U01：在空会话上新建空白文档；参数与 `file.new` 同形。 */
  createDocument(paramsJson: string): string;
  /** U02：用图片字节在空会话上建立文档。 */
  createDocumentFromImage(name: string, bytes: Uint8Array): string;
  /** U02：把当前文档整份复制成自包含 `.pcraft` 字节；空字符串表示默认副本名。 */
  duplicateDocumentBytes(name: string): Uint8Array;
  /** U03：用工作区持有的基线字节恢复当前文档（一步可撤销）。 */
  restoreSavedBaseline(bytes: Uint8Array, baseAssetId: string): string;
  /** U04：File Info；空字符串等价于只读。 */
  fileInfo(paramsJson: string): string;
  /** U04：新建预设（`list` / `save` / `delete`）。 */
  documentPresets(action: string, paramsJson: string): string;
  /** U04：最近的新建设置。 */
  recentDocuments(): string;
  /** U04：记录一次新建设置。 */
  recordRecentDocument(settingsJson: string): string;
};
