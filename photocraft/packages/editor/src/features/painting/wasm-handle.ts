import type { FeatureHandleContext } from "../contracts.js";
import { editorPreview } from "../../ports.js";
import { type EditorResult, type EditorPreview, type EditorPreviewRegion, MAX_ABR_FILE_BYTES } from "../../editor-wasm.js";

export function sampleColor(this: FeatureHandleContext, x: number, y: number): EditorResult<string | null> {
    return this.call((i) => i.sampleColor(x, y) ?? null);
  }

export function beginStroke(this: FeatureHandleContext, params: unknown): EditorResult<void> {
    return this.call((i) => i.beginStroke(JSON.stringify(params)));
  }

/** 本域命令统一入口（U27–U36）：先确认归属，再走内核同一道能力门。 */
export function paintingCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.paintingCommand(id, JSON.stringify(params ?? null))));
  }

/** 独立吸管：`{x, y, size?, sampleLayer?}` → `{hex, alpha, rgba}` 或 `null`。只读。 */
export function sampleColorOptions(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.sampleColorOptions(JSON.stringify(params))));
  }

/** 当前文档的绘画对称状态（未启用为 `{enabled:false}`）。 */
export function symmetryState(this: FeatureHandleContext): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.symmetryStateJson()));
  }

export function renameBrushGroup(this: FeatureHandleContext, group: string, newName: string): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.renameBrushGroup(group, newName)));
  }

export function deleteBrushGroup(this: FeatureHandleContext, group: string, keepPresets: boolean): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.deleteBrushGroup(group, keepPresets)));
  }

export function moveBrushGroup(this: FeatureHandleContext, group: string, index: number): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.moveBrushGroup(group, index)));
  }

/** 从当前选区定义静态笔尖；`group` 为空串表示用内核默认分组。 */
export function defineBrushFromSelection(this: FeatureHandleContext, name: string, group = ""): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.defineBrushFromSelection(name, group)));
  }

export function toolPresets(this: FeatureHandleContext, tool = ""): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.toolPresetsJson(tool)));
  }

export function saveToolPreset(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.saveToolPreset(JSON.stringify(params))));
  }

export function selectToolPreset(this: FeatureHandleContext, name: string): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.selectToolPreset(name)));
  }

export function editToolPreset(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.editToolPreset(JSON.stringify(params))));
  }

export function resetToolPresets(this: FeatureHandleContext): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.resetToolPresets()));
  }

export function toolPresetSnapshot(this: FeatureHandleContext): EditorResult<Uint8Array> {
    return this.call((i) => i.toolPresetSnapshot());
  }

export function restoreToolPresets(this: FeatureHandleContext, bytes: Uint8Array): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.restoreToolPresets(bytes)));
  }

export function brushPresets(this: FeatureHandleContext, full = false): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.brushPresetsJson(full)));
  }

export function brushPreset(this: FeatureHandleContext, name: string): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.brushPresetJson(name)));
  }

export function saveBrushPreset(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.saveBrushPreset(JSON.stringify(params))));
  }

export function renameBrushPreset(this: FeatureHandleContext, name: string, newName: string): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.renameBrushPreset(name, newName)));
  }

export function deleteBrushPreset(this: FeatureHandleContext, name: string): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.deleteBrushPreset(name)));
  }

export function moveBrushPreset(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.moveBrushPreset(JSON.stringify(params))));
  }

export function selectBrushPreset(this: FeatureHandleContext, name: string): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.selectBrushPreset(name)));
  }

export function brushPreview(this: FeatureHandleContext, params: unknown): EditorResult<EditorPreview> {
    return this.call((i) => {
      const preview = editorPreview("brush", () => i.brushPreview(JSON.stringify(params)));
      try {
        const result = { width: preview.width, height: preview.height, pixels: preview.pixels };
        if (!(result.pixels instanceof Uint8Array) || result.pixels.length !== result.width * result.height * 4) {
          throw new Error("笔迹预览数据不完整");
        }
        return result;
      } finally {
        preview.free?.();
      }
    });
  }

export function brushLibrarySnapshot(this: FeatureHandleContext, ): EditorResult<Uint8Array> {
    return this.call((i) => i.brushLibrarySnapshot());
  }

export function restoreBrushLibrary(this: FeatureHandleContext, bytes: Uint8Array): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.restoreBrushLibrary(bytes)));
  }

export function inspectBrushAbr(this: FeatureHandleContext, bytes: Uint8Array, group: string): EditorResult<unknown> {
    return this.call((i) => {
      if (bytes.length > MAX_ABR_FILE_BYTES) throw new Error("ABR 文件不能超过 32 MiB");
      return JSON.parse(i.inspectBrushAbr(bytes, group));
    });
  }

export function commitBrushAbr(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.commitBrushAbr(JSON.stringify(params))));
  }

export function cancelBrushAbr(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.cancelBrushAbr()));
  }

export function importBrushFromImage(this: FeatureHandleContext, name: string, bytes: Uint8Array, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.importBrushFromImage(name, bytes, JSON.stringify(params))));
  }

export function appendStroke(this: FeatureHandleContext, points: unknown): EditorResult<void> {
    return this.call((i) => i.appendStroke(JSON.stringify({ points })));
  }

export function takeStrokeDamage(this: FeatureHandleContext, ):EditorResult<EditorPreviewRegion[]> {
    return this.call(i=>{
      const regions:unknown=JSON.parse(i.takeStrokeDamage());
      if(!Array.isArray(regions) || regions.length>1 || !regions.every(r=>r&&typeof r==="object"&&
        [r.x,r.y,r.width,r.height].every(Number.isSafeInteger)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=32768&&r.y+r.height<=32768))throw new Error("笔迹改动范围无效");
      return regions as EditorPreviewRegion[];
    });
  }

export function commitStroke(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => i.commitStroke());
  }

export function cancelStroke(this: FeatureHandleContext, ): EditorResult<void> {
    return this.call((i) => i.cancelStroke());
  }

export function createHandle(context: () => FeatureHandleContext) {
  return {
    sampleColor: (...args: Parameters<OmitThisParameter<typeof sampleColor>>) => sampleColor.apply(context(), args),
    beginStroke: (...args: Parameters<OmitThisParameter<typeof beginStroke>>) => beginStroke.apply(context(), args),
    paintingCommand: (...args: Parameters<OmitThisParameter<typeof paintingCommand>>) => paintingCommand.apply(context(), args),
    sampleColorOptions: (...args: Parameters<OmitThisParameter<typeof sampleColorOptions>>) => sampleColorOptions.apply(context(), args),
    symmetryState: (...args: Parameters<OmitThisParameter<typeof symmetryState>>) => symmetryState.apply(context(), args),
    renameBrushGroup: (...args: Parameters<OmitThisParameter<typeof renameBrushGroup>>) => renameBrushGroup.apply(context(), args),
    deleteBrushGroup: (...args: Parameters<OmitThisParameter<typeof deleteBrushGroup>>) => deleteBrushGroup.apply(context(), args),
    moveBrushGroup: (...args: Parameters<OmitThisParameter<typeof moveBrushGroup>>) => moveBrushGroup.apply(context(), args),
    defineBrushFromSelection: (...args: Parameters<OmitThisParameter<typeof defineBrushFromSelection>>) => defineBrushFromSelection.apply(context(), args),
    toolPresets: (...args: Parameters<OmitThisParameter<typeof toolPresets>>) => toolPresets.apply(context(), args),
    saveToolPreset: (...args: Parameters<OmitThisParameter<typeof saveToolPreset>>) => saveToolPreset.apply(context(), args),
    selectToolPreset: (...args: Parameters<OmitThisParameter<typeof selectToolPreset>>) => selectToolPreset.apply(context(), args),
    editToolPreset: (...args: Parameters<OmitThisParameter<typeof editToolPreset>>) => editToolPreset.apply(context(), args),
    resetToolPresets: (...args: Parameters<OmitThisParameter<typeof resetToolPresets>>) => resetToolPresets.apply(context(), args),
    toolPresetSnapshot: (...args: Parameters<OmitThisParameter<typeof toolPresetSnapshot>>) => toolPresetSnapshot.apply(context(), args),
    restoreToolPresets: (...args: Parameters<OmitThisParameter<typeof restoreToolPresets>>) => restoreToolPresets.apply(context(), args),
    brushPresets: (...args: Parameters<OmitThisParameter<typeof brushPresets>>) => brushPresets.apply(context(), args),
    brushPreset: (...args: Parameters<OmitThisParameter<typeof brushPreset>>) => brushPreset.apply(context(), args),
    saveBrushPreset: (...args: Parameters<OmitThisParameter<typeof saveBrushPreset>>) => saveBrushPreset.apply(context(), args),
    renameBrushPreset: (...args: Parameters<OmitThisParameter<typeof renameBrushPreset>>) => renameBrushPreset.apply(context(), args),
    deleteBrushPreset: (...args: Parameters<OmitThisParameter<typeof deleteBrushPreset>>) => deleteBrushPreset.apply(context(), args),
    moveBrushPreset: (...args: Parameters<OmitThisParameter<typeof moveBrushPreset>>) => moveBrushPreset.apply(context(), args),
    selectBrushPreset: (...args: Parameters<OmitThisParameter<typeof selectBrushPreset>>) => selectBrushPreset.apply(context(), args),
    brushPreview: (...args: Parameters<OmitThisParameter<typeof brushPreview>>) => brushPreview.apply(context(), args),
    brushLibrarySnapshot: (...args: Parameters<OmitThisParameter<typeof brushLibrarySnapshot>>) => brushLibrarySnapshot.apply(context(), args),
    restoreBrushLibrary: (...args: Parameters<OmitThisParameter<typeof restoreBrushLibrary>>) => restoreBrushLibrary.apply(context(), args),
    inspectBrushAbr: (...args: Parameters<OmitThisParameter<typeof inspectBrushAbr>>) => inspectBrushAbr.apply(context(), args),
    commitBrushAbr: (...args: Parameters<OmitThisParameter<typeof commitBrushAbr>>) => commitBrushAbr.apply(context(), args),
    cancelBrushAbr: (...args: Parameters<OmitThisParameter<typeof cancelBrushAbr>>) => cancelBrushAbr.apply(context(), args),
    importBrushFromImage: (...args: Parameters<OmitThisParameter<typeof importBrushFromImage>>) => importBrushFromImage.apply(context(), args),
    appendStroke: (...args: Parameters<OmitThisParameter<typeof appendStroke>>) => appendStroke.apply(context(), args),
    takeStrokeDamage: (...args: Parameters<OmitThisParameter<typeof takeStrokeDamage>>) => takeStrokeDamage.apply(context(), args),
    commitStroke: (...args: Parameters<OmitThisParameter<typeof commitStroke>>) => commitStroke.apply(context(), args),
    cancelStroke: (...args: Parameters<OmitThisParameter<typeof cancelStroke>>) => cancelStroke.apply(context(), args),
  };
}
