import type { FeatureMenuCommand } from "./features/menu-commands.js";
import { FEATURE_TOOLS, featureMenuSections, type EditorFeaturePanel } from "./features/index.js";
import {MarqueeToolGroup} from "./marquee-tool-group.js";
import {EditorToolGroup} from "./editor-tool-group.js";
import { editorMenusFor, type EditorDocumentsMenu, type EditorMenuItem } from "./photo-editor-menu.js";
import { useCustomizationPreferences } from "./features/customization/use-customization-preferences.js";
import { filterHiddenMenuItems, preferredChordLabel, shortcutHint, toolbarRenderGroups } from "./features/customization/shell-adapter.js";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { Button, IconButton } from "./ui/Button.js";
import { DropdownMenu, type MenuItem } from "./ui/Menu.js";
import { Tooltip } from "./ui/Tooltip.js";
import { RedoIcon, UndoIcon, ChevronDownIcon, SwapColorsIcon } from "./ui/icons.js";
import { DISPLAY_SHORTCUTS, commandShortcutLabel, isEditorMac, shortcutLabel, type PhotoEditorTool, type EditorViewAction } from "./photo-editor-shortcuts.js";
import type {EditorDisplayControls} from "./editor-display.js";
export type { PhotoEditorTool } from "./photo-editor-shortcuts.js";
export type { EditorFeaturePanel } from "./features/index.js";


export const PHOTO_TOOLS = FEATURE_TOOLS;

/**
 * 工具栏里的矢量工具分组（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
 *
 * 12 个矢量工具逐个铺在竖排工具栏会超出可用高度，因此沿用已有的「工具组」模式：形状、钢笔、
 * 路径各占一个按钮，长按或右键展开子工具。分组来自域内 `VECTOR_TOOLS` 的 `group` 字段，
 * 工具的标签/图标/可用性仍由 `FEATURE_TOOLS` 提供，不复制第二份清单。
 */
export function EditorMenuBar({ commands, readonly, documentlessReadonly, canUndo, canRedo, onCommand, onApply, canSave, saving, display, displayDisabled, onTransform, canTransform, canTransformSelection, onView, onOpenFeature, viewDisabled, mergeLabel, documents, transfer, featureCommands = [], onFeatureCommand }: {
  featureCommands?: readonly FeatureMenuCommand[];
  onFeatureCommand?: (panel: EditorFeaturePanel, command: string) => void;
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
  onOpenFeature?: (feature: EditorFeaturePanel) => void;
  viewDisabled?: boolean;
  mergeLabel?: string;
  /**
   * 文档菜单能力（change: 2026-10-21-add-photocraft-document-workspace，D2）。
   *
   * 打开文件 / 关闭 / 文档清单属于菜单，不放在文档标签条上。缺省（PhotoCraft dev 宿主）
   * 不显示「文件」与文档清单项。
   */
  documents?: EditorDocumentsMenu;
  /**
   * 真正不可写（只读/关闭中/忙碌/过渡/导出中/模态），**不含「没有文档」**。
   *
   * `readonly` 同时被用来禁用编辑动作，所以它包含「没有文档」是对的；但「新建」恰恰只在
   * 没有文档时成立，必须看这个不含文档的字段，否则它在唯一该可用的状态里反而不可点。
   */
  documentlessReadonly?: boolean;
  /**
   * 跨文档剪贴板动作（change: 2026-10-22，任务 4.2）。
   *
   * 载荷由工作区持有，因此这三个动作不由内核命令表提供；宿主/工作区注入时才显示。
   */
  transfer?: { enabled: boolean; onSelect: (id: string) => void };
}) {
  const preferences = useCustomizationPreferences();
  // 隐藏的菜单项整组消失；快捷键提示跟随当前生效组合（解绑后不再显示过期提示）。
  const menuItems = (entries: readonly EditorMenuItem[]): MenuItem[] => filterHiddenMenuItems(entries, preferences.menuHidden).flatMap<MenuItem>(entry => {
    if (entry.children) {
      const children = menuItems(entry.children);
      return children.length ? [{...entry, children, disabled: children.every(child => child.disabled), onSelect: () => {}}] : [];
    }
    // 跨文档剪贴板动作是工作区能力（不是内核命令表项），由宿主/工作区注入。
    if (entry.id.startsWith("edit.layerTransfer")) {
      if (!transfer || !transfer.enabled) return [];
      return [{...entry, children: undefined, disabled: readonly || !transfer.enabled,
        onSelect: () => transfer.onSelect(entry.id)}];
    }
    const command = commands.get(entry.id);
    if (!command?.allowed) return [];
    const transform = entry.id === "edit.transform" || entry.id === "select.transformSelection";
    const enabled = entry.id === "edit.undo" ? canUndo : entry.id === "edit.redo" ? canRedo
      : transform ? command.enabled && !!onTransform && (entry.id === "edit.transform" ? canTransform : canTransformSelection) : command.enabled;
    // 快捷键提示跟随偏好：自定义/解绑后不能继续显示出厂组合。
    const factory = entry.id === "edit.transform" ? shortcutLabel("Mod+T") : commandShortcutLabel(entry.id);
    const shortcut = shortcutHint(preferences, entry.id, isEditorMac(), factory);
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
  if (onOpenFeature) viewItems.push({id:"feature.viewAids",label:"标尺、网格与参考线…",separatorBefore:true,onSelect:()=>onOpenFeature("viewAids")});
  if (display) viewItems.push({...displayItems[0]!, separatorBefore: viewItems.length > 0});
  const featureItems = (entries: readonly [EditorFeaturePanel, string][]): MenuItem[] => entries.map(([id,label],index)=>({
    id:`feature.${id}`,label,separatorBefore:index===0,onSelect:()=>onOpenFeature?.(id)
  }));
  // 文档清单属于「窗口」菜单（与编辑器自身的窗口显示项同处一组）。
  const documentItems: MenuItem[] = (documents?.list ?? []).map((entry) => ({
    id: `document:${entry.id}`,
    label: <><span>{entry.name}</span>{entry.status ? <kbd className="photo-editor__shortcut">{entry.status}</kbd> : null}</>,
    selected: entry.active,
    onSelect: () => documents?.onActivateDocument?.(entry.id)
  }));
  const windowFeatureItems = onOpenFeature
    ? featureItems(featureMenuSections("窗口").map(section => [section.id, section.label]))
    : [];
  const windowItems = [...(display ? displayItems.slice(1) : []), ...windowFeatureItems, ...documentItems];
  const editorMenus = editorMenusFor(documents).filter((menu) => menu.label !== "文件").map(menu => {
    const extras = !onOpenFeature ? [] : featureItems(featureMenuSections(menu.label).map(section => [section.id, section.label]));
    const direct = featureCommands.filter(entry => entry.panel === (menu.label === "图像" ? "adjustments" : "filter"));
    const directItems: MenuItem[] = !onFeatureCommand || (menu.label !== "图像" && menu.label !== "滤镜") ? [] : [...new Set(direct.map(entry => entry.category ?? "其他"))].map(category => ({
      id: `category.${category}`, label: category, onSelect: () => {}, children: direct.filter(entry => (entry.category ?? "其他") === category).map(entry => ({
        id: `featureCommand.${entry.command}`, label: entry.label, disabled: readonly,
        onSelect: () => onFeatureCommand(entry.panel, entry.command)
      }))
    }));
    if (menu.label === "图像" && onFeatureCommand) directItems.push(...featureCommands.filter(entry => entry.panel === "compose").map(entry => ({
      id: entry.command, label: entry.label, disabled: readonly, onSelect: () => onFeatureCommand(entry.panel, entry.command)
    })));
    return {...menu,items:[...menuItems(menu.items),...directItems,...extras]};
  }).filter(menu=>menu.items.length);
  if (onOpenFeature) editorMenus.push({ label: "文字", items: featureItems(featureMenuSections("文字").map(section => [section.id, section.label])) });
  editorMenus.sort((a,b) => ["编辑","图像","图层","文字","选择","滤镜"].indexOf(a.label) - ["编辑","图像","图层","文字","选择","滤镜"].indexOf(b.label));
  // 「文件」里的 feature 入口（自动处理…）由域声明，文档动作由宿主注入。
  //
  // 这两者互不依赖：独立 dev 宿主只注入 `documents.transfer`（没有任何文档动作），如果只在
  // 「文件」菜单已存在时才挂 feature 项，域声明的入口在该宿主里根本没有菜单可落——面板还在，
  // 但用户只能靠「高级…」猜到它。因此没有文档动作时也要给出只含 feature 项的「文件」菜单。
  const fileFeatureItems = (hasDocumentItems: boolean): MenuItem[] => !onOpenFeature ? [] : featureMenuSections("文件")
    .map((section, index) => ({
      id: `feature.${section.id}`,
      label: section.label,
      ...(index === 0 && hasDocumentItems ? { separatorBefore: true } : {}),
      onSelect: () => onOpenFeature?.(section.id)
    }));
  // 文档动作（打开/关闭）走「文件」菜单；与图层命令不同，它们不来自内核命令表。
  const documentFileMenus = documents
    ? editorMenusFor(documents).filter((menu) => menu.label === "文件").map((menu) => ({
        ...menu,
        items: menu.items.map((entry): MenuItem => ({
          id: entry.id,
          label: entry.label,
          ...(entry.separatorBefore ? { separatorBefore: true } : {}),
          // 默认禁用：working 会话未就绪时不允许打开新文档。
          // 新建不受「没有文档」影响（那正是它唯一需要工作的状态），只受真正只读限制。
          disabled: entry.id === "file.open" ? (documentlessReadonly ?? readonly) : entry.id === "file.save" ? !canSave : entry.id === "file.exportPng" ? saving : entry.id === "file.new" ? (documentlessReadonly ?? readonly) : false,
          onSelect: () => {
            switch (entry.id) {
              case "file.new":
                documents.onNewDocument?.();
                return;
              case "file.open":
                documents.onOpenFile?.();
                return;
              case "file.place":
                documents.onPlaceImage?.();
                return;
              case "file.openPsd":
                documents.onOpenPsd?.();
                return;
              case "file.exportPsd":
                documents.onExportPsd?.();
                return;
              case "file.exportPng":
                documents.onExportPng?.();
                return;
              case "file.exportRaster":
                documents.onExportRaster?.();
                return;
              case "file.exportWeb":
                documents.onExportWeb?.();
                return;
              case "file.save":
                onApply();
                return;
              case "file.closeOthers":
                documents.onCloseOthers?.();
                return;
              case "file.closeAll":
                documents.onCloseAll?.();
                return;
              case "file.close":
                documents.onCloseDocument?.();
                return;
              default:
                return;
            }
          }
        }))
      }))
    : [];
  for (const menu of documentFileMenus) {
    const exports = menu.items.filter(item => item.id.startsWith("file.export"));
    if (exports.length) {
      const index = menu.items.findIndex(item => item.id.startsWith("file.export"));
      menu.items = menu.items.filter(item => !item.id.startsWith("file.export"));
      menu.items.splice(index, 0, { id: "file.export", label: "导出", separatorBefore: true, onSelect: () => {}, children: exports.map(item => ({...item, separatorBefore: false})) });
    }
  }
  const fileMenus = documentFileMenus.length
    ? documentFileMenus.map((menu) => ({ ...menu, items: [...menu.items, ...fileFeatureItems(menu.items.length > 0)] }))
    : fileFeatureItems(false).length
      ? [{ label: "文件", items: fileFeatureItems(false) }]
      : [];
  return (
    <div className="photo-editor__menubar">
      {fileMenus.map((menu) => (
        <DropdownMenu key={menu.label} align="start" label={menu.label}
          trigger={<Button size="sm" tone="ghost">{menu.label}<ChevronDownIcon size={12} /></Button>}
          items={menu.items} />
      ))}
      {editorMenus.map(menu => (
        <DropdownMenu key={menu.label} align="start" label={menu.label}
          trigger={<Button size="sm" tone="ghost">{menu.label}<ChevronDownIcon size={12} /></Button>}
          items={menu.items} />
      ))}
      {viewItems.length ? <DropdownMenu align="start" label="视图" trigger={<Button size="sm" tone="ghost">视图<ChevronDownIcon size={12}/></Button>}
        items={viewItems} /> : null}
      {windowItems.length ? <DropdownMenu align="start" label="窗口" trigger={<Button size="sm" tone="ghost">窗口<ChevronDownIcon size={12}/></Button>}
        items={windowItems} /> : null}
      <span className="photo-editor__divider" />
      <IconButton label="撤销" title={`撤销（${commandShortcutLabel("edit.undo")}）`} size="sm" disabled={readonly || !canUndo} onClick={() => onCommand("edit.undo")}><UndoIcon /></IconButton>
      <IconButton label="重做" title={`重做（${commandShortcutLabel("edit.redo")}）`} size="sm" disabled={readonly || !canRedo} onClick={() => onCommand("edit.redo")}><RedoIcon /></IconButton>
      <span className="photo-editor__status-gap" />
      <Button size="sm" tone="primary" disabled={!canSave} loading={saving}
        title={`${documents?.saveLabel ?? "应用到节点"}（${shortcutLabel("Mod+S")}）`}
        onClick={onApply}>{documents?.saveLabel ?? "应用到节点"}</Button>
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
  const preferences = useCustomizationPreferences();
  // 偏好决定顺序与隐藏；共用一条按钮的工具组（魔棒/快速选择、修复/修饰）按组渲染。
  const groups = toolbarRenderGroups(preferences);
  return (
    <div className="photo-editor__toolrail" hidden={hidden}>
      {groups.map(({ tool: id, group }) => {
        const { label, Icon, canRun } = PHOTO_TOOLS.find(entry => entry.id === id)!;
        // 组内快捷键提示也跟随偏好：改绑/解绑后不再显示出厂字母。
        const chord = (toolId: PhotoEditorTool) =>
          preferredChordLabel(preferences, `tool.${toolId}`, isEditorMac()) ?? undefined;
        const options = PHOTO_TOOLS.filter(entry => group.includes(entry.id)).map(entry => ({ ...entry, shortcut: chord(entry.id) })) as unknown as Parameters<typeof EditorToolGroup>[0]["options"];
        if (group.length > 1) {
          return <EditorToolGroup key={id} tool={tool} disabled={readonly} onChoose={onTool} options={options} />;
        }
        return id === "marquee" ? (
          <MarqueeToolGroup key={id} active={tool===id} ellipse={ellipse} disabled={readonly} hidden={hidden}
            onChoose={value=>{onMarqueeKind?.(value);onTool("marquee");}}/>
        ) : (
          <Tooltip key={id} content={chord(id) ? `${label}（${chord(id)}）` : label} side="right">
            <IconButton label={label} pressed={tool === id} disabled={!canRun({readonly, mode: "rgb-u8", rotationDegrees: 0, target: "pixels"}).enabled}
              className="photo-editor__tool" onClick={() => onTool(id)}><Icon /></IconButton>
          </Tooltip>
        );
      })}
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
