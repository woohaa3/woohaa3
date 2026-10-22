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
import { type ReactNode } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { usePortalContainer } from "./UiProvider.js";
import { ChevronRightIcon } from "./icons.js";

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
  onSelect: (id: string) => void;
};

/** 单个菜单项（普通 Dropdown 模式）。 */
export function MenuEntry(props: { item: MenuItem; itemClassName?: string; separatorClassName?: string }) {
  const { item } = props;
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
          <DropdownMenuPrimitive.SubContent className="ui-menu" sideOffset={4} collisionPadding={8}>
            {item.children.map(child => <MenuEntry key={child.id} item={child} itemClassName={props.itemClassName} separatorClassName={props.separatorClassName} />)}
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
        onSelect={() => item.onSelect(item.id)}
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
  const content = props.children ?? props.items?.map((item) => <MenuEntry key={item.id} item={item} />);
  return (
    <DropdownMenuPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      <DropdownMenuPrimitive.Trigger asChild>{props.trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={container ?? undefined}>
        <DropdownMenuPrimitive.Content
          className={["ui-menu", props.className].filter(Boolean).join(" ")}
          side={props.side ?? "bottom"}
          align={props.align ?? "center"}
          sideOffset={props.sideOffset ?? 6}
          collisionPadding={8}
          aria-label={props.label}
        >
          {props.radioValue !== undefined ? (
            <DropdownMenuPrimitive.RadioGroup
              value={props.radioValue}
              onValueChange={props.onRadioValueChange}
            >
              {content}
            </DropdownMenuPrimitive.RadioGroup>
          ) : (
            content
          )}
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
          {props.items.map((item) => (
            <MenuEntry
              key={item.id}
              item={item}
              itemClassName={props.itemClassName}
              separatorClassName={props.separatorClassName}
            />
          ))}
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
