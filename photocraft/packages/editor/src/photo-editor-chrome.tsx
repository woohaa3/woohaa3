import {MarqueeToolGroup} from "./marquee-tool-group.js";
import { editorMenusFor, type EditorDocumentsMenu, type EditorMenuItem } from "./photo-editor-menu.js";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { Button, IconButton } from "./ui/Button.js";
import { DropdownMenu, type MenuItem } from "./ui/Menu.js";
import { Tooltip } from "./ui/Tooltip.js";
import {
  MoveIcon, EraserIcon, LassoIcon, MarqueeIcon,
  PenIcon, RedoIcon, TypeIcon, UndoIcon, ChevronDownIcon, SwapColorsIcon
} from "./ui/icons.js";
import { DISPLAY_SHORTCUTS, TOOL_KEYS, commandShortcutLabel, shortcutLabel, type PhotoEditorTool, type EditorViewAction } from "./photo-editor-shortcuts.js";
import type {EditorDisplayControls} from "./editor-display.js";
export type { PhotoEditorTool } from "./photo-editor-shortcuts.js";


export const PHOTO_TOOLS = [
  { id: "move", label: "移动", Icon: MoveIcon },
  { id: "marquee", label: "矩形 / 椭圆选框", Icon: MarqueeIcon },
  { id: "lasso", label: "套索", Icon: LassoIcon },
  { id: "brush", label: "画笔", Icon: PenIcon },
  { id: "eraser", label: "橡皮", Icon: EraserIcon },
  { id: "text", label: "文字", Icon: TypeIcon }
] as const;

export function EditorMenuBar({ commands, readonly, canUndo, canRedo, onCommand, onApply, canSave, saving, display, displayDisabled, onTransform, canTransform, canTransformSelection, onView, viewDisabled, mergeLabel, documents }: {
  display?:EditorDisplayControls;
  displayDisabled?:boolean;
  commands: ReadonlyMap<string, PhotocraftCommand>;
  readonly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onCommand: (id: string) => void;
  onApply: () => void;
  canSave: boolean;
  saving: boolean;
  onTransform?: (selectionOnly: boolean) => void;
  canTransform?: boolean;
  canTransformSelection?: boolean;
  onView?: (action: EditorViewAction) => void;
  viewDisabled?: boolean;
  mergeLabel?: string;
  /**
   * 文档菜单能力（change: 2026-10-21-add-photocraft-document-workspace，D2）。
   *
   * 打开文件 / 关闭 / 文档清单属于菜单，不放在文档标签条上。缺省（PhotoCraft dev 宿主）
   * 不显示「文件」与文档清单项。
   */
  documents?: EditorDocumentsMenu;
}) {
  const menuItems = (entries: readonly EditorMenuItem[]): MenuItem[] => entries.flatMap<MenuItem>(entry => {
    if (entry.children) {
      const children = menuItems(entry.children);
      return children.length ? [{...entry, children, disabled: children.every(child => child.disabled), onSelect: () => {}}] : [];
    }
    const command = commands.get(entry.id);
    if (!command?.allowed) return [];
    const transform = entry.id === "edit.transform" || entry.id === "select.transformSelection";
    const enabled = entry.id === "edit.undo" ? canUndo : entry.id === "edit.redo" ? canRedo
      : transform ? command.enabled && !!onTransform && (entry.id === "edit.transform" ? canTransform : canTransformSelection) : command.enabled;
    const shortcut = entry.id === "edit.transform" ? shortcutLabel("Mod+T") : commandShortcutLabel(entry.id);
    return [{...entry, children: undefined, label: <><span title={command.disabledReason ?? undefined}>{entry.id === "layer.mergeLayers" ? mergeLabel ?? entry.label : entry.label}</span>{shortcut ? <kbd className="photo-editor__shortcut" title={entry.id === "edit.transform" ? "浏览器可能占用此快捷键，可直接点击菜单或使用图片右键菜单" : undefined}>{shortcut}</kbd> : null}</>,
      disabled: readonly || !enabled, danger: entry.id === "layer.delete",
      onSelect: transform ? () => onTransform?.(entry.id === "select.transformSelection") : onCommand}];
  }).map((item, index) => ({...item, separatorBefore: index > 0 && item.separatorBefore}));
  const displayItems = DISPLAY_SHORTCUTS.map(entry => {
    const visible = entry.action === "extras" ? display?.state.extrasVisible : entry.action === "sidebar" ? display?.state.sidebarVisible : display?.state.toolsVisible || display?.state.sidebarVisible;
    const name = entry.action === "extras" ? "额外内容（选区与变换边界）" : entry.action === "sidebar" ? "侧栏面板" : "工具与面板";
    return {id: entry.action, label: <><span>{name}</span><kbd className="photo-editor__shortcut">{shortcutLabel(entry.label)}</kbd></>,
      selected: !!visible, disabled: displayDisabled ?? readonly, onSelect: () => display?.toggle(entry.action)};
  });
  const viewItems: MenuItem[] = onView ? ([
    ["zoomIn", "放大", "Mod++"], ["zoomOut", "缩小", "Mod+-"], ["fit", "适合屏幕", "Mod+0"], ["actualSize", "100%", "Mod+1"]
  ] as const).map(([id, label, shortcut], index) => ({id, label: <><span>{label}</span><kbd className="photo-editor__shortcut">{shortcutLabel(shortcut)}</kbd></>,
    separatorBefore: index === 2, disabled: viewDisabled ?? readonly, onSelect: () => onView(id)})) : [];
  if (display) viewItems.push({...displayItems[0]!, separatorBefore: viewItems.length > 0});
  // 文档清单属于「窗口」菜单（与编辑器自身的窗口显示项同处一组）。
  const documentItems: MenuItem[] = (documents?.list ?? []).map((entry) => ({
    id: `document:${entry.id}`,
    label: <><span>{entry.name}</span>{entry.status ? <kbd className="photo-editor__shortcut">{entry.status}</kbd> : null}</>,
    selected: entry.active,
    onSelect: () => documents?.onActivateDocument?.(entry.id)
  }));
  const windowItems = [...displayItems.slice(1), ...documentItems];
  // 文档动作（打开/关闭）走「文件」菜单；与图层命令不同，它们不来自内核命令表。
  const fileMenus = documents
    ? editorMenusFor(documents).filter((menu) => menu.label === "文件").map((menu) => ({
        ...menu,
        items: menu.items.map((entry): MenuItem => ({
          id: entry.id,
          label: entry.label,
          ...(entry.separatorBefore ? { separatorBefore: true } : {}),
          // 默认禁用：working 会话未就绪时不允许打开新文档。
          disabled: entry.id === "file.open" ? readonly : false,
          onSelect: entry.id === "file.open" ? () => documents.onOpenFile?.() : () => documents.onCloseDocument?.()
        }))
      }))
    : [];
  return (
    <div className="photo-editor__menubar">
      {fileMenus.map((menu) => (
        <DropdownMenu key={menu.label} align="start" label={menu.label}
          trigger={<Button size="sm" tone="ghost">{menu.label}<ChevronDownIcon size={12} /></Button>}
          items={menu.items} />
      ))}
      {editorMenusFor(documents).filter((menu) => menu.label !== "文件").map(menu => ({...menu, items: menuItems(menu.items)})).filter(menu => menu.items.length).map(menu => (
        <DropdownMenu key={menu.label} align="start" label={menu.label}
          trigger={<Button size="sm" tone="ghost">{menu.label}<ChevronDownIcon size={12} /></Button>}
          items={menu.items} />
      ))}
      {viewItems.length ? <DropdownMenu align="start" label="视图" trigger={<Button size="sm" tone="ghost">视图<ChevronDownIcon size={12}/></Button>}
        items={viewItems} /> : null}
      {display ? <DropdownMenu align="start" label="窗口" trigger={<Button size="sm" tone="ghost">窗口<ChevronDownIcon size={12}/></Button>}
        items={windowItems} /> : null}
      <span className="photo-editor__divider" />
      <IconButton label="撤销" title={`撤销（${commandShortcutLabel("edit.undo")}）`} size="sm" disabled={readonly || !canUndo} onClick={() => onCommand("edit.undo")}><UndoIcon /></IconButton>
      <IconButton label="重做" title={`重做（${commandShortcutLabel("edit.redo")}）`} size="sm" disabled={readonly || !canRedo} onClick={() => onCommand("edit.redo")}><RedoIcon /></IconButton>
      <span className="photo-editor__status-gap" />
      <Button size="sm" tone="primary" disabled={!canSave} loading={saving} title={`应用到节点（${shortcutLabel("Mod+S")}）`} onClick={onApply}>应用到节点</Button>
    </div>
  );
}

export function EditorToolRail({ tool, onTool, readonly, color, onColor, background = "#ffffff", onBackground, onColorAction, hidden = false, ellipse = false, onMarqueeKind }: {
  hidden?:boolean;
  ellipse?:boolean;
  onMarqueeKind?:(ellipse:boolean)=>void;
  tool: PhotoEditorTool;
  onTool: (tool: PhotoEditorTool) => void;
  readonly: boolean;
  color: string;
  onColor: (color: string) => void;
  background?: string;
  onBackground?: (color:string) => void;
  onColorAction?: (action:"swap"|"reset") => void;
}) {
  return (
    <div className="photo-editor__toolrail" hidden={hidden}>
      {PHOTO_TOOLS.map(({ id, label, Icon }) => id==="marquee" ? (
        <MarqueeToolGroup key={id} active={tool===id} ellipse={ellipse} disabled={readonly} hidden={hidden}
          onChoose={value=>{onMarqueeKind?.(value);onTool("marquee");}}/>
      ) : (
        <Tooltip key={id} content={TOOL_KEYS[id] ? `${label}（${TOOL_KEYS[id]}）` : label} side="right">
          <IconButton label={label} pressed={tool === id} disabled={readonly}
            className="photo-editor__tool" onClick={() => onTool(id)}><Icon /></IconButton>
        </Tooltip>
      ))}
      <div className="photo-editor__colors">
      <label className="photo-editor__swatch" title="前景色">
        <input type="color" value={color} disabled={readonly} onChange={(event) => onColor(event.currentTarget.value)} />
      </label>
      <label className="photo-editor__background-swatch" title="背景色">
        <input type="color" value={background} disabled={readonly} onChange={(event) => onBackground?.(event.currentTarget.value)} />
      </label>
      </div>
      <IconButton size="sm" label="交换前背景色（X）" disabled={readonly} onClick={() => onColorAction?.("swap")}><SwapColorsIcon size={14} /></IconButton>
      <Button size="sm" tone="ghost" title="恢复默认前背景色（D）" disabled={readonly} onClick={() => onColorAction?.("reset")}>默认</Button>
    </div>
  );
}
