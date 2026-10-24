/**
 * 导出对话框（I045）。
 *
 * 只收集格式与控制参数；真正的编码由内核 `exportImage` 完成，字节经既有单文件交付端口
 * 交给宿主。没有任何图案/切片/批量多文件语义——那些由处置矩阵明确不支持。
 */
import {useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps,EditorExportOptions} from "./ports.js";
import {DEFAULT_EXPORT_OPTIONS,EXPORT_FORMATS} from "./ports.js";
import type{EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";

const DIALOG="image-editor.export";
const FORMATS=Object.entries(EXPORT_FORMATS) as [EditorExportOptions["format"],{label:string;extension:string;contentType:string}][];

export function decodeExportOptions(value:unknown):EditorExportOptions|null {
  if(!value||typeof value!=="object")return null;
  const raw=value as Record<string,unknown>;
  if(!FORMATS.some(([id])=>id===raw.format))return null;
  const number=(key:string,min:number,max:number,fallback:number)=>typeof raw[key]==="number"&&Number.isFinite(raw[key])&&(raw[key] as number)>=min&&(raw[key] as number)<=max?raw[key] as number:fallback;
  return {
    format:raw.format as EditorExportOptions["format"],
    jpegQuality:number("jpegQuality",1,100,DEFAULT_EXPORT_OPTIONS.jpegQuality),
    jpegChromaSubsampling:typeof raw.jpegChromaSubsampling==="boolean"?raw.jpegChromaSubsampling:DEFAULT_EXPORT_OPTIONS.jpegChromaSubsampling,
    pngCompression:raw.pngCompression==="fast"||raw.pngCompression==="best"||raw.pngCompression==="none"||raw.pngCompression==="default"?raw.pngCompression:DEFAULT_EXPORT_OPTIONS.pngCompression,
    pngInterlaced:typeof raw.pngInterlaced==="boolean"?raw.pngInterlaced:DEFAULT_EXPORT_OPTIONS.pngInterlaced,
    webpLossless:typeof raw.webpLossless==="boolean"?raw.webpLossless:DEFAULT_EXPORT_OPTIONS.webpLossless,
    webpQuality:number("webpQuality",0,100,DEFAULT_EXPORT_OPTIONS.webpQuality),
    tiffCompression:raw.tiffCompression==="none"||raw.tiffCompression==="deflate"||raw.tiffCompression==="packbits"?raw.tiffCompression:DEFAULT_EXPORT_OPTIONS.tiffCompression,
    embedMetadata:typeof raw.embedMetadata==="boolean"?raw.embedMetadata:DEFAULT_EXPORT_OPTIONS.embedMetadata,
    scale:number("scale",0.01,8,DEFAULT_EXPORT_OPTIONS.scale)
  };
}

function ExportDialog({instance,requestClose,apply,scaleWarning}:EditorDialogRendererProps & {
  apply:(options:EditorExportOptions)=>Promise<string|null>;
  scaleWarning:(scale:number)=>string|null;
}) {
  const [value,setValue]=useState<EditorExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const update=(patch:Partial<EditorExportOptions>)=>setValue(current=>({...current,...patch}));
  const warning=scaleWarning(value.scale);
  return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="导出"><form onSubmit={async event=>{
    event.preventDefault();if(busy)return;setBusy(true);setError(null);
    try{const failure=await apply(value);if(failure){setError(failure);return;}requestClose();}
    finally{setBusy(false);}
  }}>
    <DialogHeader onClose={requestClose}><DialogTitle>导出</DialogTitle></DialogHeader><DialogBody>
      <label>格式<select value={value.format} onChange={event=>update({format:event.currentTarget.value as EditorExportOptions["format"]})}>
        {FORMATS.map(([id,meta])=><option key={id} value={id}>{meta.label}</option>)}</select></label>
      <label>缩放（%）<input type="number" min={1} max={800} step={1} value={Math.round(value.scale*100)}
        onChange={event=>{const next=Number(event.currentTarget.value);if(Number.isFinite(next)&&next>=1&&next<=800)update({scale:next/100});}}/></label>
      {value.format==="jpeg"?<>
        <label>质量<input type="number" min={1} max={100} value={value.jpegQuality} onChange={event=>update({jpegQuality:Number(event.currentTarget.value)})}/></label>
        <label><input type="checkbox" checked={value.jpegChromaSubsampling} onChange={event=>update({jpegChromaSubsampling:event.currentTarget.checked})}/>色度二次采样（4:2:0）</label>
      </>:null}
      {value.format==="webp"?<>
        <label><input type="checkbox" checked={value.webpLossless} onChange={event=>update({webpLossless:event.currentTarget.checked})}/>无损</label>
        {!value.webpLossless?<label>质量<input type="number" min={0} max={100} value={value.webpQuality} onChange={event=>update({webpQuality:Number(event.currentTarget.value)})}/></label>:null}
      </>:null}
      {value.format==="png"?<>
        <label>压缩<select value={value.pngCompression} onChange={event=>update({pngCompression:event.currentTarget.value as EditorExportOptions["pngCompression"]})}>
          <option value="default">默认</option><option value="fast">快</option><option value="best">最小</option><option value="none">不压缩</option></select></label>
        <label><input type="checkbox" checked={value.pngInterlaced} onChange={event=>update({pngInterlaced:event.currentTarget.checked})}/>隔行扫描</label>
      </>:null}
      {value.format==="tiff"?<label>压缩<select value={value.tiffCompression} onChange={event=>update({tiffCompression:event.currentTarget.value as EditorExportOptions["tiffCompression"]})}>
        <option value="lzw">LZW</option><option value="deflate">Deflate</option><option value="packbits">PackBits</option><option value="none">无</option></select></label>:null}
      <label><input type="checkbox" checked={value.embedMetadata} onChange={event=>update({embedMetadata:event.currentTarget.checked})}/>嵌入元数据</label>
      <p>导出当前修订的扁平图像，不改变工程保存状态；文件名使用当前文档名。</p>
      {warning?<p className="dlg__error">{warning}</p>:null}
      {error?<p className="dlg__error">{error}</p>:null}
    </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={busy||!!warning}>{busy?"正在导出…":"导出"}</Button></DialogFooter>
  </form></DialogContent>;
}

export function useExportDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:()=>boolean) {
  const opening=useRef(false),instance=useRef<string|null>(null);
  return {
    available:!!dialogs&&typeof controller.hasFileDelivery==="function"&&controller.hasFileDelivery(),
    open:()=>{
      if(!dialogs||blocked()||dialogs.isModalActive())return false;
      opening.current=true;
      try{const result=dialogs.open({dialogId:DIALOG});if(!result.ok)return false;instance.current=result.instance.instanceId;return true;}
      finally{opening.current=false;}
    },
    register:()=>{
      if(!dialogs)return()=>{};
      return dialogs.registerDialog(DIALOG,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current&&!blocked()?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的导出请求"}},renderer:props=><ExportDialog {...props}
        scaleWarning={scale=>{
          const document=controller.snapshot().view.document;
          if(!document)return "没有可导出的文档";
          const width=Math.round(document.width*scale),height=Math.round(document.height*scale);
          return width>=1&&height>=1&&width<=300_000&&height<=300_000?null:`导出尺寸 ${width}×${height} 超出上限`;
        }}
        apply={async options=>{
          if(blocked())return "请先结束当前操作";
          const outcome=await controller.exportImage(options);
          return outcome.ok?null:outcome.message??"导出失败，请重试";
        }}/>});
    }
  };
}
