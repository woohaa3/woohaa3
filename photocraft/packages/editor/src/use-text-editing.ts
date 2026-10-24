import {decodeTextAntialias} from "./text-antialias.js";
import {LOREM_IPSUM} from "./text-placeholder.js";
import {useToolMemory,memoryRecord,memoryNumber,memoryChoice,memoryBoolean,memoryColor} from "./tool-memory.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeEditorTextStyle, decodeTextStyleDetail, type EditorTextStyle, type EditorTextStyleDetail } from "./editor-view-model.js";
import type { EditorWorkspaceController } from "./editor-workspace.js";
import { TextSession, type TextPlacement } from "./text-session.js";
import type { TextGeometry, TextPoint, TextNavigation, TextSelectionUnit } from "./text-geometry.js";
import {paragraphBoxOf} from "./text-box-resize.js";

export type TextSelection = { start: number; end: number; direction: "forward" | "backward" | "none" };
export type TextEditing = ReturnType<typeof useTextEditing>;
const initialStyle: EditorTextStyle = {text:"",size:48,color:"#000000",font:"Noto Sans SC",bold:false,align:"left"};
const {text:_initialText,...initialTextOptions}=initialStyle;
export function decodeTextToolMemory(value:unknown):typeof initialTextOptions {
 const raw=memoryRecord(value);const detail=decodeTextStyleDetail(raw.style,raw.style);
 return {...(raw.orientation==="horizontal" || raw.orientation==="vertical"?{orientation:raw.orientation}:{}),...(decodeTextAntialias(raw.antialias)?{antialias:decodeTextAntialias(raw.antialias)}:{}),font:memoryChoice(raw.font,["Inter","Noto Sans SC"] as const,"Noto Sans SC"),size:memoryNumber(raw.size,48,1,1024),color:memoryColor(raw.color,"#000000"),bold:memoryBoolean(raw.bold,false),align:memoryChoice(raw.align,["left","center","right"] as const,"left"),...(detail?{style:detail}:{})};
}
const collapsed = (at: number): TextSelection => ({start:at,end:at,direction:"none"});
/**
 * 文字草稿参数。
 *
 * 字段与原生 `type.create`/`type.setStyle` 同名；字符/段落样式收在 `style` 子对象里，
 * 内核会把它铺平后交给原生字段校验。
 */
const params = (style: EditorTextStyle, box:[number,number,number,number]|null=null) => ({
  ...((style.orientation)?{orientation:style.orientation}:{}),...((style.antialias)?{antialias:style.antialias}:{}),
  text:style.text,font:style.font,size:style.size,color:style.color,fauxBold:style.bold,align:style.align,
  ...(style.style&&Object.keys(style.style).length?{style:style.style}:{}),...(box?{box}:{})});

/** 仅拥有活动输入和选择，不复制正式文字层或进行浏览器排版。 */
export function useTextEditing(controller: EditorWorkspaceController, refresh: () => void, error: (message: string | null) => void, fillPlaceholder:()=>boolean=()=>true,foreground:()=>string=()=>"#000000") {
  const [rememberedStyle,setRememberedStyle]=useToolMemory("text",initialTextOptions,decodeTextToolMemory,error);
  const [style, setStyle] = useState({...initialStyle,...rememberedStyle});
  const styleRef = useRef(style);
  const [paragraphBox,setParagraphBox]=useState<ReturnType<typeof paragraphBoxOf>>(null);
  const clipboardRevision=useRef(0);
  const info = useRef<Record<string, unknown> | null>(null);
  const fontPreview=useRef<{automatic:boolean}|null>(null);
  const [active, setActive] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<TextSelection>(collapsed(0));
  const selectionRef = useRef(selection);
  const [geometry, setGeometry] = useState<TextGeometry | null>(null);
  const [composing, setComposing] = useState(false);
  const compositionBase=useRef<{text:string;start:number;end:number}|null>(null);
  const [preedit,setPreedit]=useState<[number,number]|null>(null);
  const [preeditGeometry,setPreeditGeometry]=useState<TextGeometry["selection"]>([]);
  const initialHit = useRef<TextPoint | null>(null);
  const session = useMemo(() => new TextSession(controller, refresh, error, (value) => {
    info.current = value && typeof value === "object" ? value as Record<string, unknown> : null;
    setRevision((value) => value + 1);
  }), [controller, refresh, error]);
  const select = useCallback((next: TextSelection) => {
    const previous=selectionRef.current;
    if (previous.start===next.start && previous.end===next.end && previous.direction===next.direction) return;
    clipboardRevision.current++;selectionRef.current=next;setSelection(next);
  },[]);
  useEffect(() => () => session.cancel(), [session]);

  const begin = (placement: TextPlacement) => {
    if (!session.begin(placement)) return false;
    const value=info.current;
    if (!value || typeof value.text !== "string") {
      session.cancel(); error("无法读取文字草稿，请重试"); return false;
    }
    const next=value.layer===null?{...styleRef.current,...decodeEditorTextStyle(value.text,value),text:fillPlaceholder()?"Lorem Ipsum":value.text,color:foreground()}:decodeEditorTextStyle(value.text,value) ?? {...styleRef.current,text:value.text};
    clipboardRevision.current++;styleRef.current=next;setStyle(next);select(value.layer===null && next.text?{start:0,end:next.text.length,direction:"forward"}:collapsed(next.text.length));
    initialHit.current=typeof placement.x==="number" && typeof placement.y==="number" && value.layer !== null ? [placement.x,placement.y] : null;
    compositionBase.current=null;setPreedit(null);setPreeditGeometry([]);
    setGeometry(null);setActive(true);setComposing(false);error(null);
    // 段落草稿直接暴露原生框，供缩放手柄命中；点文字没有框。
    setParagraphBox(paragraphBoxOf(info.current));
    // 新点/段落文字先以空内容创建草稿，使初始光标也来自原生布局。
    if (value.layer === null) session.preview(params(next));
    return true;
  };
  const update = (patch: Partial<EditorTextStyle>, nextSelection?: TextSelection) => {
    fontPreview.current=null;
    const next={...styleRef.current,...patch};
    if(Object.keys(patch).some(key=>key!=="text")){const {text:_text,...options}=next;setRememberedStyle(options);}
    const base=compositionBase.current;
    if(base && patch.text!==undefined){const end=next.text.length-(base.text.length-base.end);setPreedit(end>=base.start?[base.start,end]:null);}
    clipboardRevision.current++;styleRef.current=next;setStyle(next);
    if (nextSelection) select(nextSelection);
    if (session.active) session.preview(params(next));
  };
  const finish = (commit: boolean) => {
    fontPreview.current=null;
    if (!session.active || (commit && !session.commit())) return false;
    if (!commit) session.cancel();
    compositionBase.current=null;setPreedit(null);setPreeditGeometry([]);
    setActive(false);setComposing(false);setGeometry(null);setParagraphBox(null);initialHit.current=null;error(null);
    return true;
  };
  /**
   * 段落框缩放：只把候选框写进原生文字草稿，排版/栅格化仍由内核完成。
   * `box` 是文档坐标的 `[x,y,width,height]`（`type.edit` 参数）；非法值在看内核前先拒绝。
   */
  const resizeBox = (box:[number,number,number,number]) => {
    fontPreview.current=null;
    if(!session.active || composing) return false;
    if(box.length!==4 || !box.every(value=>Number.isFinite(value)) || box[2]<=0 || box[3]<=0) {error("段落框尺寸必须大于零");return false;}
    const next={...styleRef.current};
    const result=controller.previewText(params(next,box));
    if(!result.ok){error(result.message);return false;}
    info.current=result.value && typeof result.value==="object" ? result.value as Record<string,unknown> : info.current;
    setParagraphBox(paragraphBoxOf(info.current));
    setRevision(value=>value+1);
    return true;
  };
  /**
   * 字符/段落样式补丁（I114/I127）。
   *
   * 只合并已开放的字段；与 `update` 一样写入同一文字草稿，正式提交仍是一次原生操作。
   * 值域由内核复核，这里只做类型收窄，避免把明显无效的值送到原生。
   */
  const updateStyle = (patch: EditorTextStyleDetail, nextSelection?: TextSelection) => {
    if (!session.active || composing) return false;
    const clean: EditorTextStyleDetail = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      (clean as Record<string, unknown>)[key] = value;
    }
    if (!Object.keys(clean).length) return false;
    update({style: { ...styleRef.current.style, ...clean }}, nextSelection);
    return true;
  };
  /** 当前字符/段落样式（供选项栏显示）。 */
  const textStyle = style.style ?? null;
  const insertLorem=()=>{    if(!session.active || composing)return false;
    const {start,end}=selectionRef.current,current=styleRef.current.text;
    const caret=start+LOREM_IPSUM.length;
    update({text:current.slice(0,start)+LOREM_IPSUM+current.slice(end)},collapsed(caret));return true;
  };
  const previewFont=(font:"Inter"|"Noto Sans SC"|null,layer?:number)=>{
    if(font===null){
      const previous=fontPreview.current;fontPreview.current=null;
      if(!previous || !session.active)return;
      if(previous.automatic){finish(false);return;}
      session.preview(params(styleRef.current));return;
    }
    if(composing)return;
    if(!fontPreview.current){
      const automatic=!session.active;
      if(automatic && (layer===undefined || !begin({layer})))return;
      fontPreview.current={automatic};
    }
    if(session.active)session.preview({...params(styleRef.current),font});
  };
  const query = useCallback((hit?: TextPoint, move?: TextNavigation,unit?:TextSelectionUnit) => {
    if (!session.active || typeof info.current?.layer !== "number" || info.current.text !== styleRef.current.text) return null;
    const current=selectionRef.current;
    const result=controller.textGeometry({start:current.direction === "backward" ? current.end : current.start,
      end:current.direction === "backward" ? current.start : current.end, ...(hit ? {hit} : {}), ...(move ? {move} : {}),...(unit?{unit}:{})});
    if (!result.ok) {error(result.message);return null;}
    return result.value;
  },[controller,error,session]);
  useEffect(() => {
    if (!active) return;
    const hit=initialHit.current;
    const result=query(hit ?? undefined);
    if (!result) return;
    if (hit && result.hit !== null) {initialHit.current=null;select(collapsed(result.hit));}
    else setGeometry(result);
  },[active,revision,selection,query,select]);

  useEffect(()=>{
    if(!active || !composing || !preedit || info.current?.text!==styleRef.current.text){setPreeditGeometry([]);return;}
    const result=controller.textGeometry({start:preedit[0],end:preedit[1]});
    setPreeditGeometry(result.ok?result.value.selection:[]);
  },[active,composing,preedit,revision,controller]);

  const hit = (point: TextPoint, extend: boolean, anchor?: number,unit?:TextSelectionUnit): number | null => {
    if (!session.synchronize()) return null;
    const result=query(point,undefined,unit);
    if (result?.hit === null || !result) return null;
    if(unit && result.range) {select({start:result.range[0],end:result.range[1],direction:"forward"});return result.range[0];}
    const current=selectionRef.current;
    const start=anchor ?? (extend ? current.direction === "backward" ? current.end : current.start : result.hit);
    select({start:Math.min(start,result.hit),end:Math.max(start,result.hit),direction:result.hit<start?"backward":"forward"});
    return start;
  };
  const navigate = (move: TextNavigation, extend: boolean) => {
    if(!extend && selectionRef.current.start!==selectionRef.current.end && (move==="charPrev" || move==="charNext")){select(collapsed(move==="charPrev"?selectionRef.current.start:selectionRef.current.end));return;}
    if (!session.synchronize()) return;
    const next=query(undefined,move)?.next;
    if (next === undefined) return;
    const current=selectionRef.current;
    const anchor=extend ? current.direction === "backward" ? current.end : current.start : next;
    select({start:Math.min(anchor,next),end:Math.max(anchor,next),direction:next<anchor?"backward":"forward"});
  };
  const clipboardSnapshot=()=>{
    if(!session.active || session.composing)return null;
    const revision=clipboardRevision.current,current=styleRef.current.text,{start,end}=selectionRef.current;
    const valid=()=>session.active && !session.composing && clipboardRevision.current===revision;
    return {text:current.slice(start,end),valid,replace:(text:string)=>{if(!valid())return false;update({text:current.slice(0,start)+text+current.slice(end)},collapsed(start+text.length));return true;}};
  };
  return {style,textStyle,active,composing,selection,geometry,preeditGeometry,paragraphBox,begin,previewFont,insertLorem,clipboardSnapshot,update,updateStyle,select,finish,hit,navigate,resizeBox,checkpoint:()=>session.checkpoint(),
    compositionStart: () => {clipboardRevision.current++;compositionBase.current={text:styleRef.current.text,start:selectionRef.current.start,end:selectionRef.current.end};setPreedit([selectionRef.current.start,selectionRef.current.end]);session.compositionStart();setComposing(true);},
    compositionEnd: () => {compositionBase.current=null;setPreedit(null);setPreeditGeometry([]);session.compositionEnd(params(styleRef.current));setComposing(false);},
    setPreference: (value: EditorTextStyle) => {if (!session.active) {styleRef.current=value;setStyle(value);}}
  };
}
