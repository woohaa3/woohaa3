/**
 * Menu primitives（Dropdown + cursor-anchored context menu）
 * （change: adopt-radix-lucide-canvas-ui，任务 2.3 / design D3）。
 *
 * - `DropdownMenu`：普通 trigger 模式，封装 Radix DropdownMenu 的 portal/class 契约；
 * - `CursorMenu`：Canvas cursor anchor 模式。内部把现有 `x/y` 变成固定 `Anchor`，
 *   碰撞与 viewport 边距交给 Radix positioning，不再手写翻转/全局 listener；
 *   Navigation 仍拥有 menu route 与 close intent（`open`/`onOpenChange` 受控）。
 *
 * 方向键、Home/End、Enter/Space、Escape、disabled item、单次 select 都由 Radix 菜单语义
 * 提供；本层只统一 class 与 portal container。
 */
import {createContext,useContext,useEffect,useId,useMemo,useRef,useState,type ReactNode} from "react";
import {MenuScroll} from "./menu-scroll.js";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { usePortalContainer } from "./UiProvider.js";
import { ChevronRightIcon } from "./icons.js";
import {AltTap,menuMnemonic,moveMenuFocus,resolveMenuBarKey} from "./menu-keyboard.js";

type MenuBarState={owner:string;active:string|null;setOpen:(id:string,open:boolean)=>void;enter:(id:string)=>void;hasOpenMenu:()=>boolean};
const MenuBarContext=createContext<MenuBarState|null>(null);

/**
 * Menu titles share one open menu and one mouse press across portal levels.
 *
 * 键盘（I037）：Alt 点按或 F10 把焦点放到菜单栏，左右键切换顶级项，向下/Enter/Space 打开，
 * Esc/点击离开，Alt+字母直达对应菜单。展开后的项内导航仍由 Radix 提供。
 */
export function MenuBar({children,className}:{children:ReactNode;className?:string}){
  const owner=useId();
  const [active,setActive]=useState<string|null>(null),press=useRef<number|null>(null),element=useRef<HTMLDivElement>(null),current=useRef(active);current.current=active;
  /** 键盘停在菜单栏时的顶级项下标；null 表示键盘不在菜单栏。 */
  const [focusIndex,setFocusIndex]=useState<number|null>(null);
  const focusRef=useRef(focusIndex);focusRef.current=focusIndex;
  const altTap=useRef(new AltTap());
  const titles=()=>[...(element.current?.querySelectorAll<HTMLButtonElement>("[data-menu-title]") ?? [])].filter(button=>!button.disabled);
  const focusTitle=(index:number)=>{
    const buttons=titles();if(!buttons.length){setFocusIndex(null);return;}
    // 夹紧到有效范围：聚焦入口不推进下标，只有左右键才移动（移动前已做循环计算）。
    const next=Math.min(Math.max(index,0),buttons.length-1);
    setFocusIndex(next);buttons[next]?.focus({preventScroll:true});
  };
  /**
   * 由键盘打开某个顶级菜单。
   *
   * Radix 的 trigger 在真实指针按下时展开；这里补一对按下/松开，等价于用户点开该标题，
   * 而不是依赖 `click()`（Radix 不监听 click 展开）。
   */
  const openTitle=(index:number)=>{
    const buttons=titles(),button=buttons[index];
    if(!button)return;
    focusTitle(index);
    for(const type of ["pointerdown","pointerup"]){
      button.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==="pointerdown"?1:0}));
    }
  };
  useEffect(()=>{
    const clear=()=>{press.current=null;};
    const release=(event:PointerEvent)=>{
      if(press.current!==event.pointerId)return;clear();
      const target=event.target instanceof Element?event.target:null;
      if(target?.closest("[data-menu-title]")?.closest("[data-menu-bar]")===element.current)return;
      if(target?.closest('[role="menuitem"]:not([data-disabled]),[role="menuitemradio"]:not([data-disabled])'))return;
      setActive(null);
    };
    const cancel=()=>{clear();setActive(null);setFocusIndex(null);};altTap.current.reset();
    const hide=()=>{if(document.hidden)cancel();};
    document.addEventListener("pointerup",release,true);document.addEventListener("pointercancel",cancel,true);window.addEventListener("blur",cancel);document.addEventListener("visibilitychange",hide);
    return()=>{clear();document.removeEventListener("pointerup",release,true);document.removeEventListener("pointercancel",cancel,true);window.removeEventListener("blur",cancel);document.removeEventListener("visibilitychange",hide);};
  },[]);
  useEffect(()=>{
    const keydown=(event:KeyboardEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      // 输入控件里的 Alt/方向键属于该字段，不抢菜单栏。
      if(target?.closest("input,textarea,select,[contenteditable=true]"))return;
      altTap.current.keydown(event);
      // 只有本层把键盘放到菜单栏（Alt 点按/F10）后才接管方向键与 Enter；Tab 到标题时
      // Radix trigger 自己的键盘语义保持不变。
      const action=resolveMenuBarKey(event,focusRef.current!==null,current.current!==null);
      if(action.kind==="ignore")return;
      if(action.kind==="focus"){event.preventDefault();focusTitle(action.index);return;}
      if(action.kind==="leave"){event.preventDefault();setFocusIndex(null);setActive(null);return;}
      if(action.kind==="move"){
        event.preventDefault();
        const index=focusRef.current??-1,buttons=titles();
        focusTitle(index<0?(action.delta>0?0:buttons.length-1):moveMenuFocus(index,buttons.length,action.delta));
        return;
      }
      if(action.kind==="open"){
        event.preventDefault();
        const index=focusRef.current;if(index===null)return;
        openTitle(index);return;
      }
      if(action.kind==="mnemonic"){
        const buttons=titles(),index=buttons.findIndex(button=>button.dataset.menuMnemonic===action.letter);
        if(index<0)return;
        event.preventDefault();openTitle(index);return;
      }
    };
    const keyup=(event:KeyboardEvent)=>{
      const tapped=altTap.current.keyup(event);
      if(event.key==="Alt" && tapped && !current.current && !(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true]"))){event.preventDefault();focusTitle(0);}
    };
    document.addEventListener("keydown",keydown,true);document.addEventListener("keyup",keyup,true);
    return()=>{document.removeEventListener("keydown",keydown,true);document.removeEventListener("keyup",keyup,true);};
  },[]);
  const group=useMemo<MenuBarState>(()=>({owner,active,hasOpenMenu:()=>current.current!==null,setOpen:(id,open)=>{if(!open && current.current===id)press.current=null;setActive(current=>open?id:current===id?null:current);},enter:id=>{if(press.current!==null)setActive(id);}}),[active,owner]);
  return <MenuBarContext.Provider value={group}><div ref={element} className={className} data-menu-bar={owner} onPointerDownCapture={event=>{
    if(event.button!==0 || !(event.target instanceof Element))return;
    const title=event.target.closest<HTMLButtonElement>("[data-menu-title]");if(title && !title.disabled)press.current=event.pointerId;
    setFocusIndex(null);
  }}>{children}</div></MenuBarContext.Provider>;
}

export type MenuItem = {
  id: string;
  label: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  /** 禁用原因（桌面悬停提示/诊断；不构成无障碍契约）。 */
  reason?: string;
  /** 选中态（radio/checked 语义）。 */
  selected?: boolean;
  children?: readonly MenuItem[];
  onHover?: (hovered:boolean) => void;
  onSelect: (id: string,modifiers?:{altKey:boolean}) => void;
};

/** 单个菜单项（普通 Dropdown 模式）。 */
export function MenuEntry(props: { item: MenuItem; itemClassName?: string; separatorClassName?: string }) {
  const { item } = props;
  const group=useContext(MenuBarContext);
  const alt=useRef(false);
  const container = usePortalContainer();
  return (
    <>
      {item.separatorBefore ? (
        <DropdownMenuPrimitive.Separator
          className={["ui-menu__separator", props.separatorClassName].filter(Boolean).join(" ")}
        />
      ) : null}
      {item.children ? <DropdownMenuPrimitive.Sub>
        <DropdownMenuPrimitive.SubTrigger className="ui-menu__item ui-menu__submenu-trigger" disabled={item.disabled}>
          {item.label}<ChevronRightIcon size={12} />
        </DropdownMenuPrimitive.SubTrigger>
        <DropdownMenuPrimitive.Portal container={container ?? undefined}>
          <DropdownMenuPrimitive.SubContent data-menu-bar-owner={group?.owner} className="ui-menu" sideOffset={4} collisionPadding={8}>
            <MenuScroll>{item.children.map(child => <MenuEntry key={child.id} item={child} itemClassName={props.itemClassName} separatorClassName={props.separatorClassName} />)}</MenuScroll>
          </DropdownMenuPrimitive.SubContent>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Sub> : <DropdownMenuPrimitive.Item
        className={["ui-menu__item", item.danger ? "ui-menu__item--danger" : "", props.itemClassName]
          .filter(Boolean)
          .join(" ")}
        disabled={item.disabled}
        data-selected={item.selected ? "true" : undefined}
        // 禁用原因只做桌面悬停提示/诊断，不新增 role/label 契约。
        {...(item.reason !== undefined ? { title: item.reason } : {})}
        onPointerDown={event=>{alt.current=event.altKey;}}
        onPointerMove={event=>{alt.current=event.altKey;if(!item.disabled)item.onHover?.(true);}}
        onPointerLeave={()=>item.onHover?.(false)}
        onPointerUp={event=>{alt.current=event.altKey;}}
        onKeyDown={event=>{alt.current=event.altKey;}}
        onSelect={() => item.onSelect(item.id,{altKey:alt.current})}
      >
        {item.label}
      </DropdownMenuPrimitive.Item>}
    </>
  );
}

/** 普通菜单项（自定义内容）：供 `DropdownMenu` children 模式使用。 */
export function DropdownMenuItem(props: {
  onSelect?: (event: Event) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.Item
      className={["ui-menu__item", props.className].filter(Boolean).join(" ")}
      disabled={props.disabled}
      onSelect={props.onSelect}
    >
      {props.children}
    </DropdownMenuPrimitive.Item>
  );
}

/**
 * 单选菜单项（`role="menuitemradio"`）。受 Radix RadioGroup 的 roving focus 与方向键管理；
 * 保留 `data-active`/`aria-checked` 供既有测试与业务 class 使用。
 */
export function MenuRadioItem(props: {
  value: string;
  active: boolean;
  label?: string;
  disabled?: boolean;
  className?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={["ui-menu__item", props.className].filter(Boolean).join(" ")}
      value={props.value}
      disabled={props.disabled}
      aria-label={props.label}
      data-active={props.active ? "true" : undefined}
      onSelect={props.onSelect}
    >
      {props.children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export type DropdownMenuProps = {
  trigger: ReactNode;
  items?: readonly MenuItem[];
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** content 追加 class。 */
  className?: string;
  /** content 可访问名。 */
  label?: string;
  /** 子项为 `MenuRadioItem` 时传入当前值，content 会包一层 RadioGroup。 */
  radioValue?: string;
  onRadioValueChange?: (value: string) => void;
};

/** 普通 trigger 下拉菜单（受控可选）。 */
export function DropdownMenu(props: DropdownMenuProps) {
  const container = usePortalContainer();
  const group=useContext(MenuBarContext),id=useId();
  const content = props.children ?? props.items?.map((item) => <MenuEntry key={item.id} item={item} />);
  return (
    <DropdownMenuPrimitive.Root open={group?group.active===id:props.open} onOpenChange={open=>{group?.setOpen(id,open);props.onOpenChange?.(open);}} modal={!group}>
      <DropdownMenuPrimitive.Trigger asChild data-menu-title={group?id:undefined} data-menu-mnemonic={group?menuMnemonic(props.label??""):undefined} onPointerEnter={()=>group?.enter(id)}>{props.trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={container ?? undefined}>
        <DropdownMenuPrimitive.Content
          data-menu-bar-owner={group?.owner}
          className={["ui-menu", props.className].filter(Boolean).join(" ")}
          side={props.side ?? "bottom"}
          align={props.align ?? "center"}
          sideOffset={props.sideOffset ?? 6}
          collisionPadding={8}
          aria-label={props.label}
          onCloseAutoFocus={event=>{if(group?.hasOpenMenu())event.preventDefault();}}
        >
          <MenuScroll>{props.radioValue !== undefined ? (
            <DropdownMenuPrimitive.RadioGroup
              value={props.radioValue}
              onValueChange={props.onRadioValueChange}
            >
              {content}
            </DropdownMenuPrimitive.RadioGroup>
          ) : (
            content
          )}</MenuScroll>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export type CursorMenuProps = {
  /** 是否打开（受控：Navigation/宿主是 menu route owner）。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 屏幕坐标（clientX/clientY）。 */
  x: number;
  y: number;
  items: readonly MenuItem[];
  /** 菜单可访问名（例如「插入节点」）。 */
  label?: string;
  /** content 追加 class（迁移期保留业务定位 class）。 */
  className?: string;
  /** 菜单项追加 class（迁移期保留业务 selector）。 */
  itemClassName?: string;
  /** 分隔线追加 class（迁移期保留业务 selector）。 */
  separatorClassName?: string;
};

/**
 * Canvas cursor anchor 菜单。
 *
 * 用 Radix DropdownMenu + 固定零尺寸锚点承载：Radix 负责碰撞/flip/边距与完整菜单键盘
 * 语义（方向键、Home/End、Enter/Space、Escape、typeahead、单次 select），宿主负责 menu
 * route；不再依赖手工 viewport 翻转或 window keydown/pointerdown listener。
 */
export function CursorMenu(props: CursorMenuProps) {
  const container = usePortalContainer();
  return (
    <DropdownMenuPrimitive.Root open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <DropdownMenuPrimitive.Trigger asChild>
        <span
          className="ui-menu__anchor"
          aria-hidden="true"
          tabIndex={-1}
          style={{ position: "fixed", left: props.x, top: props.y, width: 0, height: 0 }}
        />
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={container ?? undefined}>
        <DropdownMenuPrimitive.Content
          className={["ui-menu", props.className].filter(Boolean).join(" ")}
          align="start"
          sideOffset={2}
          collisionPadding={8}
          aria-label={props.label ?? "上下文菜单"}
          data-cursor-menu=""
        >
          <MenuScroll>{props.items.map((item) => (
            <MenuEntry
              key={item.id}
              item={item}
              itemClassName={props.itemClassName}
              separatorClassName={props.separatorClassName}
            />
          ))}</MenuScroll>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/**
 * 受控下拉菜单的高级组合（供需要自定义 item 组合的消费者，例如含 label/hint 的模型选项）。
 * 消费者仍从本模块导入，不直接依赖 `@radix-ui/react-dropdown-menu`。
 */
export const DropdownMenuRoot = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuContent = DropdownMenuPrimitive.Content;
export const MenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const MenuSeparator = DropdownMenuPrimitive.Separator;
