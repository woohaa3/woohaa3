import type { FeatureHandleContext } from "../contracts.js";
import { editorPhase } from "../../ports.js";
import type { EditorPreview, EditorResult, WasmResource } from "../../editor-wasm.js";

/** 把 wasm 资源对象读成普通数据并立即释放，避免跨帧持有 wasm 内存。 */
function preview(this: FeatureHandleContext, run: (instance: FeatureHandleContext["instance"]) => WasmResource<EditorPreview>): EditorResult<EditorPreview> {
  return this.call((instance) => {
    const preview = editorPhase("image-editor.channel-preview", () => run(instance));
    try {
      const width = preview.width;
      const height = preview.height;
      const pixels = preview.pixels;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("通道预览尺寸无效");
      if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * 4) throw new Error("通道预览像素数据不完整");
      return { width, height, pixels };
    } finally {
      preview.free?.();
    }
  });
}

export function channelCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  return this.call((instance) => JSON.parse(instance.channelCommand(id, JSON.stringify(params ?? null))));
}

export function channelSnapshot(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((instance) => JSON.parse(instance.channelSnapshotJson()));
}

export function channelThumbnail(this: FeatureHandleContext, reference: unknown, maxSide: number): EditorResult<EditorPreview> {
  return preview.call(this, (instance) => instance.channelThumbnail(JSON.stringify(reference), maxSide));
}

export function channelViewPreview(this: FeatureHandleContext, maxSide: number): EditorResult<EditorPreview> {
  return preview.call(this, (instance) => instance.channelViewPreview(maxSide));
}

export function channelCalcPreview(this: FeatureHandleContext, id: string, params: unknown, maxSide: number): EditorResult<EditorPreview> {
  return preview.call(this, (instance) => instance.channelCalcPreview(id, JSON.stringify(params ?? null), maxSide));
}

export function channelCalcPreviewSummary(this: FeatureHandleContext, id: string, params: unknown, maxSide: number): EditorResult<unknown> {
  return this.call((instance) => JSON.parse(instance.channelCalcPreviewJson(id, JSON.stringify(params ?? null), maxSide)));
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    channelCommand: (...args: Parameters<OmitThisParameter<typeof channelCommand>>) => channelCommand.apply(context(), args),
    channelSnapshot: (...args: Parameters<OmitThisParameter<typeof channelSnapshot>>) => channelSnapshot.apply(context(), args),
    channelThumbnail: (...args: Parameters<OmitThisParameter<typeof channelThumbnail>>) => channelThumbnail.apply(context(), args),
    channelViewPreview: (...args: Parameters<OmitThisParameter<typeof channelViewPreview>>) => channelViewPreview.apply(context(), args),
    channelCalcPreview: (...args: Parameters<OmitThisParameter<typeof channelCalcPreview>>) => channelCalcPreview.apply(context(), args),
    channelCalcPreviewSummary: (...args: Parameters<OmitThisParameter<typeof channelCalcPreviewSummary>>) => channelCalcPreviewSummary.apply(context(), args)
  };
}
