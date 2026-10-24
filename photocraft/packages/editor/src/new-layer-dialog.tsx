import {ArithmeticInput} from "./arithmetic-input.js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EditorDialogPort, EditorDialogRendererProps } from "./ports.js";
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/Dialog.js";
import { Button } from "./ui/Button.js";
import {IMAGE_PROJECT_LAYER_LABELS,LAYER_LABEL_NAMES} from "./layer-labels.js";
import {PHOTOSHOP_BLENDS} from "./editor-view-model.js";
import {BLEND_LABELS} from "./photo-editor-panels.js";
import type { EditorWorkspaceController } from "./editor-workspace.js";

const DIALOG_ID = "image-editor.new-layer";
const idleSubscribe = () => () => {};
const noModal = () => false;

/** 命名草稿只存在于弹窗；确认才创建图层，不先创建再重命名。 */
function NewLayerDialog({ instance, requestClose, setBusy, create, initialName }: EditorDialogRendererProps & {
  initialName:string;
  create: (params: Record<string,unknown>) => string | null;
}) {
  const [name, setName] = useState(initialName);
  const [color,setColor]=useState("none");
  const [mode,setMode]=useState("Normal"),[opacity,setOpacity]=useState("100"),[clip,setClip]=useState(false),[fillNeutral,setFillNeutral]=useState(false);
  const neutral=["Darken","Multiply","Color Burn","Linear Burn","Darker Color","Divide"].includes(mode)?"白色":["Lighten","Screen","Color Dodge","Linear Dodge (Add)","Lighter Color","Difference","Exclusion","Subtract"].includes(mode)?"黑色":["Overlay","Soft Light","Hard Light","Vivid Light","Linear Light","Pin Light"].includes(mode)?"50% 灰色":null;
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  return <DialogContent size="sm" ariaLabel="新建图层" instanceId={instance.instanceId}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (composing.current) return;
      if (name.length > 200) { setError("图层名称不能超过 200 个字符"); return; }
      const amount=opacity.trim()===""?NaN:Number(opacity);
      if(!Number.isFinite(amount) || amount<0 || amount>100) {setError("不透明度须为 0–100");return;}
      const failure = create({...name.trim()?{name}:{},color,mode,opacity:amount/100,clipToPrevious:clip,fillNeutral:!!neutral && fillNeutral});
      if (failure) setError(failure);
      else requestClose();
    }} onKeyDown={(event) => {
      if ((event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) && (event.key === "Enter" || event.key === "Escape")) {
        event.preventDefault(); event.stopPropagation();
      }
    }}>
      <DialogHeader onClose={requestClose}><DialogTitle>新建图层</DialogTitle></DialogHeader>
      <DialogBody>
        <label className="photo-editor-new-layer__name">名称
          <input data-dialog-initial-focus maxLength={200} value={name} placeholder="留空自动命名"
            onFocus={event=>event.currentTarget.select()} onChange={(event) => {setName(event.currentTarget.value);setError(null);}}
            onCompositionStart={() => {composing.current = true;setBusy(true);}}
            onCompositionEnd={() => {composing.current = false;setBusy(false);}} />
        </label>
        <label className="photo-editor-new-layer__name">颜色<select value={color} onChange={event=>setColor(event.currentTarget.value)}>{IMAGE_PROJECT_LAYER_LABELS.map(label=><option key={label} value={label}>{LAYER_LABEL_NAMES[label]}</option>)}</select></label>
        <label><input type="checkbox" checked={clip} onChange={event=>setClip(event.currentTarget.checked)}/>使用前一图层创建剪贴蒙版</label>
        <label className="photo-editor-new-layer__name">模式<select value={mode} onChange={event=>setMode(event.currentTarget.value)}>{PHOTOSHOP_BLENDS.map(blend=><option key={blend} value={blend}>{BLEND_LABELS[blend]}</option>)}</select></label>
        <label className="photo-editor-new-layer__name">不透明度<ArithmeticInput invalidate  min={0} max={100} value={opacity} onChange={event=>setOpacity(event.currentTarget.value)}/>%</label>
        <label><input type="checkbox" checked={!!neutral && fillNeutral} disabled={!neutral} onChange={event=>setFillNeutral(event.currentTarget.checked)}/>填充{neutral ? `中性色（${neutral}）` : "中性色（此模式不可用）"}</label>
        {error ? <p className="dlg__error">{error}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={requestClose}>取消</Button>
        <Button type="submit" tone="primary">创建</Button>
      </DialogFooter>
    </form>
  </DialogContent>;
}

/** 使用宿主唯一弹窗栈，payload 不保存控制器或业务闭包。 */
export function useNewLayerDialog(dialogs: EditorDialogPort | undefined, controller: EditorWorkspaceController, blocked: boolean) {
  const latest = useRef({controller, blocked});
  latest.current = {controller, blocked};
  const modalActive = useSyncExternalStore(dialogs?.subscribe ?? idleSubscribe,
    dialogs ? () => dialogs.isModalActive() : noModal);
  const instanceId = useRef<string | null>(null);
  const opening = useRef(false);
  const openedOwner = useRef<ReturnType<EditorWorkspaceController["dialogOwner"]>>(null);
  useEffect(() => {
    if (!dialogs) return;
    const unregister = dialogs.registerDialog(DIALOG_ID, {
      definition: {editingOwner: () => {
        const current = latest.current;
        const command = current.controller.snapshot().commands.get("layer.new.layer");
        return opening.current && !current.blocked && current.controller === controller && command?.allowed && command.enabled
          ? controller.dialogOwner() : null;
      }, singleton:true, size:"sm", validatePayload: (payload) => payload == null ? {ok:true,payload:null} : {ok:false,error:"无效的新建图层请求"}},
      renderer: (props) => <NewLayerDialog {...props} initialName={controller.snapshot().view?.document?.nextLayerName ?? "Layer 1"} create={(params) => {
        if (dialogs.top()?.instanceId !== props.instance.instanceId || instanceId.current !== props.instance.instanceId) return "命名窗口已关闭，请重新打开";
        const {controller: current, blocked: unavailable} = latest.current;
        const owner = current.dialogOwner();
        const expected = openedOwner.current;
        if (!owner || !expected || owner.canvasId !== expected.canvasId || owner.nodeId !== expected.nodeId || owner.sessionId !== expected.sessionId)
          return "图片编辑会话已更换，请取消后重新打开";
        const command = current.snapshot().commands.get("layer.new.layer");
        if (unavailable || !command?.allowed || !command.enabled) return "当前无法创建图层，请取消后重试";
        const result = current.dispatch("layer.new.layer", params);
        return result.ok ? null : result.message;
      }} />
    });
    return () => {
      if (instanceId.current) dialogs.close(instanceId.current);
      instanceId.current = null;
      unregister();
    };
  }, [dialogs, controller]);
  useEffect(() => {
    if (blocked && instanceId.current) {dialogs?.close(instanceId.current);instanceId.current = null;}
  }, [blocked, dialogs]);
  const open = useCallback(() => {
    if (!dialogs) return "命名窗口不可用，请重新进入图片编辑";
    if (latest.current.blocked || dialogs.isModalActive()) return "请先结束当前操作";
    openedOwner.current = latest.current.controller.dialogOwner();
    opening.current = true;
    let result;
    try { result = dialogs.open({dialogId:DIALOG_ID}); }
    finally { opening.current = false; }
    if (!result.ok) return result.error;
    instanceId.current = result.instance.instanceId;
    return null;
  }, [dialogs]);
  return {open, modalActive};
}
