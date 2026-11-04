import { Popover } from "@woohaa3/ui/primitives";
import { TypeIcon, ImageIcon, FilmIcon, MusicIcon, BoxIcon, PluginIcon, PlusIcon, UploadIcon, VideoIcon, AdaptiveRatioIcon, LayersIcon } from "@woohaa3/ui/icons";
import type { CanvasContextMenuItem } from "./canvas-context-menu.js";
import { CANVAS_MENU_SECTION } from "@woohaa3/contracts";
import "./canvas-creation-popover.css";


const materialIcons = {
  "insert:text": TypeIcon, "insert:image": ImageIcon, "insert:video": FilmIcon,
  "insert:audio": MusicIcon, "insert:model3d": BoxIcon, "insert-scope:group": AdaptiveRatioIcon,
  "insert-scope:area": LayersIcon, "insert-scope:camera": VideoIcon, upload: UploadIcon
};
const sectionLabels: Record<string, string> = { "creation-tools": "创作工具" };
const sectionWatermarks: Record<string, string> = { "canvas-2d": "2D", "scene-3d": "3D" };
const agentCapabilities: Readonly<Record<string, string>> = {
  "insert-scope:group": "Agent 编排",
  "insert-scope:area": "Agent 编排",
  "insert:model3d": "Agent 生成"
};
const materialOrder: readonly string[] = ["insert:text", "insert:image", "insert:video", "insert:audio", "insert-scope:group", "insert:model3d", "insert-scope:area"];
const actionLabel = (item: CanvasContextMenuItem) => {
  if (item.id === "upload") return "上传素材…";
  const creates = item.id.startsWith("insert:") || item.id.startsWith("insert-scope:") || item.id.startsWith("insert-template:");
  return creates && !/^(新建|创建|添加)/.test(item.label) ? `新建${item.label}` : item.label;
};

/** Only mounted for an ordinary blank context menu; no conversation is created by opening. */
export default function CanvasCreationPopover(props: { menuIdentity?: object; screen: { x: number; y: number }; world: { x: number; y: number }; items: readonly CanvasContextMenuItem[]; writable: boolean; onSelect(id: string): void; onClose(): void }) {
  const groups = new Map<string, CanvasContextMenuItem[]>();
  // 镜头位于 2D / 3D 交界，上传等非创建操作独立放在底栏。
  const actions: CanvasContextMenuItem[] = [];
  const footer: CanvasContextMenuItem[] = [];
  const iconFor = (item: CanvasContextMenuItem) => item.icon ?? materialIcons[item.id as keyof typeof materialIcons] ?? (item.id.startsWith("insert-template:") ? PluginIcon : PlusIcon);
  for (const item of props.items) {
    if (item.id === "upload" || (item.section ?? "other") === "other") { footer.push(item); continue; }
    if (item.id === "insert-scope:camera") { actions.push(item); continue; }
    const key = item.id === "insert:model3d" || item.id === "insert-scope:area" ? "scene-3d"
      : item.section === CANVAS_MENU_SECTION.basicMaterial ? "canvas-2d" : item.section!;
    groups.set(key, [...groups.get(key) ?? [], item]);
  }
  const ordered = (items: CanvasContextMenuItem[]) => [...items].sort((a, b) => {
    const rank = (id: string) => { const index = materialOrder.indexOf(id); return index < 0 ? materialOrder.length : index; };
    return rank(a.id) - rank(b.id);
  });
  const renderItem = (item: CanvasContextMenuItem) => {
    const Icon = iconFor(item);
    const className = item.id === "insert-scope:camera" ? "canvas-create__camera" : item.id === "upload" ? "canvas-create__upload" : undefined;
    const label = actionLabel(item);
    const agentCapability = agentCapabilities[item.id];
    return <button key={item.id} type="button" className={className} disabled={item.disabled} title={item.reason ?? label} onClick={() => props.onSelect(item.id)}>
      <span className="canvas-create__icon">
        <Icon />
      </span>
      <span className="canvas-create__label">{label}</span>
      {agentCapability ? <span className="canvas-create__agent-badge">{agentCapability}</span> : null}
    </button>;
  };
  const renderSection = (section: string, items = groups.get(section)) => items?.length ? <section key={section} data-section={section} data-watermark={sectionWatermarks[section]}>
    {sectionWatermarks[section] ? null : <h3>{sectionLabels[section] ?? section}</h3>}
    <div className="canvas-create__grid">{ordered(items).map(renderItem)}</div>
  </section> : null;
  return <Popover open anchorPoint={props.screen} align="start" side="bottom" restoreFocus={false} className="canvas-create" testId="canvas-creation-popover" onOpenChange={open => { if (!open) props.onClose(); }}>
    <div onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={event => event.stopPropagation()}>
      <header className="canvas-create__heading">
        <PlusIcon /><h2>在此处新建</h2><kbd>esc</kbd>
      </header>
      <div className="canvas-create__materials">
        {renderSection("canvas-2d")}
        {actions.length > 0 ? <div className="canvas-create__grid canvas-create__shared" data-section="shared" data-bridge={groups.has("canvas-2d") && groups.has("scene-3d") || undefined}>
          {actions.map(renderItem)}
        </div> : null}
        {renderSection("scene-3d")}
        {[...groups].filter(([section]) => section !== "canvas-2d" && section !== "scene-3d").map(([section, items]) => renderSection(section, items))}
        {groups.size === 0 && actions.length === 0 ? <p className="canvas-create__empty">暂无可创建的操作</p> : null}
      </div>
      {footer.length > 0 ? <div className="canvas-create__footer">
        <div className="canvas-create__footer-actions">{footer.map(renderItem)}</div>
      </div> : null}
    </div>
  </Popover>;
}
