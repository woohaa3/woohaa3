/** 内核导出的源对象（wasm-bindgen 类实例，字段是原型 getter）。 */
export type FeatureSmartSourceExport = {
  readonly name: string;
  readonly bytes: Uint8Array;
  free?: () => void;
};

export type FeatureEditorInstance = {
beginSmartChild(layer: number): string;
updateSmartParent(attemptId: string, child: Uint8Array): string;
reloadSmartChild(): string;
exportSmartChild(): Uint8Array;
detachSmartChild(): string;
closeSmartChild(): string;
smartChildStateJson(): string;
convertToSmartObject(layersJson: string): string;
duplicateSmartObject(layersJson: string, independent: boolean): string;
replaceSmartContents(layer: number, bytes: Uint8Array): string;
rasterizeSmartObject(layer: number): string;
smartLayerStateJson(layer: number): string;
exportSmartSource(layer: number): FeatureSmartSourceExport;
convertSmartToLayers(layer: number): string;
};
