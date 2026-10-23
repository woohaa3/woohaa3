import type { EditorPreview, WasmResource } from "../../editor-wasm.js";
export type FeatureEditorInstance = {
patternLibrary():string;
importPatternPresets(bytes:Uint8Array):string;
renamePatternPreset(key:string,name:string):string;
deletePatternPreset(key:string):string;
exportPatternPresets(key?:string):Uint8Array;
patternLibrarySnapshot():Uint8Array;
restorePatternLibrary(bytes:Uint8Array):string;
importContourPresets(bytes:Uint8Array):string;
exportContourPreset(contourJson:string):Uint8Array;
beginLayerProperties(layer:number):string;
stylePositionFrame(index:number):string;
previewLayerProperties(paramsJson:string):string;
commitLayerProperties():string;
cancelLayerProperties():void;
layerThumbnail(layer: number, mask: boolean, maxSide: number): WasmResource<EditorPreview>;
exportLayerTransfer(paramsJson: string): Uint8Array;
inspectLayerTransfer(bytes: Uint8Array): string;
canPasteLayerTransfer(bytes: Uint8Array): string;
pasteLayerTransfer(bytes: Uint8Array, paramsJson: string): string;
filterLayers(paramsJson: string): string;
/** U57：新建填充层（`layer.newFillLayer.*`），返回规范参数。 */
newFillLayer(id: string, paramsJson: string): string;
/** U57：填充层规范参数（只读）。 */
fillLayerInfo(layer: number): string;
/** U57：填充参数预览（纯函数，不推进正式内容）。 */
previewFillLayer(layer: number, paramsJson: string): string;
/** U57：确认填充参数（一步提交）。 */
applyFillLayer(layer: number, paramsJson: string): string;
/** U58–U62、U64：本域统一入口；`preview` 为真时只返回候选像素。 */
layerWorkflow(id: string, paramsJson: string, preview: boolean): string;
/** U64：图层复合列表（只读）。 */
layerComps(): string;
/** U59：粘贴入/外的选区、剪贴板与目标摘要（只读）。 */
pasteRegion(): string;
/** U61：样式预设管理（`list`/`new`/`edit`/`reset`），只改会话偏好。 */
stylePresets(id: string, paramsJson: string): string;
};
