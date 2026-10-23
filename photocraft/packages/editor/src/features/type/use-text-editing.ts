import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeEditorTextStyle, type EditorTextStyle } from "../../editor-view-model.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { TextSession, type TextPlacement } from "../../text-session.js";
import type { TextGeometry, TextPoint, TextNavigation } from "../../text-geometry.js";

export type TextSelection = { start: number; end: number; direction: "forward" | "backward" | "none" };
export type TextEditing = ReturnType<typeof useTextEditing>;
const initialStyle: EditorTextStyle = {text:"",size:48,color:"#000000",font:"Noto Sans SC",bold:false,align:"left"};
const collapsed = (at: number): TextSelection => ({start:at,end:at,direction:"none"});
const params = (style: EditorTextStyle) => ({text:style.text,font:style.font,size:style.size,color:style.color,fauxBold:style.bold,align:style.align});

/** 仅拥有活动输入和选择，不复制正式文字层或进行浏览器排版。 */
export function useTextEditing(controller: EditorWorkspaceController, refresh: () => void, error: (message: string | null) => void) {
  const [style, setStyle] = useState(initialStyle);
  const styleRef = useRef(style);
  const info = useRef<Record<string, unknown> | null>(null);
  const [active, setActive] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<TextSelection>(collapsed(0));
  const selectionRef = useRef(selection);
  const [geometry, setGeometry] = useState<TextGeometry | null>(null);
  const [composing, setComposing] = useState(false);
  const initialHit = useRef<TextPoint | null>(null);
  const session = useMemo(() => new TextSession(controller, refresh, error, (value) => {
    info.current = value && typeof value === "object" ? value as Record<string, unknown> : null;
    setRevision((value) => value + 1);
  }), [controller, refresh, error]);
  const select = useCallback((next: TextSelection) => {
    const previous=selectionRef.current;
    if (previous.start===next.start && previous.end===next.end && previous.direction===next.direction) return;
    selectionRef.current=next;setSelection(next);
  },[]);
  useEffect(() => () => session.cancel(), [session]);

  const begin = (placement: TextPlacement) => {
    if (!session.begin(placement)) return false;
    const value=info.current;
    if (!value || typeof value.text !== "string") {
      session.cancel(); error("无法读取文字草稿，请重试"); return false;
    }
    const next=decodeEditorTextStyle(value.text,value) ?? {...styleRef.current,text:value.text};
    styleRef.current=next;setStyle(next);select(collapsed(next.text.length));
    initialHit.current="x" in placement && value.layer !== null ? [placement.x,placement.y] : null;
    setGeometry(null);setActive(true);setComposing(false);error(null);
    // 新点/段落文字先以空内容创建草稿，使初始光标也来自原生布局。
    if (value.layer === null) session.preview(params(next));
    return true;
  };
  const update = (patch: Partial<EditorTextStyle>, nextSelection?: TextSelection) => {
    const next={...styleRef.current,...patch};
    styleRef.current=next;setStyle(next);
    if (nextSelection) select(nextSelection);
    if (session.active) session.preview(params(next));
  };
  const finish = (commit: boolean) => {
    if (!session.active || (commit && !session.commit())) return false;
    if (!commit) session.cancel();
    setActive(false);setComposing(false);setGeometry(null);initialHit.current=null;error(null);
    return true;
  };
  const query = useCallback((hit?: TextPoint, move?: TextNavigation) => {
    if (!session.active || typeof info.current?.layer !== "number" || info.current.text !== styleRef.current.text) return null;
    const current=selectionRef.current;
    const result=controller.textGeometry({start:current.direction === "backward" ? current.end : current.start,
      end:current.direction === "backward" ? current.start : current.end, ...(hit ? {hit} : {}), ...(move ? {move} : {})});
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

  const hit = (point: TextPoint, extend: boolean, anchor?: number): number | null => {
    if (!session.synchronize()) return null;
    const result=query(point);
    if (result?.hit === null || !result) return null;
    const current=selectionRef.current;
    const start=anchor ?? (extend ? current.direction === "backward" ? current.end : current.start : result.hit);
    select({start:Math.min(start,result.hit),end:Math.max(start,result.hit),direction:result.hit<start?"backward":"forward"});
    return start;
  };
  const navigate = (move: TextNavigation, extend: boolean) => {
    if (!session.synchronize()) return;
    const next=query(undefined,move)?.next;
    if (next === undefined) return;
    const current=selectionRef.current;
    const anchor=extend ? current.direction === "backward" ? current.end : current.start : next;
    select({start:Math.min(anchor,next),end:Math.max(anchor,next),direction:next<anchor?"backward":"forward"});
  };
  return {style,active,composing,selection,geometry,begin,update,select,finish,hit,navigate,
    compositionStart: () => {session.compositionStart();setComposing(true);},
    compositionEnd: () => {session.compositionEnd(params(styleRef.current));setComposing(false);},
    setPreference: (value: EditorTextStyle) => {if (!session.active) {styleRef.current=value;setStyle(value);}}
  };
}
