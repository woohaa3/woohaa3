import { useState } from "react";
import { Popover } from "@woohaa3/ui/primitives";
import { AssistantComposer } from "@woohaa3/ui/assistant";
import { TypeIcon, ImageIcon, FilmIcon, MusicIcon, BoxIcon, PluginIcon, PlusIcon, SearchIcon, UploadIcon } from "@woohaa3/ui/icons";
import type { CanvasContextMenuItem } from "./canvas-context-menu.js";
import { CANVAS_MENU_SECTION } from "@woohaa3/contracts";
import "./canvas-creation-popover.css";


const materialIcons = { "insert:text": TypeIcon, "insert:image": ImageIcon, "insert:video": FilmIcon, "insert:audio": MusicIcon, "insert:model3d": BoxIcon, upload: UploadIcon };
const sectionLabels: Record<string, string> = { "basic-material": "基础素材", "creation-tools": "创作工具", other: "其他" };

/** Only mounted for an ordinary blank context menu; no conversation is created by opening. */
export default function CanvasCreationPopover(props: { menuIdentity?: object; screen: { x: number; y: number }; world: { x: number; y: number }; items: readonly CanvasContextMenuItem[]; writable: boolean; onSelect(id: string): void; onClose(): void }) {
  const [search, setSearch] = useState("");
  const groups = new Map<string, CanvasContextMenuItem[]>();
  // 「其他」操作（上传等）不单独成段：并入最后一个素材 section，作为该行最右列的图标按钮。
  const actions: CanvasContextMenuItem[] = [];
  const query = search.trim().toLocaleLowerCase();
  const matchingItems = props.items.filter(item => !query || item.label.toLocaleLowerCase().includes(query));
  const iconFor = (item: CanvasContextMenuItem) => item.icon ?? materialIcons[item.id as keyof typeof materialIcons] ?? (item.id.startsWith("insert-template:") ? PluginIcon : PlusIcon);
  const isAction = (item: CanvasContextMenuItem) => (item.section ?? "other") === "other";
  for (const item of matchingItems) {
    const key = item.section ?? "other";
    if (key === "other") { actions.push(item); continue; }
    groups.set(key, [...groups.get(key) ?? [], item]);
  }
  const sections = [...groups];
  // 上传等操作固定在「基础素材」行末尾，与音频之间用浅色分隔线区分。
  const basicIndex = sections.findIndex(([section]) => section === CANVAS_MENU_SECTION.basicMaterial);
  const mergeIndex = basicIndex >= 0 ? basicIndex : Math.max(0, sections.length - 1);
  const sectionEntries: Array<readonly [string, CanvasContextMenuItem[]]> = sections.map(([section, items], index) =>
    [section, index === mergeIndex ? [...items, ...actions] : items] as const
  );
  if (sectionEntries.length === 0 && actions.length > 0) sectionEntries.push(["other", actions] as const);
  const renderItem = (item: CanvasContextMenuItem) => {
    const Icon = iconFor(item);
    return <button key={item.id} type="button" className={isAction(item) ? "canvas-create__grid-action" : undefined} disabled={item.disabled} title={item.reason ?? item.label} onClick={() => props.onSelect(item.id)}>
      <Icon /><span>{item.label}</span>
    </button>;
  };
  return <Popover open anchorPoint={props.screen} align="start" side="bottom" restoreFocus={false} className="canvas-create" testId="canvas-creation-popover" onOpenChange={open => { if (!open) props.onClose(); }}>
    <div onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={event => event.stopPropagation()}>
      <div className="canvas-create__input">
        <div className="canvas-create__field">
          <SearchIcon />
          <AssistantComposer rows={1} maxLength={20000} value={search} placeholder="搜索素材…" onChange={setSearch} onSubmit={() => undefined} />
        </div>
      </div>
      {sectionEntries.length > 0 ? <div className="canvas-create__materials">{sectionEntries.map(([section, items]) => <section key={section} data-section={section}>
        <h3>{sectionLabels[section] ?? section}</h3><div className="canvas-create__grid">{items.map(renderItem)}</div>
      </section>)}</div> : null}
    </div>
  </Popover>;
}
