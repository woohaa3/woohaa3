import {useCallback,useEffect,useRef,useState} from "react";
import {Button,IconButton} from "./ui/Button.js";
import {Popover} from "./ui/Popover.js";
import {Tooltip} from "./ui/Tooltip.js";
import {MarqueeIcon,EllipseMarqueeIcon} from "./ui/icons.js";

/** 子工具由 App 持有；本组件只保存长按与弹层状态。 */
export function MarqueeToolGroup({active,ellipse,line,onChoose,disabled,hidden=false}:{
  active:boolean;ellipse:boolean;line?:"row"|"column";onChoose:(ellipse:boolean,line?:"row"|"column")=>void;disabled:boolean;hidden?:boolean;
}) {
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
      const item=target instanceof Element ? target.closest<HTMLButtonElement>("[data-marquee-kind]") : null;
      if(item && !item.disabled) {setOpen(false);const kind=item.dataset.marqueeKind;
        if(kind==="row" || kind==="column") choose.current(false,kind);else choose.current(kind==="ellipse");}
      else if(!(target instanceof Node) || !trigger.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("blur",blur);
    document.addEventListener("pointerup",release);
    document.addEventListener("pointercancel",blur);
    return ()=>{clear();window.removeEventListener("blur",blur);document.removeEventListener("pointerup",release);document.removeEventListener("pointercancel",blur);};
  },[]);
  useEffect(()=>{clear();pressed.current=null;held.current=false;setOpen(false);},[active,ellipse,line]);
  const label=line==="row"?"单行选框":line==="column"?"单列选框":ellipse?"椭圆选框":"矩形选框";
  const Icon=ellipse?EllipseMarqueeIcon:MarqueeIcon;
  return <>
    <Tooltip content={`${label}（M）；按住拖出、长按或右键选择，Shift+M 切换`} side="right">
      <IconButton ref={anchorRef} label={label} title={`${label}（M）`} pressed={active} disabled={disabled}
        className="photo-editor__tool photo-editor__tool-group"
        onPointerDown={event=>{
          clear();held.current=false;
          if(disabled || hidden || event.button!==0) return;
          pressed.current=event.pointerId ?? -1;
          timer.current=setTimeout(()=>{timer.current=null;held.current=true;setOpen(true);},350);
        }}
        onPointerUp={clear} onPointerLeave={()=>{clear();if(pressed.current!==null && !disabled && !hidden) {held.current=true;setOpen(true);}}}
        onPointerCancel={()=>{clear();pressed.current=null;held.current=false;setOpen(false);}}
        onContextMenu={event=>{event.preventDefault();clear();pressed.current=null;if(!disabled && !hidden) setOpen(value=>!value);}}
        onClick={()=>{clear();if(held.current) {held.current=false;return;}if(!disabled && !hidden) {if(line) onChoose(false,line);else onChoose(ellipse);}}}>
        <Icon/><span className="photo-editor__tool-group-mark"/>
      </IconButton>
    </Tooltip>
    {anchor ? <Popover anchorElement={anchor} open={open && !disabled && !hidden} onOpenChange={value=>{if(!value) {clear();pressed.current=null;}setOpen(value);}}
      autoFocus={false}
      side="right" align="start" className="photo-editor__tool-group-menu">
      {(["rectangle","ellipse","row","column"] as const).map(kind=>{
        const ItemIcon=kind==="ellipse"?EllipseMarqueeIcon:MarqueeIcon;
        const selected=line ? line===kind : (ellipse?"ellipse":"rectangle")===kind;
        const name=kind==="row"?"单行选框":kind==="column"?"单列选框":kind==="ellipse"?"椭圆选框":"矩形选框";
        return <Button key={kind} data-marquee-kind={kind} size="sm" tone={selected?"neutral":"ghost"} data-selected={selected?"true":undefined} icon={<ItemIcon size={16}/>}
          onClick={()=>{clear();setOpen(false);if(kind==="row" || kind==="column") onChoose(false,kind);else onChoose(kind==="ellipse");}}>{name}<kbd>M</kbd></Button>;
      })}
    </Popover> : null}
  </>;
}
