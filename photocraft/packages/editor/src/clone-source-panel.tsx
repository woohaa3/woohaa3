/**
 * 克隆源面板（I011 / Window › Clone Source）。
 *
 * 五个来源槽位与画布叠层设置都由固定引擎的 `cloneSource.*` 命令拥有；本组件只读取快照、
 * 编辑候选值并分派命令。所有写入都是会话预设：不改工程内容、修订或内容指纹，因此也不需要
 * 撤销历史。来源点由画布上的 Alt/Option 单击（或此处的数值来源）设置。
 */
import {useCallback,useEffect,useState} from "react";
import type {CloneSourceList,CloneSourceSlot,EditorWorkspaceController} from "./editor-workspace.js";
import {Button} from "./ui/Button.js";
import {ArithmeticInput} from "./arithmetic-input.js";

export type CloneSourcePanelProps = {
  controller: EditorWorkspaceController;
  /** 面板可见时读取快照；关闭时不发命令。 */
  visible: boolean;
  disabled: boolean;
  /** 当前文档标识：切换文档后重新读取会话预设。 */
  documentKey: string;
  /** 面板可用的能力门禁（命令未开放时不显示）。 */
  allowed: boolean;
  message: (text: string | null) => void;
};

const BLENDS: readonly (readonly [CloneSourceList["overlay"]["blend"], string])[] = [
  ["normal","正常"],["darken","变暗"],["lighten","变亮"],["difference","差值"]
];

export function CloneSourcePanel({controller,visible,disabled,documentKey,allowed,message}:CloneSourcePanelProps) {
  const [state,setState]=useState<CloneSourceList|null>(null);
  const refresh=useCallback(()=>{
    if(!visible || !allowed) return;
    const result=controller.cloneSources();
    if(result.ok) setState(result.value); else message(result.message);
  },[controller,visible,allowed,message]);
  useEffect(()=>{refresh();},[refresh,documentKey]);
  const run=(action:()=>{ok:boolean;message?:string})=>{
    if(disabled) return;
    const result=action();
    if(!result.ok) message(result.message??"克隆源更新失败");
    else message(null);
    refresh();
  };
  if(!allowed) return null;
  const active=state?.sources[state.active] ?? null;
  const number=(label:string,value:number,min:number,max:number,apply:(next:number)=>void)=>(
    <label key={label}>{label}<ArithmeticInput invalidate min={min} max={max} step="any" disabled={disabled} value={String(Math.round(value*100)/100)} onChange={event=>{const next=Number(event.currentTarget.value);if(Number.isFinite(next)&&next>=min&&next<=max)apply(next);}}/></label>
  );
  return <section className="photo-editor__panel-section" aria-label="克隆源" hidden={!visible} data-clone-source-panel="true">
    <div className="photo-editor__panel-title">克隆源</div>
    <div className="photo-editor__clone-slots" role="radiogroup" aria-label="来源槽位">
      {state?.sources.map(slot=>(
        <Button key={slot.index} size="sm" tone={slot.index===state.active?"neutral":"ghost"} data-clone-slot={slot.index}
          data-selected={slot.index===state.active?"true":undefined}
          title={slot.source?`来源 (${Math.round(slot.source[0])}, ${Math.round(slot.source[1])})`:"尚未取样"}
          disabled={disabled} onClick={()=>run(()=>controller.cloneSourceSelect(slot.index))}>{`槽 ${slot.index+1}`}</Button>
      ))}
    </div>
    {active?<>
      <p className="photo-editor__panel-hint">{active.source?`来源 ${Math.round(active.source[0])}, ${Math.round(active.source[1])}`:"在该槽位用 Alt/Option 单击画布取样来源"}</p>
      {number("宽 %",active.width,1,1000,width=>run(()=>controller.cloneSourceSet({index:active.index,width})))}
      {number("高 %",active.height,1,1000,height=>run(()=>controller.cloneSourceSet({index:active.index,height})))}
      {number("旋转",active.rotation,-180,180,rotation=>run(()=>controller.cloneSourceSet({index:active.index,rotation})))}
      <label><input type="checkbox" checked={active.linked} disabled={disabled}
        onChange={event=>run(()=>controller.cloneSourceSet({index:active.index,linked:event.currentTarget.checked}))}/>链接宽高</label>
      <label><input type="checkbox" checked={active.flipH} disabled={disabled}
        onChange={event=>run(()=>controller.cloneSourceSet({index:active.index,flipH:event.currentTarget.checked}))}/>水平翻转</label>
      <label><input type="checkbox" checked={active.flipV} disabled={disabled}
        onChange={event=>run(()=>controller.cloneSourceSet({index:active.index,flipV:event.currentTarget.checked}))}/>垂直翻转</label>
      <Button size="sm" disabled={disabled} onClick={()=>run(()=>controller.cloneSourceResetTransform(active.index))}>重置变换</Button>
      <Button size="sm" disabled={disabled} onClick={()=>run(()=>controller.cloneSourceSet({index:active.index,clear:true}))}>清除来源</Button>
    </> : null}
    <div className="photo-editor__panel-subtitle">来源叠层</div>
    {state?<>
      <label><input type="checkbox" checked={state.overlay.show} disabled={disabled}
        onChange={event=>run(()=>controller.cloneSourceOverlay({show:event.currentTarget.checked}))}/>显示叠层</label>
      {number("不透明度",state.overlay.opacity,0,100,opacity=>run(()=>controller.cloneSourceOverlay({opacity})))}
      <label>混合<select value={state.overlay.blend} disabled={disabled}
        onChange={event=>run(()=>controller.cloneSourceOverlay({blend:event.currentTarget.value}))}>
        {BLENDS.map(([id,label])=><option key={id} value={id}>{label}</option>)}
      </select></label>
      <label><input type="checkbox" checked={state.overlay.clipped} disabled={disabled}
        onChange={event=>run(()=>controller.cloneSourceOverlay({clipped:event.currentTarget.checked}))}/>剪贴到目标</label>
      <label><input type="checkbox" checked={state.overlay.autoHide} disabled={disabled}
        onChange={event=>run(()=>controller.cloneSourceOverlay({autoHide:event.currentTarget.checked}))}/>绘画时自动隐藏</label>
      <label><input type="checkbox" checked={state.overlay.invert} disabled={disabled}
        onChange={event=>run(()=>controller.cloneSourceOverlay({invert:event.currentTarget.checked}))}/>反相</label>
    </> : null}
  </section>;
}

/** 当前活动的来源槽位（供工具选项提示）。 */
export function activeCloneSource(state:CloneSourceList|null):CloneSourceSlot|null {
  return state ? state.sources[state.active] ?? null : null;
}
