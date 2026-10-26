import { useRef, useState } from "react";
import { useService } from "../../react.js";
import { Popover } from "../../../shared/ui/Popover.js";
import { AssistantComposer } from "../../ui/assistant-execution/composer.js";
import { FileTextIcon, ImageIcon, VideoIcon, MusicIcon, ProviderIcon, PluginIcon, PlusIcon, SparklesIcon, SearchIcon, ChevronRightIcon } from "../../../shared/ui/icons.js";
import type { CanvasContextMenuItem } from "./canvas-context-menu.js";
import { planInsertNode } from "../../../extension-api/command-planner.js";
import { createWoohaa3CanvasNodeId } from "@woohaa3/contracts";
import "./canvas-creation-popover.css";


const materialIcons = { "insert:text": FileTextIcon, "insert:image": ImageIcon, "insert:video": VideoIcon, "insert:audio": MusicIcon, "insert:model3d": ProviderIcon };
const sectionLabels: Record<string, string> = { "basic-material": "基础素材", "creation-tools": "创作工具", other: "其他" };

/** Only mounted for an ordinary blank context menu; no conversation is created by opening. */
export default function CanvasCreationPopover(props: { menuIdentity?: object; screen: { x: number; y: number }; world: { x: number; y: number }; items: readonly CanvasContextMenuItem[]; writable: boolean; onSelect(id: string): void; onClose(): void }) {
  const edit = useService("canvasEdit");
  const session = useService("canvasSession");
  const runtime = useService("canvasRuntime");
  const navigation = useService("canvasNavigation");
  const scope = useService("canvasScope");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const createGroup = async () => {
    if (pending.current || !props.writable || !session.isWritable()) return;
    pending.current = true;
    setCreating(true);
    setNotice("");
    const canvasId = scope.canvasId();
    const nodeId = createWoohaa3CanvasNodeId("group");
    try {
      const result = await edit.record(planInsertNode({ nodeId, nodeType: "group", position: props.world, nodeData: {} }), "创建组");
      if (scope.canvasId() !== canvasId || navigation.getSnapshot().menu !== props.menuIdentity) return;
      if (!result.ok) { setNotice(result.reason ?? "创建组失败，请重试"); return; }
      runtime.controller()?.selectNode(nodeId);
      navigation.openPanel({ type: "model-node-editor", nodeId });
      props.onClose();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建组失败，请重试");
    } finally {
      pending.current = false;
      setCreating(false);
    }
  };
  const groups = new Map<string, CanvasContextMenuItem[]>();
  const query = search.trim().toLocaleLowerCase();
  const matchingItems = props.items.filter(item => !query || item.label.toLocaleLowerCase().includes(query));
  for (const item of matchingItems) { const key = item.section ?? "other"; groups.set(key, [...groups.get(key) ?? [], item]); }
  return <Popover open anchorPoint={props.screen} align="start" side="bottom" restoreFocus={false} className="canvas-create" testId="canvas-creation-popover" onOpenChange={open => { if (!open) props.onClose(); }}>
    <div onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={event => event.stopPropagation()}>
      <div className="canvas-create__input">
        <div className="canvas-create__field">
          <SearchIcon />
          <AssistantComposer rows={1} maxLength={20000} value={search} placeholder="搜索素材…" onChange={setSearch} onSubmit={() => undefined} />
        </div>
      </div>
      {groups.size > 0 ? <div className="canvas-create__materials">{[...groups].map(([section, items]) => <section key={section} data-section={section}>
        <h3>{sectionLabels[section] ?? section}</h3><div className="canvas-create__grid">{items.map(item => {
          const Icon = item.icon ?? materialIcons[item.id as keyof typeof materialIcons] ?? (item.id.startsWith("insert-template:") ? PluginIcon : PlusIcon);
          return <button key={item.id} type="button" disabled={item.disabled} title={item.reason ?? item.label} onClick={() => props.onSelect(item.id)}><Icon /><span>{item.label}</span></button>;
        })}</div>
      </section>)}</div> : null}
      <button type="button" className="canvas-create__ai-entry" disabled={!props.writable || creating} onClick={() => { void createGroup(); }}>
        <SparklesIcon /><span><strong>用 AI 创作</strong><small>创建组并开始创作</small></span><ChevronRightIcon className="canvas-create__entry-arrow" />
      </button>
      {notice ? <p className="canvas-create__notice">{notice}</p> : null}
    </div>
  </Popover>;
}
