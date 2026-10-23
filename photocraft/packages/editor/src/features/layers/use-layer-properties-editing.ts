import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {MAX_USER_CONTOURS,namedContour,readContourLibrary,saveContourLibrary,validateContourLibrary,type UserContourPreset,type ContourLibraryActions} from "../../contour-preset-store.js";
import type {ContourPreset,PatternLibraryState,UserPatternPreset,StylePatternPreset} from "../../editor-wasm.js";
import {readPatternLibrarySnapshot,savePatternLibrarySnapshot} from "../../pattern-preset-store.js";
import type {EditorWorkspaceController} from "../../editor-workspace.js";
import type {EditorLayerRow} from "../../editor-view-model.js";
import {canPositionStyle,translateStyle,readStyleGradientFrame,type StyleGradientFrame,type StylePositionTarget,type StylePositionPort} from "../../style-positioning.js";
import type {DocumentPoint} from "../../photo-editor-tools.js";
import {FrameEditSession} from "../../frame-edit-session.js";

export type {StylePatternPreset} from "../../editor-wasm.js";
export type PatternLibraryActions={owner?:object;ready:boolean;presets:UserPatternPreset[];import:(bytes:Uint8Array)=>boolean;rename:(key:string,name:string)=>boolean;remove:(key:string)=>boolean;export:(key?:string)=>Uint8Array|null};
type Property = "opacity" | "fill";
const loadedPatternLibraries=new WeakSet<EditorWorkspaceController>();
export type LayerStyleData={gradientFrame?:StyleGradientFrame;style:{enabled:boolean;items:Record<string,unknown>[]};defaults:Record<string,unknown>[];globalLight:{angle:number;altitude:number};patternPresets?:StylePatternPreset[];contourSamples?:Record<string,number[]>[];contourPresets?:(ContourPreset & {id?:string})[]};
export type LayerStyleEditing={active:boolean;data:LayerStyleData|null;start:()=>void;change:(data:LayerStyleData)=>void;finish:(commit:boolean)=>boolean;importContours?:(bytes:Uint8Array)=>boolean;exportContour?:(value:unknown)=>Uint8Array|null;contourLibrary?:ContourLibraryActions;patternLibrary?:PatternLibraryActions;setPresetPickerActive?:(active:boolean)=>void;setPositionTarget?:(target:StylePositionTarget|null)=>void};
/** 两种不透明度共用一个草稿 owner，空值不转换为零。 */
export function useLayerPropertiesEditing(controller:EditorWorkspaceController,layer:EditorLayerRow|undefined,
  refresh:()=>void,error:(message:string|null)=>void,disabled:boolean) {
  const [values,setValues]=useState({opacity:"100",fill:"100"});
  const current=useRef(values),original=useRef(values),field=useRef<Property|"style">("opacity");
  const [active,setActive]=useState(false);
  const [styleActive,setStyleActive]=useState(false),[styleData,setStyleData]=useState<LayerStyleData|null>(null);
  const styleRef=useRef<LayerStyleData|null>(null),presetPicker=useRef(false);
  const [positionTarget,setPositionTarget]=useState<StylePositionTarget|null>(null);
  const targetRef=useRef<StylePositionTarget|null>(null);
  const positionDrag=useRef<{base:LayerStyleData;target:StylePositionTarget;start:DocumentPoint;strokeFrame?:StyleGradientFrame}|null>(null);
  const [initialLibrary]=useState(readContourLibrary);
  const library=useRef<UserContourPreset[]>(initialLibrary);
  const onInfo=(info:unknown)=>{
    if (!info || typeof info!=="object") return;
    const raw=info as Record<string,unknown>;
    if (!raw.style || !raw.globalLight) return;
    const data={gradientFrame:raw.styleGradientFrame===undefined?styleRef.current?.gradientFrame:readStyleGradientFrame(raw.styleGradientFrame),patternPresets:raw.patternPresets??styleRef.current?.patternPresets??[],style:raw.style,globalLight:raw.globalLight,defaults:raw.styleDefaults??styleRef.current?.defaults??[],contourSamples:raw.styleContourSamples,contourPresets:raw.contourPresets?[...raw.contourPresets as ContourPreset[],...library.current]:styleRef.current?.contourPresets??[]} as LayerStyleData;
    styleRef.current=data;setStyleData(data);
  };
  const infoRef=useRef(onInfo);infoRef.current=onInfo;
  const callbacks=useRef({refresh,error});callbacks.current={refresh,error};
  const [patternsReady,setPatternsReady]=useState(()=>typeof indexedDB==="undefined"),[userPatterns,setUserPatterns]=useState<UserPatternPreset[]>([]);
  const patternGeneration=useRef(0),mounted=useRef(false);
  const applyPatterns=(state:PatternLibraryState)=>{
    setUserPatterns(state.presets);
    if(styleRef.current && state.patternPresets) {
      const data={...styleRef.current,patternPresets:state.patternPresets};styleRef.current=data;setStyleData(data);
    }
  };
  useEffect(()=>{
    let cancelled=false;mounted.current=true;
    const cleanup=()=>{cancelled=true;mounted.current=false;patternGeneration.current++;};
    const existing=controller.patternLibrary();
    if(existing.ok && (existing.value.presets.length || loadedPatternLibraries.has(controller))) {
      applyPatterns(existing.value);loadedPatternLibraries.add(controller);setPatternsReady(true);return cleanup;
    }
    if(typeof indexedDB==="undefined") {loadedPatternLibraries.add(controller);setPatternsReady(true);return cleanup;}
    setPatternsReady(false);
    void readPatternLibrarySnapshot().then(bytes=>{
      if(cancelled || !bytes) return;
      const result=controller.restorePatternLibrary(bytes);
      if(!result.ok) {callbacks.current.error(`本机图案库读取失败：${result.message}`);return;}
      applyPatterns(result.value);
    }).catch(()=>{if(!cancelled) callbacks.current.error("无法读取本机图案库，可重新载入 PAT 文件；已有图层不受影响");})
      .finally(()=>{if(!cancelled) {loadedPatternLibraries.add(controller);setPatternsReady(true);}});
    return cleanup;
  },[controller]);
  const session=useMemo(()=>new FrameEditSession<Record<string,unknown>>({
    begin:layer=>controller.beginLayerProperties(layer),preview:params=>controller.previewLayerProperties(params),
    commit:()=>controller.commitLayerProperties(),cancel:()=>controller.cancelLayerProperties()
  },()=>callbacks.current.refresh(),message=>callbacks.current.error(message),info=>infoRef.current(info),(_previous,next)=>({...next})),[controller]);
  useEffect(()=>()=>session.cancel(),[session]);
  useEffect(()=>{
    if (session.active) return;
    const next={opacity:String(Math.round((layer?.opacity??1)*100)),fill:String(Math.round((layer?.fill??1)*100))};
    current.current=next;setValues(next);
  },[layer,session]);
  const finish=useCallback((commit:boolean)=>{
    if (!session.active) return true;
    if (commit) {
      if (positionDrag.current) {callbacks.current.error("请先结束样式拖动，再确认样式");return false;}
      if (field.current!=="style") {
      const value=current.current[field.current];
      const number=value.trim()===""?NaN:Number(value);
      if (!Number.isFinite(number) || number<0 || number>100) {callbacks.current.error("不透明度和填充须为 0–100，请修改或取消");return false;}
      }
      if (!session.commit()) return false;
    } else {
      positionDrag.current=null;session.cancel();current.current=original.current;setValues(original.current);
    }
    positionDrag.current=null;targetRef.current=null;setPositionTarget(null);
    presetPicker.current=false;setActive(false);setStyleActive(false);callbacks.current.error(null);return true;
  },[session]);
  const updateProperty=(property:Property,next:string)=>{
    if (disabled || !layer) return;
    if (session.active && field.current!==property && !finish(true)) return;
    if (!session.active) {
      if (!session.begin(layer.id)) return;
      original.current=current.current;field.current=property;setActive(true);error(null);
    }
    current.current={...current.current,[property]:next};setValues(current.current);
    session.preview({[property]:next.trim()===""?NaN:Number(next)/100});
  };
  useEffect(()=>{if (disabled) finish(false);},[disabled,finish]);
  const startStyle=()=>{
    if(disabled || !layer || session.active) return;
    styleRef.current=null;
    if(!session.begin(layer.id)) return;
    if(!styleRef.current) {session.cancel();error("无法读取样式参数，请重新加载编辑器");return;}
    original.current=current.current;field.current="style";setActive(true);setStyleActive(true);error(null);
  };
  const changeStyle=(data:LayerStyleData)=>{
    positionDrag.current=null;
    if(!session.active || field.current!=="style" || disabled) return;
    styleRef.current=data;setStyleData(data);session.preview({style:data.style,globalLight:data.globalLight});
  };
  const cancelPosition=useCallback(()=>{
    const drag=positionDrag.current;positionDrag.current=null;
    if(!drag || !session.active) return;
    const data={...(styleRef.current??drag.base),style:drag.base.style,globalLight:drag.base.globalLight};
    styleRef.current=data;setStyleData(data);
    session.preview({style:data.style,globalLight:data.globalLight});
  },[session]);
  const selectPositionTarget=useCallback((target:StylePositionTarget|null)=>{
    const previous=targetRef.current;
    if(previous?.key===target?.key && previous?.index===target?.index && previous?.kind===target?.kind) return;
    cancelPosition();targetRef.current=target;setPositionTarget(target);
  },[cancelPosition]);
  const previewPosition=(point:DocumentPoint)=>{
    const drag=positionDrag.current;
    if(!drag || !session.active || disabled) return false;
    const translated=translateStyle(drag.base,drag.target,drag.start,point,drag.strokeFrame);
    if(!translated) {error("偏移超出允许范围，请缩短拖动距离或取消");return false;}
    const data={...(styleRef.current??drag.base),style:translated.style,globalLight:translated.globalLight};
    error(null);styleRef.current=data;setStyleData(data);session.preview({style:data.style,globalLight:data.globalLight});return true;
  };
  const positioning:StylePositionPort|undefined=styleActive && !disabled && positionTarget && styleData && canPositionStyle(styleData,positionTarget)?{
    key:positionTarget.key,
    start:point=>{
      if(!session.active || positionDrag.current || !session.flushPreview() || !styleRef.current) return false;
      if(!canPositionStyle(styleRef.current,positionTarget)) return false;
      let strokeFrame:StyleGradientFrame|undefined;
      if(positionTarget.kind==="Stroke") {
        const result=controller.stylePositionFrame(positionTarget.index);
        if(!result.ok) {error(result.message);return false;}
        strokeFrame=result.value;
      }
      positionDrag.current={base:structuredClone(styleRef.current),target:positionTarget,start:point,strokeFrame};return true;
    },
    preview:previewPosition,
    end:point=>{if(!previewPosition(point)) cancelPosition();else positionDrag.current=null;},
    cancel:cancelPosition
  }:undefined;
  const updateLibrary=(next:UserContourPreset[])=>{
    if(!session.active || field.current!=="style" || disabled || !styleRef.current) return false;
    cancelPosition();
    if(!validateContourLibrary(next)) {error(`预设库最多 ${MAX_USER_CONTOURS} 条，名称须为 1–200 字，曲线须有效且总大小不超过 1 MiB`);return false;}
    library.current=next;
    const data={...styleRef.current,contourPresets:[...(styleRef.current.contourPresets??[]).filter(preset=>!preset.id),...next]};
    styleRef.current=data;setStyleData(data);
    error(saveContourLibrary(next)?null:"浏览器未能保存预设库，当前编辑器仍可使用；重新加载后可能丢失");return true;
  };
  const createContour=(name:string,contour:unknown)=>{
    const trimmed=name.trim();
    return updateLibrary([...library.current,{id:crypto.randomUUID(),name:trimmed,contour:namedContour(contour,trimmed)}]);
  };
  const renameContour=(id:string,name:string)=>{
    if(!library.current.some(preset=>preset.id===id)) return false;
    const trimmed=name.trim();
    return updateLibrary(library.current.map(preset=>preset.id===id?{...preset,name:trimmed,contour:namedContour(preset.contour,trimmed)}:preset));
  };
  const removeContour=(id:string)=>{
    if(!library.current.some(preset=>preset.id===id)) return false;
    return updateLibrary(library.current.filter(preset=>preset.id!==id));
  };
  const importContours=(bytes:Uint8Array)=>{
    if(!session.active || field.current!=="style" || disabled || !styleRef.current) return false;
    const result=controller.importContourPresets(bytes);
    if(!result.ok) {error(result.message);return false;}
    return updateLibrary([...library.current,...result.value.map(preset=>({...preset,id:crypto.randomUUID()}))]);
  };
  const exportContour=(value:unknown)=>{
    if(!session.active || field.current!=="style" || disabled) return null;
    const result=controller.exportContourPreset(value);if(!result.ok) {error(result.message);return null;}error(null);return result.value;
  };
  const managePatterns=(action:()=>ReturnType<EditorWorkspaceController["patternLibrary"]>)=>{
    if(!session.active || field.current!=="style" || disabled || !patternsReady) return false;
    cancelPosition();
    if(!session.flushPreview()) return false;
    const result=action();if(!result.ok) {error(result.message);return false;}
    applyPatterns(result.value);error(null);
    const snapshot=controller.patternLibrarySnapshot();
    const token=++patternGeneration.current;
    const warn=()=>{if(mounted.current && token===patternGeneration.current) callbacks.current.error("浏览器未能保存图案库，当前编辑器仍可使用；请保存 PAT 文件以保留图案");};
    if(!snapshot.ok) warn();
    else void savePatternLibrarySnapshot(snapshot.value).catch(warn);
    return true;
  };
  const patternLibrary:PatternLibraryActions={owner:controller,ready:patternsReady,presets:userPatterns,
    import:bytes=>managePatterns(()=>controller.importPatternPresets(bytes)),
    rename:(key,name)=>managePatterns(()=>controller.renamePatternPreset(key,name)),
    remove:key=>managePatterns(()=>controller.deletePatternPreset(key)),
    export:key=>{
      if(!session.active || field.current!=="style" || disabled || !patternsReady) return null;
      const result=controller.exportPatternPresets(key);if(!result.ok) {error(result.message);return null;}error(null);return result.value;
    }};
  return {value:values.opacity,fillValue:values.fill,active,styleActive,positioning,
    styleEditing:{active:styleActive,data:styleData,start:startStyle,change:changeStyle,finish,importContours,exportContour,contourLibrary:{create:createContour,rename:renameContour,remove:removeContour},patternLibrary,setPositionTarget:selectPositionTarget,setPresetPickerActive:(active:boolean)=>{presetPicker.current=active;}},
    presetPickerActive:()=>presetPicker.current,
    update:(next:string)=>updateProperty("opacity",next),updateFill:(next:string)=>updateProperty("fill",next),finish};
}
