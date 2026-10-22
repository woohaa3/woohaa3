import {useEffect,useRef,useState} from "react";
import {Button,IconButton} from "./ui/Button.js";
import {Popover} from "./ui/Popover.js";
import {Tooltip} from "./ui/Tooltip.js";
import {MarqueeIcon,EllipseMarqueeIcon} from "./ui/icons.js";

/** 子工具由 App 持有；本组件只保存长按与弹层状态。 */
export function MarqueeToolGroup({active,ellipse,onChoose,disabled,hidden=false}:{
  active:boolean;ellipse:boolean;onChoose:(ellipse:boolean)=>void;disabled:boolean;hidden?:boolean;
}) {
  const [open,setOpen]=useState(false);
  const [anchor,setAnchor]=useState<HTMLButtonElement|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const held=useRef(false);
  const clear=()=>{if(timer.current!==null) {clearTimeout(timer.current);timer.current=null;}};
  useEffect(()=>{
    if(disabled || hidden) {clear();held.current=false;setOpen(false);}
  },[disabled,hidden]);
  useEffect(()=>{
    const blur=()=>{clear();held.current=false;setOpen(false);};
    window.addEventListener("blur",blur);
    return ()=>{clear();window.removeEventListener("blur",blur);};
  },[]);
  useEffect(()=>{clear();held.current=false;setOpen(false);},[active,ellipse]);
  const label=ellipse?"椭圆选框":"矩形选框";
  const Icon=ellipse?EllipseMarqueeIcon:MarqueeIcon;
  return <>
    <Tooltip content={`${label}（M）；长按或右键选择，Shift+M 切换`} side="right">
      <IconButton ref={setAnchor} label={label} title={`${label}（M）`} pressed={active} disabled={disabled}
        className="photo-editor__tool photo-editor__tool-group"
        onPointerDown={event=>{
          clear();held.current=false;
          if(disabled || hidden || event.button!==0) return;
          timer.current=setTimeout(()=>{timer.current=null;held.current=true;setOpen(true);},350);
        }}
        onPointerUp={clear} onPointerLeave={clear}
        onPointerCancel={()=>{clear();held.current=false;setOpen(false);}}
        onContextMenu={event=>{event.preventDefault();clear();if(!disabled && !hidden) setOpen(true);}}
        onClick={()=>{clear();if(held.current) {held.current=false;return;}if(!disabled && !hidden) onChoose(ellipse);}}>
        <Icon/><span className="photo-editor__tool-group-mark"/>
      </IconButton>
    </Tooltip>
    {anchor ? <Popover anchorElement={anchor} open={open && !disabled && !hidden} onOpenChange={setOpen}
      side="right" align="start" className="photo-editor__tool-group-menu">
      {[false,true].map(value=>{
        const ItemIcon=value?EllipseMarqueeIcon:MarqueeIcon;
        return <Button key={String(value)} size="sm" tone={ellipse===value?"neutral":"ghost"} data-selected={ellipse===value?"true":undefined} icon={<ItemIcon size={16}/>}
          onClick={()=>{clear();setOpen(false);onChoose(value);}}>{value?"椭圆选框":"矩形选框"}<kbd>M</kbd></Button>;
      })}
    </Popover> : null}
  </>;
}
