import {TrimImageDialog,DEFAULT_TRIM,decodeTrimOptions} from "./trim-image-dialog.js";
import {useToolMemory} from "./tool-memory.js";
import {ArithmeticInput} from "./arithmetic-input.js";
import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorPreview,EditorResult} from "./editor-wasm.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
export type GeometryAction="canvas"|"rotate"|"size"|"fit"|"trim";
const ids={canvas:"image.canvasSize",rotate:"image.rotation.arbitrary",size:"image.imageSize",fit:"file.automate.fitImage",trim:"image.trim"} as const;
const anchors=[["topLeft","左上"],["top","上"],["topRight","右上"],["left","左"],["center","中心"],["right","右"],["bottomLeft","左下"],["bottom","下"],["bottomRight","右下"]] as const;
function GeometryDialog({instance,requestClose,action,width,height,dpi,apply,preview}:EditorDialogRendererProps & {action:Exclude<GeometryAction,"trim">;width:number;height:number;dpi:number;preview?:(params:unknown)=>EditorResult<EditorPreview>;apply:(params:unknown)=>string|null}) {
 const [w,setW]=useState(String(width)),[h,setH]=useState(String(height)),[relative,setRelative]=useState(false),[anchor,setAnchor]=useState("center"),[color,setColor]=useState("background");
 const [angle,setAngle]=useState("0"),[direction,setDirection]=useState("cw"),[interpolation,setInterpolation]=useState("bicubic"),[error,setError]=useState<string|null>(null);
 const [resolution,setResolution]=useState(String(dpi)),[resample,setResample]=useState("bicubic"),[aspect,setAspect]=useState(true),[percent,setPercent]=useState(false);
 const [dontEnlarge,setDontEnlarge]=useState(false);
 const title=action==="fit"?"适合图像":action==="size"?"图像大小":action==="canvas"?"画布大小":"旋转画布";
 const previewCanvas=useRef<HTMLCanvasElement|null>(null),previewPort=useRef(preview);previewPort.current=preview;
 const [previewError,setPreviewError]=useState<string|null>(null);
 useEffect(()=>{
  if(action!=="rotate" || !previewPort.current)return;
  const frame=requestAnimationFrame(()=>{
   const result=previewPort.current?.({angle:angle.trim()?Number(angle):null,direction,interpolation});
   if(!result || !result.ok){setPreviewError(result && !result.ok?result.message:"无法生成旋转预览");return;}
   const canvas=previewCanvas.current,context=canvas?.getContext("2d");if(!canvas || !context){setPreviewError("无法显示旋转预览");return;}
   const image=result.value;canvas.width=image.width;canvas.height=image.height;const data=context.createImageData(image.width,image.height);data.data.set(image.pixels);context.putImageData(data,0,0);setPreviewError(null);
  });
  return()=>cancelAnimationFrame(frame);
 },[action,angle,direction,interpolation]);
 const validNumber=(value:string)=>value.trim()!=="" && Number.isFinite(Number(value));
 const targetW=Number(w)+(relative?width:0),targetH=Number(h)+(relative?height:0);
 const validCanvas=validNumber(w) && validNumber(h) && Number.isInteger(Number(w)) && Number.isInteger(Number(h)) && targetW>=1 && targetH>=1 && targetW<=8192 && targetH<=8192;
 const validSize=validNumber(resolution) && Number(resolution)>=1 && Number(resolution)<=10000 && (resample==="none" || validNumber(w) && validNumber(h) && Number(w)>0 && Number(h)>0 && (percent || Number.isInteger(Number(w)) && Number.isInteger(Number(h)) && Number(w)<=8192 && Number(h)<=8192));
 const validFit=validNumber(w) && validNumber(h) && Number.isInteger(Number(w)) && Number.isInteger(Number(h)) && Number(w)>=1 && Number(h)>=1 && Number(w)<=8192 && Number(h)<=8192;
 const fitScale=Math.min(Number(w)/width,Number(h)/height,dontEnlarge?1:Infinity);
 const valid=action==="fit"?validFit:action==="size"?validSize:action==="canvas"?validCanvas:validNumber(angle) && Math.abs(Number(angle))<=359.99;
 return <DialogContent size="sm" ariaLabel={title} instanceId={instance.instanceId}><form onSubmit={event=>{event.preventDefault();if(!valid){setError(action==="fit"?"最大宽高须为 1–8192 的整数像素。":action==="size"?"请输入有效的图像尺寸及 1–10000 DPI 分辨率。":action==="canvas"?"结果宽高须为 1–8192 的整数像素。":"请输入 -359.99–359.99° 范围内的角度。");return;}const failure=apply(action==="fit"?{width:Number(w),height:Number(h),dontEnlarge,resample:"bicubic"}:action==="size"?{...(resample==="none"?{}:percent?{percent:Number(w)}:{width:Number(w),height:Number(h)}),resolution:Number(resolution),resample}:action==="canvas"?{width:Number(w),height:Number(h),relative,anchor,extensionColor:color}:{angle:Number(angle),direction,interpolation});if(failure)setError(failure);else requestClose();}}>
 <DialogHeader onClose={requestClose}><DialogTitle>{title}</DialogTitle></DialogHeader><DialogBody>
 {action==="fit"?<>
 <label>最大宽度（px）<ArithmeticInput autoFocus invalidate min={1} max={8192} step={1} units={{unit:"px",dpi}} value={w} onChange={event=>setW(event.currentTarget.value)}/></label>
 <label>最大高度（px）<ArithmeticInput invalidate min={1} max={8192} step={1} units={{unit:"px",dpi}} value={h} onChange={event=>setH(event.currentTarget.value)}/></label>
 <label><input type="checkbox" checked={dontEnlarge} onChange={event=>setDontEnlarge(event.currentTarget.checked)}/>禁止放大</label>
 {validFit?<p>结果：{Math.max(1,Math.round(width*fitScale))} × {Math.max(1,Math.round(height*fitScale))} px，保持纵横比。</p>:null}
 </>:action==="size"?<>
 <label>单位<select disabled={resample==="none"} value={percent?"percent":"pixels"} onChange={event=>{const pc=event.currentTarget.value==="percent";setPercent(pc);setW(pc?"100":String(width));setH(pc?"100":String(height));}}><option value="pixels">像素</option><option value="percent">百分比</option></select></label>
 <label>{percent?"比例（%）":"宽度（px）"}<ArithmeticInput autoFocus disabled={resample==="none"} invalidate  min={1} step={percent?"any":1} units={{unit:action==="size"&&percent?"%":"px",dpi:Number(resolution)||72}} value={w} onChange={event=>{const value=event.currentTarget.value;setW(value);if(aspect && !percent && validNumber(value))setH(String(Math.max(1,Math.round(Number(value)*height/width))));}}/></label>
 {!percent?<><label>高度（px）<ArithmeticInput disabled={resample==="none"} invalidate  min={1} step={1} units={{unit:"px",dpi:Number(resolution)||72}} value={h} onChange={event=>{const value=event.currentTarget.value;setH(value);if(aspect && validNumber(value))setW(String(Math.max(1,Math.round(Number(value)*width/height))));}}/></label><label><input type="checkbox" checked={aspect} disabled={resample==="none"} onChange={event=>{const checked=event.currentTarget.checked;setAspect(checked);if(checked && validNumber(w))setH(String(Math.max(1,Math.round(Number(w)*height/width))));}}/>约束比例</label></>:null}
 <label>分辨率（DPI）<ArithmeticInput invalidate  min={1} max={10000} step="any" value={resolution} onChange={event=>setResolution(event.currentTarget.value)}/></label>
 <label>重采样<select value={resample} onChange={event=>setResample(event.currentTarget.value)}>{[["none","关闭（仅修改分辨率）"],["automatic","自动"],["nearest","邻近"],["bilinear","双线性"],["bicubic","双三次"],["bicubicSmoother","双三次较平滑"],["bicubicSharper","双三次较锐利"],["lanczos","Lanczos"],["preserveDetails","保留细节"]].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
 <p>{resample==="none"?`像素尺寸保持 ${width} × ${height} px。`:`结果像素尺寸不超过 8192 × 8192。`}</p>
 </>:action==="canvas"?<>
 <p>当前画布：{width} × {height} px</p>
 <label>宽度（px）<ArithmeticInput autoFocus invalidate  step={1} units={{unit:"px",dpi:Number(resolution)||72}} value={w} onChange={event=>setW(event.currentTarget.value)}/></label>
 <label>高度（px）<ArithmeticInput invalidate  step={1} units={{unit:"px",dpi:Number(resolution)||72}} value={h} onChange={event=>setH(event.currentTarget.value)}/></label>
 <label><input type="checkbox" checked={relative} onChange={event=>{const checked=event.currentTarget.checked;setRelative(checked);setW(checked?"0":String(width));setH(checked?"0":String(height));}}/>相对当前画布增减</label>
 <label>锚点<select value={anchor} onChange={event=>setAnchor(event.currentTarget.value)}>{anchors.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
 <label>画布扩展颜色<select value={color} onChange={event=>setColor(event.currentTarget.value)}>{[["background","背景色"],["foreground","前景色"],["white","白色"],["black","黑色"],["transparent","透明"]].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
 {validCanvas?<p>结果：{targetW} × {targetH} px{targetW<width || targetH<height?"。画布外的图层像素仍保留。":""}</p>:null}
 </>:<><label>角度（°）<ArithmeticInput autoFocus invalidate  min={-359.99} max={359.99} step="any" units={{unit:"°"}} value={angle} onChange={event=>setAngle(event.currentTarget.value)}/></label>
 <label>方向<select value={direction} onChange={event=>setDirection(event.currentTarget.value)}><option value="cw">顺时针</option><option value="ccw">逆时针</option></select></label>
 <label>插值<select value={interpolation} onChange={event=>setInterpolation(event.currentTarget.value)}><option value="nearest">邻近</option><option value="bilinear">双线性</option><option value="bicubic">双三次</option></select></label><p>画布将扩展以容纳旋转结果；超出尺寸上限时不应用。</p></>}
 {action==="rotate" && preview?<><canvas ref={previewCanvas} className="photo-editor-rotation-preview" style={{maxWidth:"100%",height:"auto"}}/>{previewError?<p className="dlg__error">{previewError}</p>:null}</>:null}
 {error?<p className="dlg__error">{error}</p>:null}
 </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!valid}>应用</Button></DialogFooter></form></DialogContent>;
}
export function useImageGeometryDialogs(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,refresh:()=>void,error:(message:string|null)=>void,colors:{foreground:string;background:string}) {
 const [trim,setTrim]=useToolMemory("trim",DEFAULT_TRIM,decodeTrimOptions);
 const latest=useRef({blocked,refresh,error,colors,trim,setTrim});latest.current={blocked,refresh,error,colors,trim,setTrim};
 const opening=useRef(false),instance=useRef<string|null>(null),request=useRef<{action:GeometryAction;owner:string;width:number;height:number;dpi:number}|null>(null);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.document?.revision]);
 useEffect(()=>{
  if(!dialogs)return;
  const unsubscribe=dialogs.subscribe(()=>{
    if(instance.current && dialogs.top()?.instanceId!==instance.current){if(request.current?.action==="rotate"){controller.cancelImageRotation();latest.current.refresh();}instance.current=null;request.current=null;}
  });
  const cleanups=(["canvas","rotate","size","fit","trim"] as const).map(action=>dialogs.registerDialog(`image-editor.geometry-${action}`,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的图像操作"}},renderer:props=>action==="trim"?<TrimImageDialog {...props} initial={latest.current.trim} apply={value=>{
   const expected=request.current,command=controller.snapshot().commands.get(ids.trim);
   if(latest.current.blocked || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId || expected?.action!=="trim" || expected.owner!==owner())return "文档已变化，请关闭后重新打开。";
   if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前无法修整图像。";
   const result=controller.dispatch(ids.trim,value);latest.current.refresh();if(result.ok)latest.current.setTrim(value);return result.ok?null:result.message;
  }}/>:<GeometryDialog {...props} requestClose={()=>{if(action==="rotate")controller.cancelImageRotation();props.requestClose();}} preview={action==="rotate"?params=>{const result=controller.previewImageRotation({...params as Record<string,unknown>,backgroundColor:latest.current.colors.background});return result.ok?controller.render(384):result;}:undefined} action={action} width={request.current?.width??1} height={request.current?.height??1} dpi={request.current?.dpi??72} apply={params=>{
   const expected=request.current,command=controller.snapshot().commands.get(ids[action]);
   if(latest.current.blocked || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId || expected?.action!==action || expected.owner!==owner())return "文档已变化，请关闭后重新打开。";
   if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前无法修改图像。";
   const value=params as Record<string,unknown>;
   if(action==="canvas" && (value.extensionColor==="foreground" || value.extensionColor==="background"))value.extensionColor=latest.current.colors[value.extensionColor];
   if(action==="rotate") {value.backgroundColor=latest.current.colors.background;const updated=controller.previewImageRotation(value);if(!updated.ok)return updated.message;const committed=controller.commitImageRotation();latest.current.refresh();return committed.ok?null:committed.message;}
   const result=controller.dispatch(ids[action],value);latest.current.refresh();return result.ok?null:result.message;
  }}/> }));
  return()=>{if(request.current?.action==="rotate")controller.cancelImageRotation();if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unsubscribe();cleanups.forEach(cleanup=>cleanup());};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){if(request.current?.action==="rotate")controller.cancelImageRotation();dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:(action:GeometryAction)=>{
  const snapshot=controller.snapshot(),doc=snapshot.view.document,command=snapshot.commands.get(ids[action]);
  if(!dialogs || latest.current.blocked || !doc || !command?.allowed || !command.enabled || dialogs.isModalActive()){latest.current.error("请先结束当前操作，再修改图像。");return false;}
  request.current={action,owner:owner(),width:doc.width,height:doc.height,dpi:doc.resolutionDpi??72};opening.current=true;
  try {const result=dialogs.open({dialogId:`image-editor.geometry-${action}`});if(!result.ok){latest.current.error(result.error);return false;}instance.current=result.instance.instanceId;
   if(action==="rotate"){const begun=controller.beginImageRotation();if(!begun.ok){dialogs.close(instance.current);instance.current=null;request.current=null;latest.current.error(begun.message);return false;}}
   latest.current.error(null);return true;}finally{opening.current=false;}
 }};
}
