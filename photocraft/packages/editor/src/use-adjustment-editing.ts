import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import type {EditorLayerRow} from "./editor-view-model.js";
import {AdjustmentSession,type AdjustmentPatch} from "./adjustment-session.js";
import {validCurve,type CurvePoint} from "./rgb-curve-editor.js";

export type AdjustmentKind = "brightnessContrast" | "hueSaturation" | "curves";
type Values = {brightness:number;contrast:number;hue:number;saturation:number;lightness:number;points:CurvePoint[]};
const defaults:Values={brightness:0,contrast:0,hue:0,saturation:0,lightness:0,points:[[0,0],[128,128],[255,255]]};

/** 只保存输入偏好；正式图层与历史仍由内核管理。 */
export function useAdjustmentEditing(controller:EditorWorkspaceController, layer:EditorLayerRow|undefined,
  refresh:()=>void,error:(message:string|null)=>void,disabled=false) {
  const [values,setValues]=useState(defaults);
  const current=useRef(values);
  const original=useRef<Values|null>(null);
  const [active,setActive]=useState(false);
  const [cancelRevision,setCancelRevision]=useState(0);
  const callbacks=useRef({refresh,error});callbacks.current={refresh,error};
  const session=useMemo(()=>new AdjustmentSession(controller,()=>callbacks.current.refresh(),message=>callbacks.current.error(message),()=>{}),[controller]);
  const replace=useCallback((next:Values)=>{current.current=next;setValues(next);},[]);
  useEffect(()=>()=>session.cancel(),[session]);
  useEffect(()=>{
    if (session.active || !layer?.adjustmentParams) return;
    const params=layer.adjustmentParams;
    const next={...current.current};
    for (const key of ["brightness","contrast","hue","saturation","lightness"] as const) {
      if (typeof params[key]==="number") next[key]=params[key] as number;
    }
    if (Array.isArray(params.points) && params.points.every(p=>Array.isArray(p) && p.length===2) && validCurve(params.points as CurvePoint[])) next.points=params.points as CurvePoint[];
    replace(next);
  },[layer,session]);

  const samples=useMemo(()=>{
    if (!validCurve(values.points) || typeof controller.curveGeometry!=="function") return [];
    const result=controller.curveGeometry(values.points);
    return result.ok ? result.value : [];
  },[controller,values.points]);

  const update=(kind:AdjustmentKind,patch:AdjustmentPatch)=>{
    if (layer?.adjustment===kind && !session.active) {
      if (!session.begin(layer.id)) return;
      original.current=current.current;setActive(true);error(null);
    }
    // 活动会话不能被其他类型的参数插入。
    if (session.active && layer?.adjustment!==kind) return;
    replace({...current.current,...patch});
    if (session.active) session.preview(patch);
  };
  const finish=useCallback((commit:boolean):boolean=>{
    if (!session.active) return true;
    if (commit && !session.commit()) return false;
    if (!commit) {
      session.cancel();
      if (original.current) replace(original.current);
      setCancelRevision(value=>value+1);
    }
    original.current=null;setActive(false);callbacks.current.error(null);return true;
  },[session,replace]);
  useEffect(()=>{if (disabled) finish(false);},[disabled,finish]);
  return {values,samples,active,update,finish,cancelRevision};
}
