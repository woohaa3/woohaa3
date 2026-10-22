/**
 * 画布上下文菜单（change: 后续 change 补齐右键菜单；
 *  change: adopt-radix-lucide-canvas-ui 任务 4.1：迁移到受控 CursorMenu primitive）。
 *
 * 纯展示层：只渲染菜单项并把选择回调给宿主；不读画布、不发命令、不写 store。
 * 菜单的碰撞/flip/viewport 边距、outside dismiss、Escape、方向键与单次 select 全部交给
 * 共享 Menu primitive；本组件不再维护手工 viewport 翻转或 window keydown/pointerdown listener。
 *
 * 迁移期保留 `.canvas-context-menu*` class 以稳定 E2E selector 与既有视觉定位（design D7）；
 * 完成后再由 CSS 收敛到 `ui-menu*`。
 */
import { CursorMenu, type MenuItem } from "../../../shared/ui/Menu.js";

export type CanvasContextMenuItem = {
  icon?: import("react").ComponentType<{ className?: string }>;
  id: string;
  label: string;
  /** 不可点击项（例如断线只读时的插入项）。 */
  disabled?: boolean;
  /** 危险操作（删除）用红色强调。 */
  danger?: boolean;
  /** 该项前插入分隔线。 */
  separatorBefore?: boolean;
  /**
   * 菜单 section identity（change: 2026-10-10-add-game-furnace-extension）。
   * 宿主合并后按 section 顺序统一规范化并补分隔线，不依赖注册先后。
   */
  section?: string;
  /** section 内顺序；未声明时保持贡献顺序。 */
  order?: number;
  /**
   * 不可用原因（change: 2026-10-16-add-group-selection-toolbar）。
   *
   * 仅用于桌面鼠标悬停提示与诊断；不构成无障碍契约。禁用项用它说明为何不能激活
   * （只读、提交中、成员均在运行等），不新增第二份菜单状态。
   */
  reason?: string;
};

export type CanvasContextMenuProps = {
  /** 屏幕坐标（clientX/clientY）。 */
  x: number;
  y: number;
  items: readonly CanvasContextMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
  /** 无障碍标签（例如「插入节点」）。 */
  label?: string;
};

export function CanvasContextMenu(props: CanvasContextMenuProps) {
  const items: MenuItem[] = props.items.map((item) => ({
    ...item,
    onSelect: props.onSelect
  }));
  return (
    <CursorMenu
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
      x={props.x}
      y={props.y}
      items={items}
      label={props.label}
      className="canvas-context-menu"
      itemClassName="canvas-context-menu__item"
      separatorClassName="canvas-context-menu__separator"
    />
  );
}

