import type { EditorPreview, WasmResource } from "../../editor-wasm.js";

/** 本域在稳定 wasm 类型面上的新增方法（与 `crates/editor-core/src/features/channels/wasm.rs` 对齐）。 */
export type FeatureEditorInstance = {
  channelCommand(id: string, paramsJson: string): string;
  channelSnapshotJson(): string;
  channelThumbnail(referenceJson: string, maxSide: number): WasmResource<EditorPreview>;
  channelViewPreview(maxSide: number): WasmResource<EditorPreview>;
  channelCalcPreview(id: string, paramsJson: string, maxSide: number): WasmResource<EditorPreview>;
  channelCalcPreviewJson(id: string, paramsJson: string, maxSide: number): string;
};
