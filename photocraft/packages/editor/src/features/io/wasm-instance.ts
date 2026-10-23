import type { EditorExportBundle, WasmResource } from "../../editor-wasm.js";

/** 一次编码/打包产物：真实字节 + 报告（与 Rust `WasmEncodedImage` 一一对应）。 */
export type FeatureEncodedImage = { bytes: Uint8Array; reportJson: string };

/**
 * 本域新增的 WASM 绑定（change: 2026-10-22-add-photocraft-raster-interchange）。
 *
 * 前 11 项是既有调用面；从 `interchangeMatrixJson` 起是本 change 新增。**新增项声明为可选**，
 * 因为宿主运行时可能仍加载着未包含这些导出的旧 `.wasm` 产物：此时域内要给出「需更新内核产物」
 * 的明确失败，而不是 `TypeError: not a function`。真正调用前统一经
 * `wasm-handle.ts` 的 `interchangeBindings` 收窄。
 */
export type FeatureEditorInstance = {
placeImage(name: string, assetId: string, bytes: Uint8Array, paramsJson: string): string;
saveProject(): Uint8Array;
exportBundle(): WasmResource<EditorExportBundle>;
inspectPlaceAsset(bytes: Uint8Array): string;
placeAsset(paramsJson: string, bytes: Uint8Array): string;
psdMatrixJson(): string;
inspectPsd(bytes: Uint8Array): string;
importPsd(bytes: Uint8Array, paramsJson: string): string;
inspectPsdExport(): string;
exportPsd(paramsJson: string): Uint8Array;
lastPsdExportReportJson(): string;
interchangeMatrixJson?(): string;
inspectRaster?(bytes: Uint8Array): string;
openRaster?(name: string, bytes: Uint8Array): string;
exportMatrixJson?(): string;
inspectExport?(paramsJson: string): string;
previewExport?(paramsJson: string): WasmResource<FeatureEncodedImage>;
exportRaster?(paramsJson: string): WasmResource<FeatureEncodedImage>;
inspectLayerExport?(paramsJson: string): string;
exportLayerBundle?(paramsJson: string): WasmResource<FeatureEncodedImage>;
exportLayerAs?(paramsJson: string): WasmResource<FeatureEncodedImage>;
inspectImageAssets?(): string;
exportImageAssets?(): WasmResource<FeatureEncodedImage>;
inspectIoBundle?(bytes: Uint8Array): string;
};

/** 本域新增绑定名（用于一次性核对与错误信息）。 */
export const INTERCHANGE_BINDINGS = [
  "interchangeMatrixJson",
  "inspectRaster",
  "openRaster",
  "exportMatrixJson",
  "inspectExport",
  "previewExport",
  "exportRaster",
  "inspectLayerExport",
  "exportLayerBundle",
  "exportLayerAs",
  "inspectImageAssets",
  "exportImageAssets",
  "inspectIoBundle"
] as const;

export type InterchangeBindingName = (typeof INTERCHANGE_BINDINGS)[number];

/** 收窄后的本域绑定（全部必需）。 */
export type InterchangeBindings = {
  [Key in InterchangeBindingName]-?: NonNullable<FeatureEditorInstance[Key]>;
};
