import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EditorDialogPort, EditorDialogRendererProps } from "../../ports.js";
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui/Dialog.js";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";

const DIALOG_ID = "image-editor.new-layer";
const idleSubscribe = () => () => {};
const noModal = () => false;

/** 命名草稿只存在于弹窗；确认才创建图层，不先创建再重命名。 */
function NewLayerDialog({ instance, requestClose, setBusy, create }: EditorDialogRendererProps & {
  create: (name: string) => string | null;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  return <DialogContent size="sm" ariaLabel="新建图层" instanceId={instance.instanceId}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (composing.current) return;
      if (name.length > 200) { setError("图层名称不能超过 200 个字符"); return; }
      const failure = create(name);
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
            onChange={(event) => {setName(event.currentTarget.value);setError(null);}}
            onCompositionStart={() => {composing.current = true;setBusy(true);}}
            onCompositionEnd={() => {composing.current = false;setBusy(false);}} />
        </label>
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
      renderer: (props) => <NewLayerDialog {...props} create={(name) => {
        if (dialogs.top()?.instanceId !== props.instance.instanceId || instanceId.current !== props.instance.instanceId) return "命名窗口已关闭，请重新打开";
        const {controller: current, blocked: unavailable} = latest.current;
        const owner = current.dialogOwner();
        const expected = openedOwner.current;
        if (!owner || !expected || owner.canvasId !== expected.canvasId || owner.nodeId !== expected.nodeId || owner.sessionId !== expected.sessionId)
          return "图片编辑会话已更换，请取消后重新打开";
        const command = current.snapshot().commands.get("layer.new.layer");
        if (unavailable || !command?.allowed || !command.enabled) return "当前无法创建图层，请取消后重试";
        const result = current.dispatch("layer.new.layer", name.trim() ? {name} : {});
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
