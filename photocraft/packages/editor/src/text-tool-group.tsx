import {useCallback,useEffect,useId,useRef,useState} from "react";
import {Button,IconButton} from "./ui/Button.js";
import {Popover} from "./ui/Popover.js";
import {Tooltip} from "./ui/Tooltip.js";
import {TypeIcon} from "./ui/icons.js";

/** 子工具由 App 持有；本组件只保存长按与弹层状态。 */
export function TextToolGroup({active,orientation="horizontal",onChoose,disabled,hidden=false,verticalDisabled=false}:{
  verticalDisabled?:boolean;active:boolean;orientation?:"horizontal"|"vertical";onChoose:(orientation:"horizontal"|"vertical")=>void;disabled:boolean;hidden?:boolean;
}) {
  const owner=useId();
  const [open,setOpen]=useState(false);
  const [anchor,setAnchor]=useState<HTMLButtonElement|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const held=useRef(false);
  const pressed=useRef<number|null>(null);
  const trigger=useRef<HTMLButtonElement|null>(null);
  const anchorRef=useCallback((element:HTMLButtonElement|null)=>{trigger.current=element;setAnchor(element);},[]);
  const choose=useRef(onChoose);choose.current=onChoose;
  const clear=()=>{if(timer.current!==null) {clearTimeout(timer.current);timer.current=null;}};
  useEffect(()=>{
    if(disabled || hidden) {clear();pressed.current=null;held.current=false;setOpen(false);}
  },[disabled,hidden]);
  useEffect(()=>{
    const blur=()=>{clear();pressed.current=null;held.current=false;setOpen(false);};
    const release=(event:PointerEvent)=>{
      if(pressed.current!==(event.pointerId ?? -1)) return;
      pressed.current=null;clear();
      if(!held.current) return;
      const target=document.elementFromPoint?.(event.clientX,event.clientY) ?? event.target;
      const item=target instanceof Element ? target.closest<HTMLButtonElement>("[data-text-orientation]") : null;
      if(item && !item.disabled && item.dataset.textToolOwner===owner) {setOpen(false);choose.current(item.dataset.textOrientation==="vertical"?"vertical":"horizontal");}
      else if(!(target instanceof Node) || !trigger.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("blur",blur);
    document.addEventListener("pointerup",release);
    document.addEventListener("pointercancel",blur);
    return ()=>{clear();window.removeEventListener("blur",blur);document.removeEventListener("pointerup",release);document.removeEventListener("pointercancel",blur);};
  },[owner]);
  useEffect(()=>{clear();pressed.current=null;held.current=false;setOpen(false);},[active,orientation]);
  const label=orientation==="vertical"?"竖排文字":"文字";
  return <>
    <Tooltip content={`${label}（T）；按住拖出、长按或右键选择`} side="right">
      <IconButton ref={anchorRef} label={label} title={`${label}（T）`} pressed={active} disabled={disabled}
        className="photo-editor__tool photo-editor__tool-group"
        onPointerDown={event=>{
          if(disabled || hidden || event.button!==0 || pressed.current!==null) return;
          clear();held.current=false;
          pressed.current=event.pointerId ?? -1;
          timer.current=setTimeout(()=>{timer.current=null;held.current=true;setOpen(true);},350);
        }}
        onPointerUp={event=>{if(pressed.current===(event.pointerId ?? -1))clear();}} onPointerLeave={event=>{if(pressed.current!==(event.pointerId ?? -1))return;clear();if(pressed.current!==null && !disabled && !hidden) {held.current=true;setOpen(true);}}}
        onPointerCancel={()=>{clear();pressed.current=null;held.current=false;setOpen(false);}}
        onContextMenu={event=>{event.preventDefault();clear();pressed.current=null;if(!disabled && !hidden) setOpen(value=>!value);}}
        onClick={()=>{clear();if(held.current) {held.current=false;return;}if(!disabled && !hidden) {onChoose(orientation);}}}>
        <TypeIcon/><span className="photo-editor__tool-group-mark"/>
      </IconButton>
    </Tooltip>
    {anchor ? <Popover anchorElement={anchor} open={open && !disabled && !hidden} onOpenChange={value=>{if(!value) {clear();pressed.current=null;}setOpen(value);}}
      autoFocus={false}
      side="right" align="start" className="photo-editor__tool-group-menu">
      {(["horizontal","vertical"] as const).map(mode=><Button key={mode} disabled={mode==="vertical" && verticalDisabled} data-text-orientation={mode} data-text-tool-owner={owner} size="sm"
        tone={mode===orientation?"neutral":"ghost"} data-selected={mode===orientation?"true":undefined} icon={<TypeIcon size={16}/>}
        onClick={()=>{clear();setOpen(false);onChoose(mode);}}>{mode==="vertical"?"竖排文字":"横排文字"}<kbd>T</kbd></Button>)}
    </Popover> : null}
  </>;
}
