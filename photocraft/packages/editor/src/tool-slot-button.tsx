/**
 * 通用工具槽位按钮（change: refactor-photocraft-toolbar，design D3）。
 *
 * 一个槽位一个按钮：槽内多成员时支持 flyout，单成员时退化为普通按钮且不弹层。
 * 手势语义与上游 `panels.rs::toolbar` 一致，本组件是**唯一**实现处：
 *
 * - 右键展开；
 * - 按住约 350ms 展开（长按期间同时选中按钮显示的成员，对应上游 #4453）；
 * - 按下后指针离开按钮矩形即展开（拖出，对应 `tool_flyout_drag_open`）；
 * - 拖出后释放在某成员上即选用它（对应 `tool_flyout_release`），释放在外部取消；
 * - 自己的 flyout 已展开时再次点击按钮（左/右键）关闭，结束长按的那次释放不算；
 * - Escape、外部按下、失焦、指针取消、只读或隐藏、卸载都清理计时器与弹层，不出现迟到弹层。
 *
 * 组件只保存弹层与手势状态；当前工具、槽内记忆与选中结果都由调用方持有。
 */
import {useCallback,useEffect,useRef,useState} from "react";
import type { ToolMember, ToolSlot } from "./toolbar-slots.js";
import { IconButton } from "./ui/Button.js";
import { Button } from "./ui/Button.js";
import { Popover } from "./ui/Popover.js";
import { Tooltip } from "./ui/Tooltip.js";
import { TOOL_KEYS } from "./photo-editor-shortcuts.js";

/** 长按展开阈值，与上游一致。 */
export const FLYOUT_HOLD_MS = 350;

export type ToolSlotButtonProps = {
  slot: ToolSlot;
  /** 该槽位当前显示/选中的成员。 */
  shown: ToolMember;
  /** 当前工具是否属于本槽位（用于高亮）。 */
  active: boolean;
  /** 选中某成员：`variant` 是子工具变体（选框行列、文字方向）。 */
  onChoose: (member: ToolMember) => void;
  /** 长按展开期间选中按钮显示的成员。 */
  onPress?: (member: ToolMember) => void;
  /** 双击（手形适合屏幕、缩放实际像素）。 */
  onDoubleClick?: (member: ToolMember) => void;
  disabled: boolean;
  hidden?: boolean;
};

export function ToolSlotButton({slot,shown,active,onChoose,onPress,onDoubleClick,disabled,hidden=false}:ToolSlotButtonProps) {
  const multi = slot.members.length > 1;
  const [open,setOpen]=useState(false);
  const [anchor,setAnchor]=useState<HTMLButtonElement|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  /** 长按或拖出打开了 flyout：结束它的那次释放不当作点击。 */
  const held=useRef(false);
  const pressed=useRef<number|null>(null);
  const trigger=useRef<HTMLButtonElement|null>(null);
  const anchorRef=useCallback((element:HTMLButtonElement|null)=>{trigger.current=element;setAnchor(element);},[]);
  const choose=useRef(onChoose);choose.current=onChoose;
  const press=useRef(onPress);press.current=onPress;
  const clear=()=>{if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}};
  const reset=()=>{clear();pressed.current=null;held.current=false;};

  useEffect(()=>{if(disabled || hidden){reset();setOpen(false);}},[disabled,hidden]);
  useEffect(()=>{
    const blur=()=>{reset();setOpen(false);};
    const release=(event:PointerEvent)=>{
      if(pressed.current!==(event.pointerId ?? -1)) return;
      pressed.current=null;clear();
      if(!held.current) return;
      const target=document.elementFromPoint?.(event.clientX,event.clientY) ?? event.target;
      // 触发按钮本身也带 `data-tool-member`：释放在它上面不是「拖出选取」。
      const item=target instanceof Element && !trigger.current?.contains(target)
        ? target.closest<HTMLButtonElement>("[data-tool-member]") : null;
      if(item && !item.disabled && item.dataset.toolSlot===String(slot.index)) {
        setOpen(false);
        const member=slot.members.find(candidate=>candidate.id===item.dataset.toolMember);
        if(member) choose.current(member);
      } else if(!(target instanceof Node) || !trigger.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("blur",blur);
    document.addEventListener("pointerup",release);
    document.addEventListener("pointercancel",blur);
    return ()=>{clear();window.removeEventListener("blur",blur);document.removeEventListener("pointerup",release);document.removeEventListener("pointercancel",blur);};
  },[]);
  // 收起弹层只在「显示的成员真的换了」时做；`active` 变化（例如刚选中本槽成员）
  // 不能复位 `held`，否则结束长按的那次点击会被当成普通点击重复选择一次。
  const shownId=useRef(shown.id);
  useEffect(()=>{
    if(shownId.current===shown.id) return;
    shownId.current=shown.id;
    reset();setOpen(false);
  },[shown.id]);

  const label = shown.label;
  const key = TOOL_KEYS[shown.tool];
  const title = key ? `${label}（${key}）` : label;
  const hint = multi ? "；按住拖出、长按或右键选择" : "";
  const Icon = shown.Icon;

  return <>
    <Tooltip content={`${title}${hint}`} side="right">
      <IconButton ref={anchorRef} label={label} title={title} pressed={active} disabled={disabled}
        className={multi ? "photo-editor__tool photo-editor__tool-group" : "photo-editor__tool"}
        data-tool-slot={slot.index} data-tool-member={shown.id}
        onPointerDown={event=>{
          if(!multi) return;
          clear();held.current=false;
          if(disabled || hidden || event.button!==0) return;
          pressed.current=event.pointerId ?? -1;
          timer.current=setTimeout(()=>{timer.current=null;held.current=true;setOpen(true);press.current?.(shown);},FLYOUT_HOLD_MS);
        }}
        onPointerUp={()=>{if(multi) clear();}}
        onPointerLeave={()=>{
          if(!multi) return;
          clear();
          if(pressed.current!==null && !disabled && !hidden){held.current=true;setOpen(true);}
        }}
        onPointerCancel={()=>{if(multi) reset();setOpen(false);}}
        onContextMenu={event=>{
          event.preventDefault();
          if(!multi) return;
          clear();pressed.current=null;
          if(!disabled && !hidden) setOpen(value=>!value);
        }}
        onClick={()=>{
          clear();
          if(held.current){held.current=false;return;}
          if(!disabled && !hidden) choose.current(shown);
        }}
        onDoubleClick={()=>{if(!disabled && !hidden) onDoubleClick?.(shown);}}>
        <Icon/>{multi?<span className="photo-editor__tool-group-mark"/>:null}
      </IconButton>
    </Tooltip>
    {multi && anchor ? <Popover anchorElement={anchor} open={open && !disabled && !hidden}
      onOpenChange={value=>{if(!value){clear();pressed.current=null;}setOpen(value);}}
      autoFocus={false} side="right" align="start" className="photo-editor__tool-group-menu">
      {slot.members.map(member=>{
        const selected=member.id===shown.id;
        const ItemIcon=member.Icon;
        const memberKey=TOOL_KEYS[member.tool];
        return <Button key={member.id} data-tool-slot={slot.index} data-tool-member={member.id}
          size="sm" tone={selected?"neutral":"ghost"} data-selected={selected?"true":undefined}
          icon={<ItemIcon size={16}/>}
          onClick={()=>{clear();setOpen(false);choose.current(member);}}>
          {member.label}{memberKey?<kbd>{memberKey}</kbd>:null}
        </Button>;
      })}
    </Popover> : null}
  </>;
}
