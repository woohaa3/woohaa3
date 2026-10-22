import { useEffect, useRef, useState } from "react";
import { LayersIcon, MaskIcon } from "./ui/icons.js";
import type { EditorPreview, EditorResult } from "./editor-wasm.js";

export type LayerThumbnailReader = (layer: number, mask: boolean) => EditorResult<EditorPreview>;
/** 缩略图只读取正式文档；绘画与变换草稿仍由原节点单独呈现。 */
export function LayerThumbnail({layer,mask=false,revision,read}: {layer:number;mask?:boolean;revision:number;read?:LayerThumbnailReader}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const [preview,setPreview]=useState<EditorPreview|null>(null);
  useEffect(() => {
    const result=read?.(layer,mask);
    setPreview(result?.ok ? result.value : null);
  },[layer,mask,revision,read]);
  useEffect(() => {
    if (!preview) return;
    const context=canvas.current?.getContext("2d");
    if (context) context.putImageData(new ImageData(new Uint8ClampedArray(preview.pixels),preview.width,preview.height),0,0);
  },[preview]);
  return preview ? <canvas ref={canvas} width={preview.width} height={preview.height} /> : mask ? <MaskIcon size={18} /> : <LayersIcon size={18} />;
}
