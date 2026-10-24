import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {FrameEditSession} from "./frame-edit-session.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";

export type LayerVisibilityEditing={
  active:boolean;
  begin:(layer:number)=>boolean;
  preview:(layers:number[],visible:boolean)=>void;
  finish:(commit:boolean)=>boolean;
};
/** 扫动只发布候选文档；共享属性事务负责写门禁、一次确认与无历史取消。 */
export function useLayerVisibilityEditing(controller:EditorWorkspaceController,refresh:()=>void,error:(message:string|null)=>void,disabled:boolean):LayerVisibilityEditing {
  const [active,setActive]=useState(false);
  const callbacks=useRef({refresh,error});callbacks.current={refresh,error};
  const session=useMemo(()=>new FrameEditSession<{layers:number[];visible:boolean}>({
    begin:layer=>controller.beginLayerVisibility(layer),preview:params=>controller.previewLayerProperties(params),
    commit:()=>controller.commitLayerProperties(),cancel:()=>controller.cancelLayerProperties()
  },()=>callbacks.current.refresh(),message=>callbacks.current.error(message),()=>{},(_previous,next)=>next),[controller]);
  const finish=useCallback((commit:boolean)=>{
    if(!session.active) return true;
    const result=!commit || session.commit();
    if(!commit || !result) session.cancel();
    setActive(false);if(result) callbacks.current.error(null);return result;
  },[session]);
  useEffect(()=>()=>session.cancel(),[session]);
  useEffect(()=>{if(disabled) finish(false);},[disabled,finish]);
  return {active,begin:layer=>{
    if(disabled || !session.begin(layer)) return false;
    setActive(true);callbacks.current.error(null);return true;
  },preview:(layers,visible)=>session.preview({layers,visible}),finish};
}
