import { useRef, useState, useSyncExternalStore } from "react";
import { useService } from "../../react.js";
import { Popover } from "../../../shared/ui/Popover.js";
import { AssistantComposer } from "../../ui/assistant-execution/composer.js";
import { FileTextIcon, ImageIcon, VideoIcon, MusicIcon, ProviderIcon, PluginIcon, PlusIcon, SparklesIcon, SearchIcon, ChevronRightIcon } from "../../../shared/ui/icons.js";
import type { CanvasContextMenuItem } from "./canvas-context-menu.js";
import { creationDraft, subscribeCreationDraft, creationDraftRevision, notifyCreationDraft } from "./canvas-creation-drafts.js";
import "./canvas-creation-popover.css";

import CanvasCreationAgent from "./canvas-creation-agent.js";

const materialIcons = { "insert:text": FileTextIcon, "insert:image": ImageIcon, "insert:video": VideoIcon, "insert:audio": MusicIcon, "insert:model3d": ProviderIcon };
const sectionLabels: Record<string, string> = { "basic-material": "基础素材", "creation-tools": "创作工具", other: "其他" };

/** Only mounted for an ordinary blank context menu; no conversation is created by opening. */
export default function CanvasCreationPopover(props: { menuIdentity?: object; screen: { x: number; y: number }; world: { x: number; y: number }; items: readonly CanvasContextMenuItem[]; writable: boolean; onSelect(id: string): void; onClose(): void }) {
  const remote = useService("applicationRemote");
  const scope = useService("canvasScope");
  const user = useService("currentUser");
  const session = useSyncExternalStore(user.subscribe, user.getSnapshot, user.getSnapshot);
  const canvasId = scope.canvasId();
  const namespace = session?.dataScopeId;
  const draft = creationDraft(remote.transport, namespace ?? "unresolved", canvasId);
  useSyncExternalStore(listener => subscribeCreationDraft(draft, listener), () => creationDraftRevision(draft));
  const [aiSelected, setAiSelected] = useState(false);
  const submitRef = useRef<(() => void) | null>(null);
  const edit = (patch: Partial<typeof draft>) => { Object.assign(draft, patch); draft.version++; notifyCreationDraft(draft); };
  const groups = new Map<string, CanvasContextMenuItem[]>();
  const query = draft.prompt.trim().toLocaleLowerCase();
  const matchingItems = props.items.filter(item => !query || item.label.toLocaleLowerCase().includes(query));
  const aiMode = aiSelected || Boolean(draft.pending) || Boolean(query && !matchingItems.length);
  for (const item of matchingItems) { const key = item.section ?? "other"; groups.set(key, [...groups.get(key) ?? [], item]); }
  return <Popover open anchorPoint={props.screen} align="start" side="bottom" restoreFocus={false} className="canvas-create" testId="canvas-creation-popover" onOpenChange={open => { if (!open) props.onClose(); }}>
    <div onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={event => event.stopPropagation()}>
      <div className="canvas-create__input">
        <div className="canvas-create__field">
          {aiMode ? <SparklesIcon /> : <SearchIcon />}
          <AssistantComposer rows={aiMode ? 3 : 1} maxLength={20000} value={draft.prompt} placeholder="搜索素材，或描述想创作的内容…" disabled={draft.busy} onChange={prompt => edit({ prompt })} onSubmit={() => { setAiSelected(true); submitRef.current?.(); }} />
        </div>
      </div>
      {!aiSelected && groups.size > 0 ? <div className="canvas-create__materials">{[...groups].map(([section, items]) => <section key={section} data-section={section}>
        <h3>{sectionLabels[section] ?? section}</h3><div className="canvas-create__grid">{items.map(item => {
          const Icon = item.icon ?? materialIcons[item.id as keyof typeof materialIcons] ?? (item.id.startsWith("insert-template:") ? PluginIcon : PlusIcon);
          return <button key={item.id} type="button" disabled={item.disabled} title={item.reason ?? item.label} onClick={() => props.onSelect(item.id)}><Icon /><span>{item.label}</span></button>;
        })}</div>
      </section>)}</div> : null}
      {!aiMode ? <button type="button" className="canvas-create__ai-entry" onClick={() => setAiSelected(true)}>
        <SparklesIcon /><span><strong>{query ? "让 AI 创作" : "用 AI 创作"}</strong><small>{query ? "用这段描述创建一组作品" : "例如：做一组咖啡品牌海报"}</small></span><ChevronRightIcon className="canvas-create__entry-arrow" />
      </button> :
        <CanvasCreationAgent menuIdentity={props.menuIdentity} world={props.world} writable={props.writable} onClose={props.onClose} submitRef={submitRef} />
      }
    </div>
  </Popover>;
}
