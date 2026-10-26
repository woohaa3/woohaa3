import {decodeTextAntialias,type TextAntialias} from "./text-antialias.js";
import type {TextClipboardControls,TextClipboardAction} from "./text-clipboard.js";
import {EDITOR_THEMES,type useEditorTheme} from "./editor-theme.js";
import { editorMenusFor, type EditorDocumentsMenu, type EditorMenuItem } from "./photo-editor-menu.js";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { Button, IconButton } from "./ui/Button.js";
import {DropdownMenu,MenuBar,type MenuItem} from "./ui/Menu.js";
import { ChevronRightIcon, RedoIcon, SquareDashedIcon, SwapColorsIcon, UndoIcon } from "./ui/icons.js";
import { DISPLAY_SHORTCUTS, commandShortcutLabel, shortcutLabel, type PhotoEditorTool, type EditorViewAction } from "./photo-editor-shortcuts.js";
import {EDITOR_SCREEN_MODES,type EditorDisplayControls,type EditorScreenMode} from "./editor-display.js";
import {PANEL_GROUP_LABELS,type PanelGroupId} from "./editor-sidebar.js";
import {ScreenModeButton} from "./screen-mode-button.js";
import {ToolSlotButton} from "./tool-slot-button.js";
import {visibleToolSections, type ToolMember} from "./toolbar-slots.js";
export type { PhotoEditorTool } from "./photo-editor-shortcuts.js";

/**
 * 工具栏结构来自槽位注册表（`toolbar-slots.ts`），本文件只做投影渲染：
 * 段、槽、flyout 成员顺序、高亮与底部常驻入口。行为契约见
 * `openspec/specs/editor-workspace/spec.md` 的工具栏要求。
 */



export function EditorMenuBar({ theme, commands, readonly, canUndo, canRedo, onCommand, onApply, canSave, saving, display, displayDisabled, cloneSourceAvailable, brushPresetsAvailable, guides, onTransform, canTransform, canTransformSelection, onView, viewDisabled, mergeLabel, documents, onPreferences,onSearch,textActions,textClipboard }: {
  /** 「克隆源」面板入口只在对应命令开放时出现。 */
  cloneSourceAvailable?:boolean;
  /** 「画笔预设」面板入口只在预设命令开放时出现。 */
  brushPresetsAvailable?:boolean;
  /** 标尺/参考线/网格显示与吸附（I096）。 */
  guides?:{showRulers:boolean;showGuides:boolean;showGrid:boolean;snapToGuides:boolean;snapToGrid:boolean;toggle:(key:"showRulers"|"showGuides"|"showGrid"|"snapToGuides"|"snapToGrid")=>void};
  textClipboard?:TextClipboardControls;
  textActions?:{canInsertLorem:boolean;insertLorem:()=>void;canAntialias?:boolean;antialias?:TextAntialias;setOrientation?:(mode:"horizontal"|"vertical")=>void;canOrientation?:boolean;setAntialias?:(mode:TextAntialias)=>void};
  theme?:ReturnType<typeof useEditorTheme>;
  onPreferences?:()=>void;
  onSearch?:()=>void;
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
   * 打开文件 / 关闭 / 文档清单由宿主注入；内核允许的文件脚本独立显示。
   */
  documents?: EditorDocumentsMenu;
}) {
  const menuItems = (entries: readonly EditorMenuItem[]): MenuItem[] => entries.flatMap<MenuItem>(entry => {
    if(entry.id==="edit.search")return onSearch?[{...entry,children:undefined,onSelect:onSearch,disabled:readonly}]:[];
    if(entry.id==="edit.defineBrushPreset")return brushPresetsAvailable && commands.get("brush.defineFromSelection")?.allowed?[{...entry,children:undefined,disabled:readonly || !commands.get("brush.defineFromSelection")?.enabled,onSelect:()=>display?.showPanel?.("brushes","presets")}]:[];
    if(entry.id.startsWith("type.panels."))return display?.showPanel && commands.get("type.create")?.allowed?[{...entry,children:undefined,disabled:chromeDisabled,onSelect:()=>display.showPanel?.("character",entry.id.endsWith("paragraph")?"paragraph":"character")}]:[];
    if(entry.id==="layer.layerStyle.blendingOptions")return commands.get("layer.layerStyle.replace")?.allowed?[{...entry,children:undefined,disabled:readonly || !commands.get("layer.layerStyle.replace")?.enabled,onSelect:()=>onCommand("layer.layerStyle.blendingOptions")}]:[];
    const hostAction=entry.id==="file.new"?documents?.onNewDocument:entry.id==="file.open"?documents?.onOpenFile:entry.id==="file.exportAs"?documents?.onExport:entry.id==="file.close"?documents?.onCloseDocument:entry.id==="file.closeAll"?documents?.onCloseAllDocuments:entry.id==="file.closeOthers"?documents?.onCloseOtherDocuments:undefined;
    if(hostAction)return [{...entry,children:undefined,disabled:readonly || entry.id==="file.closeOthers" && (documents?.list?.length??0)<2,onSelect:hostAction}];
    if(entry.id==="image.duplicateDocument")return [{...entry,children:undefined,disabled:readonly || documents?.duplicateDisabled===true,onSelect:()=>documents?.onDuplicateDocument?.()}];
    // 图像模式对话框由编辑器自身持有；它没有内核命令条目，但仍受只读与门禁约束。
    if(entry.id==="image.colorMode")return commands.get("image.mode.rgb")?.allowed?[{...entry,children:undefined,disabled:readonly || !commands.get("image.mode.rgb")?.enabled,onSelect:()=>onCommand("image.colorMode")}]:[];
    if (entry.children) {
      const children = menuItems(entry.children);
      return children.length ? [{...entry, children, disabled: children.every(child => child.disabled), onSelect: () => {}}] : [];
    }
    if(textClipboard && ["edit.cut","edit.copy","edit.paste","select.all"].includes(entry.id)) {
      const action=entry.id as TextClipboardAction;
      return [{...entry,children:undefined,disabled:!textClipboard.enabled(action),onSelect:()=>textClipboard.run(action)}];
    }
    if(entry.id.startsWith("type.orientation.") && textActions?.setOrientation){
      const mode=entry.id.slice("type.orientation.".length);if((mode!=="horizontal" && mode!=="vertical") || !commands.get(entry.id)?.allowed)return [];
      return [{...entry,children:undefined,disabled:!textActions.canOrientation,onSelect:()=>textActions.setOrientation?.(mode)}];
    }
    if(entry.id.startsWith("type.antiAlias.") && textActions?.setAntialias){
      const mode=decodeTextAntialias(entry.id.slice("type.antiAlias.".length));if(!mode || !commands.get(entry.id)?.allowed)return [];
      return [{...entry,children:undefined,disabled:!textActions.canAntialias,onSelect:()=>textActions.setAntialias?.(mode)}];
    }
    const command = commands.get(entry.id);
    if (!command?.allowed) return [];
    const transform = entry.id === "edit.transform" || entry.id === "select.transformSelection";
    const workspacePurge=documents?.purge?.commands[entry.id as keyof typeof documents.purge.commands];
    const enabled = workspacePurge?workspacePurge.enabled:entry.id === "edit.undo" ? canUndo : entry.id === "edit.redo" ? canRedo : entry.id === "edit.toggleLastState" ? canUndo || canRedo
      : transform ? command.enabled && !!onTransform && (entry.id === "edit.transform" ? canTransform : canTransformSelection) : command.enabled;
    const shortcut = entry.id === "edit.transform" ? shortcutLabel("Mod+T") : commandShortcutLabel(entry.id);
    return [{...entry, children: undefined, label: <><span title={(workspacePurge?workspacePurge.reason:command.disabledReason) ?? undefined}>{entry.id === "layer.mergeLayers" ? mergeLabel ?? entry.label : entry.label}</span>{shortcut ? <kbd className="photo-editor__shortcut" title={entry.id === "edit.transform" ? "浏览器可能占用此快捷键，可直接点击菜单或使用图片右键菜单" : undefined}>{shortcut}</kbd> : null}</>,
      disabled: readonly || !enabled, danger: entry.id === "layer.delete",
      onSelect: transform ? () => onTransform?.(entry.id === "select.transformSelection") : (id,modifiers)=>{
        const alternate=modifiers?.altKey ? id==="layer.mergeVisible"?"layer.stampVisible":id==="layer.mergeLayers" || id==="layer.mergeDown"?"layer.stampDown":null:null;
        if(alternate) {const command=commands.get(alternate);if(!readonly && command?.allowed && command.enabled) onCommand(alternate);}
        else onCommand(id);
      }}];
  }).map((item, index) => ({...item, separatorBefore: index > 0 && item.separatorBefore}));
  const displayItems = DISPLAY_SHORTCUTS.map(entry => {
    const visible = entry.action === "extras" ? display?.state.extrasVisible : entry.action === "sidebar" ? display?.state.sidebarVisible : display?.state.toolsVisible || display?.state.optionsVisible || display?.state.sidebarVisible;
    const name = entry.action === "extras" ? "额外内容（选区与变换边界）" : entry.action === "sidebar" ? "侧栏面板" : "工具与面板";
    return {id: entry.action, label: <><span>{name}</span><kbd className="photo-editor__shortcut">{shortcutLabel(entry.label)}</kbd></>,
      selected: !!visible, disabled: displayDisabled ?? readonly, onSelect: () => display?.toggle(entry.action)};
  });
  const viewItems: MenuItem[] = onView ? ([
    ["zoomIn", "放大", "Mod++"], ["zoomOut", "缩小", "Mod+-"], ["fit", "适合屏幕", "Mod+0"], ["fitLayers","适合所选图层",""], ["actualSize", "100%", "Mod+1"], ["twoHundredPercent","200%",""], ["printSize","打印尺寸",""]
  ] as const).map(([id, label, shortcut], index) => ({id, label: <><span>{label}</span>{shortcut?<kbd className="photo-editor__shortcut">{shortcutLabel(shortcut)}</kbd>:null}</>,
    separatorBefore: index === 2, disabled: viewDisabled ?? readonly, onSelect: () => onView(id)})) : [];
  if (display) viewItems.push({...displayItems[0]!, separatorBefore: viewItems.length > 0});
  const showItems:MenuItem[]=[];
  const chromeDisabled=displayDisabled??readonly;
  if(display)showItems.push({id:"pixelGrid",label:"像素网格",selected:!!display.state.pixelGridVisible,disabled:chromeDisabled,onSelect:()=>display.toggle("pixelGrid")});
  if(guides){
    showItems.push({id:"view.extras.guides",label:"参考线",selected:guides.showGuides,disabled:chromeDisabled,onSelect:()=>guides.toggle("showGuides")},
      {id:"view.extras.grid",label:"网格",selected:guides.showGrid,disabled:chromeDisabled,onSelect:()=>guides.toggle("showGrid")});
    viewItems.push({id:"view.show",label:"显示",onSelect:()=>{},children:showItems},
      {id:"view.extras.rulers",label:"标尺",selected:guides.showRulers,disabled:chromeDisabled,onSelect:()=>guides.toggle("showRulers")},
      {id:"view.snapTo",label:"对齐到",onSelect:()=>{},children:[
        {id:"view.snapGuides",label:"参考线",selected:guides.snapToGuides,disabled:chromeDisabled,onSelect:()=>guides.toggle("snapToGuides")},
        {id:"view.snapGrid",label:"网格",selected:guides.snapToGrid,disabled:chromeDisabled,onSelect:()=>guides.toggle("snapToGrid")}]},
      ...menuItems([{id:"view.newGuide",label:"新建参考线…",separatorBefore:true},{id:"view.clearGuides",label:"清除参考线"},{id:"view.resetRulerOrigin",label:"重置标尺原点"}]));
  }else if(showItems.length)viewItems.push({id:"view.show",label:"显示",onSelect:()=>{},children:showItems});
  if(display?.setScreenMode)viewItems.push({id:"screenMode",label:"屏幕模式",disabled:displayDisabled??readonly,onSelect:()=>{},children:EDITOR_SCREEN_MODES.map(mode=>({id:`view.screenMode.${mode.id}`,label:mode.label,selected:(display.state.screenMode??"standard")===mode.id,onSelect:()=>display.setScreenMode?.(mode.id)}))});
  // 文档清单属于「窗口」菜单（与编辑器自身的窗口显示项同处一组）。
  const documentItems: MenuItem[] = (documents?.list ?? []).map((entry) => ({
    id: `document:${entry.id}`,
    label: <><span>{entry.name}</span>{entry.status ? <kbd className="photo-editor__shortcut">{entry.status}</kbd> : null}</>,
    selected: entry.active,
    onSelect: () => documents?.onActivateDocument?.(entry.id)
  }));
  const helpItems:MenuItem[]=[...(onSearch?[{id:"help-search",label:"搜索命令与菜单路径…",disabled:readonly,onSelect:onSearch}]:[]),
    ...[["help.website","PhotoCraft 官网","https://getartcraft.com/apps/photocraft"],["help.community","加入社区…","https://discord.gg/artcraft"],["help.source","PhotoCraft 源代码…","https://github.com/storytold/photocraft"],["help.issues","反馈问题…","https://github.com/storytold/photocraft/issues"]].map(([id,label,url],index)=>({id,label,separatorBefore:index===0,onSelect:()=>{window.open(url,"_blank","noopener,noreferrer");}}))];
  const themeItems:MenuItem[]=theme?[{id:"theme",label:"主题",onSelect:()=>{},children:[...EDITOR_THEMES.map(item=>({id:`window.theme.${item.id}`,label:item.label,selected:theme.preference.theme===item.id,onSelect:()=>theme.select(item.id)})),{id:"window.theme.system",label:"跟随系统外观",separatorBefore:true,selected:theme.preference.theme==="system",onSelect:()=>theme.select("system")}]},
    {id:"view.darkenInterface",label:<>调暗界面<kbd>{shortcutLabel("Mod+Shift+F1")}</kbd></>,onSelect:()=>theme.step(false)},
    {id:"view.lightenInterface",label:<>调亮界面<kbd>{shortcutLabel("Mod+Shift+F2")}</kbd></>,onSelect:()=>theme.step(true)}]:[];
  const independentDisplayItems:MenuItem[]=display?([
    ["tools","工具栏",display.state.toolsVisible],["options","选项栏",display.state.optionsVisible]
  ] as const).map(([id,label,selected])=>({id,label,selected,disabled:displayDisabled??readonly,onSelect:()=>display.toggle(id)})):[];
  if(display)independentDisplayItems.push({id:"modifiers",label:"修饰键",selected:!!display.state.modifiersVisible,disabled:displayDisabled??readonly,onSelect:()=>display.toggle("modifiers")});
  if(display?.showPanel){
    const panel=(group:PanelGroupId,tab:string,label:string)=>({id:`window.panel.${tab}`,label,selected:!!display.state.sidebarVisible && !display.state.panelLayout?.hiddenGroups?.[group] && !display.state.panelLayout?.collapsedGroups?.[group] && (display.state.panelLayout?.activeTabs?.[group]??(group==="brushes"?"presets":group==="navigator"?display.state.navigatorVisible?"navigator":display.state.histogramVisible?"histogram":display.state.infoVisible?"info":"cloneSource":group))===tab,disabled:chromeDisabled,onSelect:()=>display.showPanel?.(group,tab)});
    independentDisplayItems.push(panel("properties","adjustments","调整"),panel("color","swatches","色板"),...(["color","properties","history","layers"] as const).map(id=>panel(id,id,PANEL_GROUP_LABELS[id])));
    if(commands.get("type.create")?.allowed)independentDisplayItems.push(panel("character","character","字符"),panel("character","paragraph","段落"));
    independentDisplayItems.push(panel("navigator","navigator","导航器"),panel("navigator","histogram","直方图"),panel("navigator","info","信息"));
    if(cloneSourceAvailable)independentDisplayItems.push(panel("navigator","cloneSource","克隆源"));
    if(brushPresetsAvailable)independentDisplayItems.push(panel("brushes","presets","画笔"),panel("brushes","settings","画笔设置"));
    independentDisplayItems.push({id:"window.resetPanels",label:"恢复默认面板布局",separatorBefore:true,disabled:chromeDisabled,onSelect:()=>display.updatePanels?.({hiddenGroups:{},collapsedGroups:{},groupHeights:{},groupOrder:undefined,activeTabs:{},layersCollapsed:false,historyCollapsed:false,propertiesCollapsed:false})});
  }else if(display){
    independentDisplayItems.push(...(["navigator","histogram","info",...(cloneSourceAvailable?["cloneSource"]:[]),...(brushPresetsAvailable?["brushPresets"]:[])] as const).map(id=>({id,label:({navigator:"导航器",histogram:"直方图",info:"信息",cloneSource:"克隆源",brushPresets:"画笔预设"} as Record<string,string>)[id],selected:!!(display.state as Record<string,unknown>)[`${id}Visible`],disabled:chromeDisabled,onSelect:()=>display.toggle(id as "navigator")})));
  }
  const panelOrder=["adjustments","settings","presets","character","cloneSource","color","histogram","history","info","layers","navigator","paragraph","properties","swatches"];
  const windowItems = [...themeItems,...displayItems.slice(1),...independentDisplayItems.sort((a,b)=>{const rank=(id:string)=>{const index=panelOrder.indexOf(id.split(".").at(-1)!);return index<0?panelOrder.length:index;};return rank(a.id)-rank(b.id);}), ...documentItems];
  // 文档动作（打开/关闭）走「文件」菜单；与图层命令不同，它们不来自内核命令表。
  const fileMenus=editorMenusFor(documents).filter(menu=>menu.label==="文件").map(menu=>({...menu,items:menuItems(menu.items)})).filter(menu=>menu.items.length);
  const typeItems=menuItems(editorMenusFor(documents).find(menu=>menu.label==="文字")?.items??[]);
  const standardMenus = editorMenusFor(documents)
    .filter((menu) => !["文件", "文字", "视图", "窗口", "帮助"].includes(menu.label))
    .map(menu => ({...menu, items: [
      ...menuItems(menu.items),
      ...(menu.label === "编辑" && onPreferences ? [{id:"preferences",label:"偏好设置…",separatorBefore:true,disabled:readonly,onSelect:onPreferences}] : [])
    ]})).filter(menu => menu.items.length);
  const mainMenus = standardMenus.filter(menu => ["编辑", "图像", "图层"].includes(menu.label));
  const selectMenus = standardMenus.filter(menu => menu.label === "选择");
  const filterMenus = standardMenus.filter(menu => menu.label === "滤镜");
  return (
    <MenuBar className="photo-editor__menubar">
      {fileMenus.map((menu) => (
        <DropdownMenu key={menu.label} align="start" label={menu.label}
          trigger={<Button size="sm" tone="ghost">{menu.label}</Button>}
          items={menu.items} />
      ))}
      {mainMenus.map(menu => (
        <DropdownMenu key={menu.label} align="start" label={menu.label}
          trigger={<Button size="sm" tone="ghost">{menu.label}</Button>}
          items={menu.items} />
      ))}
      {textActions || typeItems.length?<DropdownMenu align="start" label="文字" trigger={<Button size="sm" tone="ghost">文字</Button>} items={[...(textActions?[{id:"type.pasteLoremIpsum",label:"插入 Lorem Ipsum",disabled:!textActions.canInsertLorem,onSelect:textActions.insertLorem}]:[]),...typeItems]}/>:null}
      {selectMenus.map(menu => (
        <DropdownMenu key={menu.label} align="start" label={menu.label}
          trigger={<Button size="sm" tone="ghost">{menu.label}</Button>}
          items={menu.items} />
      ))}
      {filterMenus.map(menu => (
        <DropdownMenu key={menu.label} align="start" label={menu.label}
          trigger={<Button size="sm" tone="ghost">{menu.label}</Button>}
          items={menu.items} />
      ))}
      {viewItems.length ? <DropdownMenu align="start" label="视图" trigger={<Button size="sm" tone="ghost">视图</Button>}
        items={viewItems} /> : null}
      {display || theme ? <DropdownMenu align="start" label="窗口" trigger={<Button size="sm" tone="ghost">窗口</Button>}
        items={windowItems} /> : null}
      {helpItems.length?<DropdownMenu align="start" label="帮助" trigger={<Button size="sm" tone="ghost">帮助</Button>} items={helpItems}/>:null}
      <span className="photo-editor__divider" />
      <IconButton label="撤销" title={`撤销（${commandShortcutLabel("edit.undo")}）`} size="sm" disabled={readonly || !canUndo} onClick={() => onCommand("edit.undo")}><UndoIcon /></IconButton>
      <IconButton label="重做" title={`重做（${commandShortcutLabel("edit.redo")}）`} size="sm" disabled={readonly || !canRedo} onClick={() => onCommand("edit.redo")}><RedoIcon /></IconButton>
      <span className="photo-editor__status-gap" />
      <Button size="sm" tone="primary" disabled={!canSave} loading={saving} title={`应用到节点（${shortcutLabel("Mod+S")}）`} onClick={onApply}>应用到节点</Button>
    </MenuBar>
  );
}

export function EditorToolRail({ tool, onTool, readonly, color, onColor, background = "#ffffff", onBackground, onColorAction,onEditColor, hidden = false, onMarqueeKind, doubleColumn=false,onToggleColumns,onView,screenMode,onScreenMode,onTextOrientation,quickMask=false,onQuickMask,shownMemberFor }: {
  /** @deprecated 竖排文字现在由槽位注册表的未支持标注决定，参数保留以兼容既有调用。 */
  verticalTextDisabled?:boolean;
  /** 文字方向切换：槽位里的竖排成员由它落地。 */
  onTextOrientation?:(mode:"horizontal"|"vertical")=>void;
  /** 文档是否处于快速蒙版编辑模式；底部常驻按钮的按下态与提示由它决定。 */
  quickMask?:boolean;onQuickMask?:()=>void;
  /**
   * 槽位按钮显示哪个成员：由调用方按当前工具与槽位记忆决定。
   * 缺省时退化为「当前工具命中则用它，否则槽内首成员」。
   */
  shownMemberFor?:(slot:{index:number;members:readonly ToolMember[]})=>ToolMember;
  screenMode?:EditorScreenMode;onScreenMode?:(mode:EditorScreenMode)=>void;
  doubleColumn?:boolean;onToggleColumns?:()=>void;onView?:(action:EditorViewAction)=>void;
  hidden?:boolean;
  /** 选框子工具选择：`line` 优先于 `ellipse`，与槽位成员一一对应。 */
  onMarqueeKind?:(ellipse:boolean,line?:"row"|"column")=>void;
  tool: PhotoEditorTool;
  onTool: (tool: PhotoEditorTool,variant?:string) => void;
  readonly: boolean;
  color: string;
  onColor: (color: string) => void;
  background?: string;
  onBackground?: (color:string)=>void;
  onEditColor?:(target:"foreground"|"background")=>void;
  onColorAction?: (action:"swap"|"reset") => void;
}) {
  const choose=(member:ToolMember)=>{
    // 变体成员只切变体，不另开工具 id；选框与文字复用既有回调。
    if(member.variant && member.tool==="marquee") {
      const next=member.variant;
      if(next==="row" || next==="column") onMarqueeKind?.(false,next); else onMarqueeKind?.(next==="ellipse",undefined);
    } else if(member.variant && member.tool==="text") onTextOrientation?.(member.variant==="vertical"?"vertical":"horizontal");
    if(member.variant)onTool(member.tool,member.variant);else onTool(member.tool);
  };
  const shown=(slot:{index:number;members:readonly ToolMember[]})=>shownMemberFor?.(slot)
    ?? slot.members.find(member=>member.tool===tool) ?? slot.members[0]!;
  const sections=visibleToolSections();
  return (
    <div className="photo-editor__toolrail" data-columns={doubleColumn?2:1} data-sections={sections.length} hidden={hidden}>
      {onToggleColumns?<Button size="sm" tone="ghost" title={doubleColumn?"切换为单列工具栏":"切换为双列工具栏"} disabled={readonly} onClick={onToggleColumns}><ChevronRightIcon size={14} style={{transform:doubleColumn?"rotate(180deg)":undefined}}/></Button>:null}
      <div className="photo-editor__tool-list">
        {sections.map(({section,slots})=>(
          <div key={section} className="photo-editor__tool-section" data-section={section}>
            {slots.map(slot=>{
              const member=shown(slot);
              return <ToolSlotButton key={slot.index} slot={slot} shown={member}
                active={slot.members.some(member=>member.tool===tool)}
                onChoose={choose}
                onDoubleClick={member=>{if(member.tool==="pan")onView?.("fit");else if(member.tool==="zoom")onView?.("actualSize");}}
                disabled={readonly} hidden={hidden}/>;
            })}
          </div>
        ))}
      </div>
      <div className="photo-editor__colors">
      <label className="photo-editor__swatch" title="前景色">
        <input type="color" value={color} disabled={readonly} onClick={onEditColor?event=>{event.preventDefault();if(!readonly)onEditColor("foreground");}:undefined} onChange={(event) => onColor(event.currentTarget.value)} />
      </label>
      <label className="photo-editor__background-swatch" title="背景色">
        <input type="color" value={background} disabled={readonly} onClick={onEditColor?event=>{event.preventDefault();if(!readonly)onEditColor("background");}:undefined} onChange={(event) => onBackground?.(event.currentTarget.value)} />
      </label>
      </div>
      <IconButton size="sm" label="交换前背景色（X）" disabled={readonly} onClick={() => onColorAction?.("swap")}><SwapColorsIcon size={14} /></IconButton>
      <Button size="sm" tone="ghost" title="恢复默认前背景色（D）" disabled={readonly} onClick={() => onColorAction?.("reset")}>默认</Button>
      {onQuickMask?<IconButton size="sm" label={quickMask?"以标准模式编辑（Q）":"以快速蒙版模式编辑（Q）"}
        title={quickMask?"以标准模式编辑（Q）":"以快速蒙版模式编辑（Q）"} pressed={quickMask} disabled={readonly}
        className="photo-editor__quick-mask" onClick={onQuickMask}><SquareDashedIcon size={16}/></IconButton>:null}
      {onScreenMode?<ScreenModeButton mode={screenMode??"standard"} onChange={onScreenMode} disabled={readonly} hidden={hidden}/>:null}
    </div>
  );
}
