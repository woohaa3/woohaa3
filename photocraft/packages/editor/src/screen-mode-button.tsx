import {useCallback,useEffect,useRef,useState} from "react";
import {EDITOR_SCREEN_MODES,type EditorScreenMode} from "./editor-display.js";
import {IconButton,Button} from "./ui/Button.js";
import {AppsIcon} from "./ui/icons.js";
import {Popover} from "./ui/Popover.js";

export function ScreenModeButton({mode,onChange,disabled,hidden=false}:{mode:EditorScreenMode;onChange:(mode:EditorScreenMode)=>void;disabled:boolean;hidden?:boolean}) {
  const [open,setOpen]=useState(false),[anchor,setAnchor]=useState<HTMLButtonElement|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null),held=useRef(false),pointer=useRef<number|null>(null),button=useRef<HTMLButtonElement|null>(null);
  const ref=useCallback((element:HTMLButtonElement|null)=>{button.current=element;setAnchor(element);},[]);
  const clear=()=>{if(timer.current!==null)clearTimeout(timer.current);timer.current=null;};
  useEffect(()=>{if(disabled||hidden){clear();pointer.current=null;held.current=false;setOpen(false);}},[disabled,hidden]);
  useEffect(()=>{
    const cancel=()=>{clear();pointer.current=null;held.current=true;setOpen(false);};
    const release=(event:PointerEvent)=>{if(pointer.current!==event.pointerId)return;pointer.current=null;clear();if(!button.current?.contains(event.target as Node)){held.current=true;setOpen(false);}};
    window.addEventListener("blur",cancel);document.addEventListener("pointercancel",cancel);document.addEventListener("pointerup",release);
    return()=>{clear();window.removeEventListener("blur",cancel);document.removeEventListener("pointercancel",cancel);document.removeEventListener("pointerup",release);};
  },[]);
  return <>
    <IconButton ref={ref} label="切换屏幕模式（F）" title="切换屏幕模式（F）；长按或右键选择" disabled={disabled}
      onPointerDown={event=>{clear();held.current=false;if(event.button!==0||disabled||hidden)return;pointer.current=event.pointerId;timer.current=setTimeout(()=>{timer.current=null;held.current=true;setOpen(true);},350);}}
      onPointerUp={clear}
      onContextMenu={event=>{event.preventDefault();clear();pointer.current=null;held.current=true;if(!disabled&&!hidden)setOpen(true);}}
      onClick={()=>{clear();if(held.current){held.current=false;return;}if(!disabled&&!hidden){setOpen(false);onChange(EDITOR_SCREEN_MODES[(EDITOR_SCREEN_MODES.findIndex(item=>item.id===mode)+1)%3]!.id);}}}>
      <AppsIcon size={16}/><span className="photo-editor__tool-group-mark"/>
    </IconButton>
    {anchor?<Popover anchorElement={anchor} open={open&&!disabled&&!hidden} onOpenChange={setOpen} side="right" align="end" autoFocus={false} className="photo-editor__tool-group-menu">
      {EDITOR_SCREEN_MODES.map(item=><Button key={item.id} size="sm" tone={item.id===mode?"neutral":"ghost"} data-selected={item.id===mode?"true":undefined} onClick={()=>{setOpen(false);onChange(item.id);}}>{item.label}</Button>)}
    </Popover>:null}
  </>;
}
