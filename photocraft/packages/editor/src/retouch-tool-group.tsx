import {useCallback,useEffect,useRef,useState} from "react";
import {Button,IconButton} from "./ui/Button.js";
import {Popover} from "./ui/Popover.js";
import {Tooltip} from "./ui/Tooltip.js";
import {WandSparklesIcon} from "./ui/icons.js";
import {RETOUCH_SPECS,type RetouchToolId} from "./retouch-tools.js";

const ORDER: RetouchToolId[] = ["cloneStamp","healingBrush","colorReplacement","mixer","patternStamp","historyBrush","dodge","burn","sponge","blur","sharpen","smudge","spotHealing","redEye","magicEraser","backgroundEraser"];

/** 润饰工具组：短按沿用当前子工具，长按/拖出/右键选择；本组件只保存弹层状态。 */
export function RetouchToolGroup({active,tool,onChoose,disabled,hidden=false}:{
  active:boolean;tool:RetouchToolId;onChoose:(tool:RetouchToolId)=>void;disabled:boolean;hidden?:boolean;
}) {
  const [open,setOpen]=useState(false);
  const [anchor,setAnchor]=useState<HTMLButtonElement|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const held=useRef(false);
  const pressed=useRef<number|null>(null);
  const trigger=useRef<HTMLButtonElement|null>(null);
  const anchorRef=useCallback((element:HTMLButtonElement|null)=>{trigger.current=element;setAnchor(element);},[]);
  const choose=useRef(onChoose);choose.current=onChoose;
  const clear=()=>{if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}};
  useEffect(()=>{if(disabled || hidden){clear();pressed.current=null;held.current=false;setOpen(false);}},[disabled,hidden]);
  useEffect(()=>{
    const blur=()=>{clear();pressed.current=null;held.current=false;setOpen(false);};
    const release=(event:PointerEvent)=>{
      if(pressed.current!==(event.pointerId ?? -1))return;
      pressed.current=null;clear();
      if(!held.current)return;
      const target=document.elementFromPoint?.(event.clientX,event.clientY)??event.target;
      const item=target instanceof Element?target.closest<HTMLButtonElement>("[data-retouch-tool]"):null;
      if(item && !item.disabled){setOpen(false);choose.current(item.dataset.retouchTool as RetouchToolId);}
      else if(!(target instanceof Node) || !trigger.current?.contains(target))setOpen(false);
    };
    window.addEventListener("blur",blur);
    document.addEventListener("pointerup",release);
    document.addEventListener("pointercancel",blur);
    return ()=>{clear();window.removeEventListener("blur",blur);document.removeEventListener("pointerup",release);document.removeEventListener("pointercancel",blur);};
  },[]);
  useEffect(()=>{clear();pressed.current=null;held.current=false;setOpen(false);},[active,tool]);
  const label=RETOUCH_SPECS[tool]?.label??"润饰";
  return <>
    <Tooltip content={`${label}；按住拖出、长按或右键选择润饰工具`} side="right">
      <IconButton ref={anchorRef} label="润饰" title={label} pressed={active} disabled={disabled}
        className="photo-editor__tool photo-editor__tool-group" data-retouch-tool={tool}
        onPointerDown={event=>{
          clear();held.current=false;
          if(disabled || hidden || event.button!==0)return;
          pressed.current=event.pointerId??-1;
          timer.current=setTimeout(()=>{timer.current=null;held.current=true;setOpen(true);},350);
        }}
        onPointerUp={clear} onPointerLeave={()=>{clear();if(pressed.current!==null && !disabled && !hidden){held.current=true;setOpen(true);}}}
        onPointerCancel={()=>{clear();pressed.current=null;held.current=false;setOpen(false);}}
        onContextMenu={event=>{event.preventDefault();clear();pressed.current=null;if(!disabled && !hidden)setOpen(value=>!value);}}
        onClick={()=>{clear();if(held.current){held.current=false;return;}if(!disabled && !hidden)onChoose(tool);}}>
        <WandSparklesIcon/><span className="photo-editor__tool-group-mark"/>
      </IconButton>
    </Tooltip>
    {anchor?<Popover anchorElement={anchor} open={open && !disabled && !hidden} onOpenChange={value=>{if(!value){clear();pressed.current=null;}setOpen(value);}}
      autoFocus={false} side="right" align="start" className="photo-editor__tool-group-menu">
      {ORDER.map(id=>{const spec=RETOUCH_SPECS[id],selected=id===tool;
        return <Button key={id} data-retouch-tool={id} size="sm" tone={selected?"neutral":"ghost"} data-selected={selected?"true":undefined}
          onClick={()=>{clear();setOpen(false);onChoose(id);}}>{spec.label}</Button>;})}
    </Popover>:null}
  </>;
}
