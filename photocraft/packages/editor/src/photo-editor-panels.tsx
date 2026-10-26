import {HistorySnapshots} from "./history-snapshots.js";
import {useLayerScrollPosition} from "./use-layer-scroll-position.js";
import {useLayerDragScroll} from "./use-layer-drag-scroll.js";
import {IMAGE_PROJECT_LAYER_LABELS,LAYER_LABEL_NAMES} from "./layer-labels.js";
import {LayerBlendField,type LayerBlendEditing} from "./layer-blend-field.js";
import {LayerPercentField} from "./layer-percent-field.js";
import type {LayerVisibilityEditing} from "./use-layer-visibility-editing.js";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { Button, IconButton } from "./ui/Button.js";
import { Tooltip } from "./ui/Tooltip.js";
import { CursorMenu, DropdownMenu } from "./ui/Menu.js";
import { ADJUSTMENT_LAYER_ACTIONS } from "./photo-editor-layer-actions.js";
import { EyeIcon, EyeOffIcon, MaskIcon, PlusIcon, TrashIcon, UndoIcon, RedoIcon, LinkIcon, UnlinkIcon, CloseIcon, ClippingMaskIcon } from "./ui/icons.js";
import { commandShortcutLabel } from "./photo-editor-shortcuts.js";
import { LayerLayoutControls } from "./layer-layout-controls.js";
import { LayerThumbnail, type LayerThumbnailReader } from "./layer-thumbnail.js";
import { PHOTOSHOP_BLENDS, type EditorLayerRow, type EditorLayerLocks, type EditorViewModel } from "./editor-view-model.js";
import { AdjustmentIcon, LockIcon, FolderPlusIcon, ChevronDownIcon, ChevronRightIcon } from "./ui/icons.js";

import {BLEND_LABELS} from "./layer-blends.js";
export {BLEND_LABELS} from "./layer-blends.js";
const KIND_LABELS: Record<string, string> = { raster: "像素", group: "组", text: "文字", adjustment: "调整", pixel: "像素" };

/** 先结算再导航；移除输入框时产生的 blur 不重复提交。 */
function LayerNameField({layer,onRename,onFinish}:{layer:EditorLayerRow;onRename:(layer:EditorLayerRow,name:string)=>boolean|void;onFinish:(direction:number)=>void}) {
  const input=useRef<HTMLInputElement>(null),settled=useRef(false);
  const [value,setValue]=useState(layer.name);
  useEffect(()=>{input.current?.focus();input.current?.select();},[]);
  const finish=(commit:boolean,direction=0)=>{
    if(settled.current) return;
    const name=value || layer.name;
    if(commit && name!==layer.name && onRename(layer,name)===false) return;
    settled.current=true;onFinish(direction);
  };
  return <input ref={input} value={value} onChange={event=>setValue(event.currentTarget.value)}
    onBlur={()=>finish(true)} onKeyDown={event=>{
      if(event.nativeEvent.isComposing || event.keyCode===229) return;
      if(event.key!=="Enter" && event.key!=="Escape" && event.key!=="Tab") return;
      event.preventDefault();event.stopPropagation();
      finish(event.key!=="Escape",event.key==="Tab" ? event.shiftKey ? -1 : 1 : 0);
    }}/>;
}

/** 属性属于活动图层；选择集合与重排结果始终读取内核。 */
export function LayerPanel({ view, commands, readonly, onSelect, onToggleVisible, onBlend, onRename, onCommand, thumbnail, onMask, onAddMask, opacityEditing, collapseControl, styleEditor, blendEditing, visibilityEditing, onDelete, workspaceOwner, onEditContent, onEditStyle, onEditMask, onTrashMask,onFitLayer,reorderPreview }:  {
  onTrashMask?:(layer:number)=>void;
  /** 重排时在画布预览（I218）：候选只读，释放时的 layer.moveTo 才是唯一提交。 */
  reorderPreview?:{begin:()=>void;preview:(params:unknown)=>void;end:()=>void;enabled:boolean};
  onEditContent?:(layer:EditorLayerRow)=>void;
  onEditStyle?:(layer:EditorLayerRow)=>void;
  onEditMask?:(layer:EditorLayerRow)=>void;
  workspaceOwner?:object;
  onDelete?:(bypass:boolean)=>void;
  visibilityEditing?:LayerVisibilityEditing;
  blendEditing?:LayerBlendEditing;
  styleEditor?:ReactNode;
  collapseControl?:ReactNode;
  view: EditorViewModel;
  commands: ReadonlyMap<string, PhotocraftCommand>;
  readonly: boolean;
  onSelect: (layer: EditorLayerRow, mode: "replace" | "toggle" | "range") => void;
  onToggleVisible: (layer: EditorLayerRow, modifiers: {alt:boolean}) => void;
  onBlend: (layer: EditorLayerRow, blend: string) => void;
  onRename: (layer: EditorLayerRow, name: string) => boolean | void;
  onCommand: (id: string, params?: unknown) => void;
  thumbnail?: LayerThumbnailReader;
  onFitLayer?:(layer:EditorLayerRow)=>void;
  onMask?: (layer:EditorLayerRow,modifiers:{shift:boolean;alt:boolean}) => void;
  onAddMask: (invert:boolean) => void;
  opacityEditing:{value:string;fillValue?:string;updateFill?:(value:string)=>void;active:boolean;disabled:boolean;update:(value:string)=>void;finish:(commit:boolean)=>boolean};
}) {
  const sweep=useRef<{pointer:number;x:number;y:number;layer:number;visible:boolean;ids:number[];started:boolean}|null>(null);
  const [sweepView,setSweepView]=useState<{ids:number[];visible:boolean}|null>(null);
  const suppressEyeClick=useRef(false);
  const sweepPort=useRef(visibilityEditing);sweepPort.current=visibilityEditing;
  const finishSweep=(commit:boolean)=>{
    const current=sweep.current;sweep.current=null;setSweepView(null);
    if(current?.started) sweepPort.current?.finish(commit);
  };
  useEffect(()=>{
    const cancel=()=>finishSweep(false);
    window.addEventListener("blur",cancel);
    return ()=>{window.removeEventListener("blur",cancel);if(sweep.current?.started) sweepPort.current?.finish(false);};
  },[]);
  useEffect(()=>{if(readonly || (sweep.current?.started && visibilityEditing?.active===false)) finishSweep(false);},[readonly,visibilityEditing?.active]);
  const [renaming, setRenaming] = useState<number | null>(null);
  const dragging = useRef<number[] | null>(null);
  const draggingMask=useRef<number|null>(null);
  const list=useRef<HTMLUListElement>(null);
  const dragScroll=useLayerDragScroll(list,readonly || renaming!==null);
  const revealed=useRef<string|null>(null);
  const pendingReveal=useRef<number|null>(null);
  const [context,setContext]=useState<{x:number;y:number;selection:string}|null>(null);
  const [footerDrop,setFooterDrop]=useState<string|null>(null);
  const [clipLine,setClipLine]=useState<{upper:number;lower:number;release:boolean}|null>(null);
  useEffect(()=>{const clear=()=>setClipLine(null);const key=(event:KeyboardEvent)=>{if(event.key==="Alt" || event.key==="Escape") clear();};window.addEventListener("blur",clear);window.addEventListener("keyup",key);return ()=>{window.removeEventListener("blur",clear);window.removeEventListener("keyup",key);};},[]);
  const [drop, setDrop] = useState<{layer:number;position:"above"|"below"|"into"}|null>(null);
  const layers = view.document?.layers ?? [];
  const byId = new Map(layers.map(layer => [layer.id, layer]));
  const ancestors = (layer: EditorLayerRow) => {
    const parents: EditorLayerRow[] = [];
    let parent = layer.parentId;
    for (let depth = 0; parent != null && depth < 16; depth++) {
      const row = byId.get(parent); if (!row) break;
      parents.push(row); parent = row.parentId;
    }
    return parents;
  };
  // 图层列表筛选（I177）：只影响面板显示，选择集合与文档内容都由内核拥有。
  const [filterKind,setFilterKind]=useState<string>("all");
  const [filterQuery,setFilterQuery]=useState<string>("");
  const matchedNames=new Set(layers.filter(layer=>filterQuery.trim()==="" || layer.name.toLocaleLowerCase().includes(filterQuery.trim().toLocaleLowerCase())).map(layer=>layer.id));
  // 名称筛选命中某行时，它的祖先仍要显示，否则命中的子行会被折叠隐藏。
  const nameVisible=(layer:EditorLayerRow):boolean => matchedNames.has(layer.id) || layers.some(child=>child.parentId===layer.id && nameVisible(child));
  const kindMatches=(layer:EditorLayerRow)=>filterKind==="all" || layer.kind===filterKind;
  const filtered=(layer:EditorLayerRow)=> kindMatches(layer) && nameVisible(layer);
  const isolated=view.document?.isolatedLayerIds??[];
  const isolationShows=(layer:EditorLayerRow)=>!isolated.length || isolated.includes(layer.id) || layers.some(child=>isolated.includes(child.id) && ancestors(child).some(parent=>parent.id===layer.id));
  const displayed = layers.filter(layer => filtered(layer) && isolationShows(layer) && ancestors(layer).every(parent => parent.expanded));
  const clippingAt=(event:{altKey:boolean;clientX:number;clientY:number})=>{
    if(!event.altKey || readonly || renaming!==null || dragging.current || draggingMask.current!==null || !commands.get("layer.toggleClippingAt")?.allowed || !commands.get("layer.toggleClippingAt")?.enabled) return null;
    for(let index=1;index<displayed.length;index++) {
      const upper=displayed[index-1],lower=displayed[index];
      if(upper.parentId!==lower.parentId || (upper.kind==="group" && upper.expanded && layers.some(child=>child.parentId===upper.id))) continue;
      const siblings=layers.filter(row=>row.parentId===upper.parentId);
      if(siblings.indexOf(upper)+1!==siblings.indexOf(lower)) continue;
      const row=list.current?.querySelector<HTMLElement>(`[data-layer-id="${lower.id}"]`);if(!row) continue;
      const bounds=row.getBoundingClientRect();
      if(event.clientX>=bounds.left+30 && event.clientX<bounds.right-28 && event.clientY>=bounds.top-3.5 && event.clientY<=bounds.top+5) return {upper:upper.id,lower:lower.id,release:upper.clipped};
    }
    return null;
  };
  const active = layers.find((layer) => layer.active);
  const saveScroll=useLayerScrollPosition(list,workspaceOwner,view.sessionActiveIndex,displayed.length,()=>{
    revealed.current=active ? `${view.sessionActiveIndex}:${active.id}` : null;pendingReveal.current=null;
  });
  const blends: readonly string[] = active?.kind === "group" ? ["Pass Through", ...PHOTOSHOP_BLENDS] : PHOTOSHOP_BLENDS;
  const clippingCommand=active?.clipped ? "layer.releaseClippingMask" : "layer.createClippingMask";
  const adjustments = ADJUSTMENT_LAYER_ACTIONS.filter(({ id }) => commands.get(id)?.allowed);
  const selected=layers.filter(layer=>layer.selected || layer.active);
  const selectionKey=selected.map(layer=>layer.id).sort((a,b)=>a-b).join(",");
  const canHide=!readonly && commands.get("layer.hideLayers")?.allowed===true && commands.get("layer.hideLayers")?.enabled===true;
  const convertBackground=(layer:EditorLayerRow)=>{
    if(!readonly && layer.background && commands.get("layer.new.layerFromBackground")?.allowed && commands.get("layer.new.layerFromBackground")?.enabled) onCommand("layer.new.layerFromBackground",{layer:layer.id});
  };
  const lockControls = [
    ["transparency","透明像素"], ["pixels","像素"], ["position","位置"], ["all","全部"]
  ] as const;
  const canReorder = !readonly && renaming === null && commands.get("layer.moveTo")?.allowed === true && commands.get("layer.moveTo")?.enabled === true;
  const loadThumbnail=(layer:EditorLayerRow,event:{ctrlKey:boolean;metaKey:boolean;shiftKey:boolean;altKey:boolean},mask=false)=>{
    if(!(event.ctrlKey || event.metaKey) || (!mask && layer.background)) return false;
    if(readonly) return true;
    const command=commands.get("select.loadSelection");
    if(command?.allowed && command.enabled) onCommand("select.loadSelection",{layer:layer.id,channel:mask?"mask":"transparency",operation:event.shiftKey?event.altKey?"intersect":"add":event.altKey?"subtract":"new"});
    return true;
  };
  const select = (layer:EditorLayerRow,event:{shiftKey:boolean;ctrlKey:boolean;metaKey:boolean},content=false) => {
    if(content && layer.background && (event.ctrlKey || event.metaKey)) {onSelect(layer,"replace");return;}
    if(!content && layer.active && layer.kind==="adjustment" && layer.hasMask && !event.shiftKey && !event.ctrlKey && !event.metaKey && onMask) {onMask(layer,{shift:false,alt:false});return;}
    onSelect(layer,event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "replace");
  };
  const clearDrag = () => {dragScroll.stop();draggingMask.current=null;dragging.current=null;setDrop(null);setFooterDrop(null);reorderPreview?.end();};
  const positionAt = (layer: EditorLayerRow, row: HTMLElement, y: number): "above" | "below" | "into" => {
    const rect = row.getBoundingClientRect();
    if (layer.kind === "group" && y >= rect.top + rect.height * .25 && y <= rect.top + rect.height * .75) return "into";
    return y < rect.top + rect.height / 2 ? "above" : "below";
  };
  const acceptsDrop = (layer: EditorLayerRow, copy=false) => canReorder && dragging.current && (copy || !dragging.current.includes(layer.id))
    && !ancestors(layer).some(parent => dragging.current!.includes(parent.id));
  const draggable = (layer:EditorLayerRow) => canReorder && !(layer.selected || layer.active ? selected : [layer]).some(row=>row.effectiveLocks.all);
  const renameNext = (layer:EditorLayerRow,direction:number) => {
    const next=direction ? displayed[displayed.findIndex(row=>row.id===layer.id)+direction] : undefined;
    setRenaming(next && !next.background ? next.id : null);
  };
  useEffect(()=>{if (readonly || renaming!==null) {dragScroll.stop();dragging.current=null;draggingMask.current=null;setDrop(null);setFooterDrop(null);} if(readonly) setRenaming(null);},[readonly,renaming]);
  useEffect(()=>{if(readonly || renaming!==null || (context && context.selection!==selectionKey)) setContext(null);},[readonly,renaming,selectionKey,context]);
  // 只跟随活动目标变化；同一目标的手动折叠和手动滚动保持原样。
  useEffect(()=>{
    const key=active ? `${view.sessionActiveIndex}:${active.id}` : null;
    if(key!==revealed.current) {revealed.current=key;pendingReveal.current=active?.id ?? null;}
    if(!active || pendingReveal.current!==active.id) return;
    const closed=ancestors(active).filter(parent=>!parent.expanded);
    if(closed.length) {
      if(!readonly && commands.get("layer.setExpanded")?.allowed && commands.get("layer.setExpanded")?.enabled)
        closed.reverse().forEach(parent=>onCommand("layer.setExpanded",{layer:parent.id,expanded:true}));
      return;
    }
    const viewport=list.current,row=viewport?.querySelector<HTMLElement>(`[data-layer-id="${active.id}"]`);
    if(!viewport || !row) return;
    const bounds=viewport.getBoundingClientRect(),target=row.getBoundingClientRect();
    if(target.top<bounds.top) viewport.scrollTop+=target.top-bounds.top;
    else if(target.bottom>bounds.bottom) viewport.scrollTop+=target.bottom-bounds.bottom;
    pendingReveal.current=null;
  });
  return (
    <section className="photo-editor__panel photo-editor__panel--layers" onKeyDownCapture={event=>{
      if(sweep.current?.started && event.key==="Escape") {event.preventDefault();event.stopPropagation();finishSweep(false);}
    }}>
      <header className="photo-editor__panel-title"><span>{collapseControl}图层</span><span>{layers.filter(layer=>layer.selected).length > 1 ? `已选 ${layers.filter(layer=>layer.selected).length} / ${layers.length}` : layers.length}</span></header>
      <div className="photo-editor__layer-filter" data-layer-filter="true">
        <label>种类<select value={filterKind} onChange={event=>setFilterKind(event.currentTarget.value)}>
          <option value="all">全部</option><option value="raster">像素</option><option value="text">文字</option>
          <option value="adjustment">调整</option><option value="group">组</option><option value="smart">智能对象</option>
        </select></label>
        <label>名称<input type="search" value={filterQuery} placeholder="筛选图层名" onChange={event=>setFilterQuery(event.currentTarget.value)}/></label>
        {filterKind!=="all" || filterQuery.trim()!==""?<span className="photo-editor__layer-filter-hint">显示 {displayed.length} / {layers.length}</span>:null}
      </div>
      {isolated.length ? <Button size="sm" tone="ghost" disabled={readonly} onClick={()=>onCommand("select.isolateLayers",{on:false})}>退出图层隔离</Button>:null}
      <div className="photo-editor__layer-properties">
        {blendEditing ? <LayerBlendField value={active?.blend??"Normal"} options={blends} owner={workspaceOwner} target={active?.id}
          disabled={opacityEditing.disabled || !active || selected.some(layer=>layer.effectiveLocks.all)} editing={blendEditing}/> : (
        <select value={active?.blend ?? "Normal"} disabled={readonly || !active || active.effectiveLocks.all} title="混合模式"
          onChange={(event) => active && onBlend(active, event.currentTarget.value)}>
          {blends.map((blend) => <option key={blend} value={blend}>{BLEND_LABELS[blend]}</option>)}
          {active && !blends.includes(active.blend) ? <option value={active.blend}>{active.blend}</option> : null}
        </select>
        )}
        <span data-layer-opacity><LayerPercentField label="不透明度" value={opacityEditing.value}
          disabled={opacityEditing.disabled || !active || selected.some(layer=>layer.effectiveLocks.all)}
          update={opacityEditing.update} finish={opacityEditing.finish}/></span>
        {opacityEditing.updateFill ? <span data-layer-fill><LayerPercentField label="填充" value={opacityEditing.fillValue ?? "100"}
          disabled={opacityEditing.disabled || !active || selected.some(layer=>layer.effectiveLocks.all)}
          update={opacityEditing.updateFill} finish={opacityEditing.finish}/></span> : null}
        {opacityEditing.active ? <>
          <Button size="sm" disabled={opacityEditing.disabled} onClick={()=>opacityEditing.finish(true)}>确认属性</Button>
          <Button size="sm" tone="ghost" onPointerDown={(event)=>{event.preventDefault();opacityEditing.finish(false);}} onClick={()=>opacityEditing.finish(false)}>取消属性</Button>
        </> : null}
      </div>
      {styleEditor}
      <div className="photo-editor__layer-locks">
        <span>锁定</span>
        {lockControls.map(([key,label])=>{
          const on=selected.length>0 && selected.every(layer=>layer.locks[key]);
          const mixed=!on && selected.some(layer=>layer.locks[key]);
          return <Button key={key} size="sm" tone="ghost" data-lock={key} data-lock-state={mixed ? "mixed" : on ? "on" : "off"}
            disabled={readonly || selected.length===0 || !commands.get("layer.lockLayers")?.allowed || !commands.get("layer.lockLayers")?.enabled || (key!=="all" && selected.some(layer=>layer.effectiveLocks.all))}
            title={`${on ? "取消锁定" : "锁定"}${label}${mixed ? "（部分已锁定）" : ""}`} onClick={()=>onCommand("layer.lockLayers",{[key]:!on})}>
            <LockIcon size={13}/><span className="photo-editor__lock-label">{label}</span>
          </Button>;
        })}
      </div>
      <LayerLayoutControls commands={commands} readonly={readonly} hasSelection={view.document?.hasSelection ?? false} onCommand={onCommand} />
      {layers.length === 0 ? <p className="photo-editor__panel-empty">打开图片后，图层会显示在这里。</p> : null}
      <ul ref={list} className="photo-editor__layers" onScroll={()=>{saveScroll();setClipLine(null);}}
      onPointerMove={event=>{const next=clippingAt(event);setClipLine(current=>current?.upper===next?.upper && current?.lower===next?.lower && current?.release===next?.release?current:next);}}
      onPointerLeave={()=>setClipLine(null)}
      onClickCapture={event=>{const line=clippingAt(event);if(!line) return;event.preventDefault();event.stopPropagation();setClipLine(null);onCommand("layer.toggleClippingAt",{upper:line.upper,lower:line.lower});}} onClick={event=>{
        if(event.target===event.currentTarget && !readonly && commands.get("select.deselectLayers")?.allowed && commands.get("select.deselectLayers")?.enabled) onCommand("select.deselectLayers");
      }} onDragOver={event=>{if(canReorder && dragging.current) dragScroll.move(event.clientY);}}
      onDragLeave={(event)=>{
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {setDrop(null);}
      }}>
        {displayed.map((layer) => {
          const visible=sweepView?.ids.includes(layer.id) ? sweepView.visible : layer.visible;
          const maskActive=layer.active && view.document?.editTarget === "mask";
          return (
            <li key={layer.id} className={`photo-editor__layer${layer.selected || layer.active ? " photo-editor__layer--selected" : ""}${layer.active ? " photo-editor__layer--active" : ""}`}
              data-layer-id={layer.id} data-clip-line={clipLine?.lower===layer.id && !readonly ? clipLine.release?"release":"create":undefined} title={clipLine?.lower===layer.id ? clipLine.release?"Alt/Option 点击释放上方剪贴链":"Alt/Option 点击创建上方剪贴蒙版":undefined} data-layer-label={layer.labelColor ?? "none"} data-drop-position={canReorder && drop?.layer===layer.id ? drop.position : undefined}
              onClick={event=>{
                if(readonly || (event.target as Element).closest("button,input,select,textarea")) return;
                select(layer,event);
              }}
              onDoubleClick={event=>{
                if(layer.background && !(event.target as Element).closest("input, [data-edit-target=mask]")) convertBackground(layer);
                else if(!readonly && !(event.target as Element).closest("button,input,select,textarea")) onEditStyle?.(layer);
              }}
              onContextMenu={event=>{
                event.stopPropagation();
                if((event.target as Element).closest("input,textarea")) return;
                event.preventDefault();
                if(readonly || renaming!==null || dragging.current || !(commands.get("layer.hideLayers")?.allowed || commands.get("layer.setLabelColor")?.allowed || commands.get("layer.rasterize.type")?.allowed)) {setContext(null);return;}
                if(!layer.selected && !layer.active) onSelect(layer,"replace");
                setContext({x:event.clientX,y:event.clientY,selection:layer.selected || layer.active ? selectionKey : String(layer.id)});
              }}
              draggable={draggable(layer)}
              onDragStart={event=>{
                const control=(event.target as Element).closest("button,input,select,textarea");
                if(!draggable(layer) || (control && !control.matches(".photo-editor__layer-name, [data-edit-target=pixels]"))) {event.preventDefault();return;}
                const selectedIds=selected.map(row=>row.id);
                const ids=selectedIds.includes(layer.id) ? selectedIds : [layer.id];
                if(!selectedIds.includes(layer.id)) onSelect(layer,"replace");
                dragging.current=ids;event.dataTransfer.effectAllowed="copyMove";
                event.dataTransfer.setData("application/x-woohaa-image-layers",ids.join(","));
                if(reorderPreview?.enabled) reorderPreview.begin();
              }} onDragEnd={clearDrag}
              onDragOver={(event)=>{
                if (!acceptsDrop(layer,event.altKey)) { setDrop(null); return; }
                const position = positionAt(layer,event.currentTarget,event.clientY);
                if(position==="into" && dragging.current?.includes(layer.id)) {setDrop(null);return;}
                if ((position === "into" ? layer.effectiveLocks.all : ancestors(layer)[0]?.effectiveLocks.all)) { setDrop(null); return; }
                event.preventDefault();event.dataTransfer.dropEffect=event.altKey ? "copy" : "move";
                setDrop({layer:layer.id,position});
                // 面板落点提示与画布候选合成同步：Alt 复制不预览（副本位置在释放后才确定）。
                if(!event.altKey && reorderPreview?.enabled) reorderPreview.preview({layers:dragging.current,target:layer.id,position});
              }}
              onDrop={(event)=>{
                const ids=dragging.current;
                const accepted=acceptsDrop(layer,event.altKey);
                const position=positionAt(layer,event.currentTarget,event.clientY);
                clearDrag();
                if (!accepted || !ids || (position==="into" && ids.includes(layer.id)) || (position === "into" ? layer.effectiveLocks.all : ancestors(layer)[0]?.effectiveLocks.all)) return;
                event.preventDefault();event.stopPropagation();
                onCommand("layer.moveTo",{layers:ids,target:layer.id,position,...(event.altKey ? {copy:true} : {})});
              }}
              style={{ paddingLeft: `${6 + layer.depth * 16}px` }}>
              <IconButton size="sm" label={visible ? "隐藏图层" : "显示图层"} title={`${visible ? "隐藏图层" : "显示图层"}；Alt/Option 独显，按住拖过多行统一显隐`}
                disabled={readonly}
                onPointerDown={event=>{
                  suppressEyeClick.current=false;
                  if(readonly || event.button!==0 || event.altKey || !visibilityEditing) return;
                  sweep.current={pointer:event.pointerId,x:event.clientX,y:event.clientY,layer:layer.id,visible:!layer.visible,ids:[layer.id],started:false};
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerMove={event=>{
                  const current=sweep.current;if(!current || current.pointer!==event.pointerId) return;
                  if(!current.started) {
                    if(Math.hypot(event.clientX-current.x,event.clientY-current.y)<2) return;
                    suppressEyeClick.current=true;
                    if(!visibilityEditing?.begin(current.layer)) {sweep.current=null;return;}
                    current.started=true;
                  }
                  const low=Math.min(current.y,event.clientY),high=Math.max(current.y,event.clientY);
                  list.current?.querySelectorAll<HTMLElement>("[data-layer-id]").forEach(row=>{
                    const bounds=row.getBoundingClientRect(),id=Number(row.dataset.layerId);
                    if(bounds.bottom>low && bounds.top<=high && !current.ids.includes(id)) current.ids.push(id);
                  });
                  current.y=event.clientY;
                  const ids=[...current.ids];setSweepView({ids,visible:current.visible});visibilityEditing?.preview(ids,current.visible);
                  event.preventDefault();event.stopPropagation();
                }}
                onPointerUp={event=>{if(sweep.current?.pointer===event.pointerId) finishSweep(true);}}
                onPointerCancel={()=>finishSweep(false)}
                onLostPointerCapture={()=>finishSweep(false)}
                onClick={event => {if(suppressEyeClick.current) {suppressEyeClick.current=false;return;}onToggleVisible(layer,{alt:event.altKey});}}>{visible ? <EyeIcon size={15} /> : <EyeOffIcon size={15} />}</IconButton>
              {layer.kind === "group" ? <IconButton size="sm" className="photo-editor__group-disclosure" label={layer.expanded ? "折叠组" : "展开组"}
                title={`${layer.expanded ? "折叠组" : "展开组"}；Alt/Option 同时切换所有组`}
                disabled={readonly || !commands.get("layer.setExpanded")?.enabled || !commands.get("layer.setExpanded")?.allowed}
                onClick={(event)=>onCommand("layer.setExpanded",{layer:layer.id,expanded:!layer.expanded,...(event.altKey ? {all:true} : {})})}>
                {layer.expanded ? <ChevronDownIcon size={12}/> : <ChevronRightIcon size={12}/>}
              </IconButton> : <span className="photo-editor__group-disclosure-space"/>}
              {layer.clipped ? <span className="photo-editor__clipping-indicator" title="剪贴到下方基底"><ClippingMaskIcon size={13} /></span> : null}
              <button type="button" className="photo-editor__layer-thumbnail" data-edit-target="pixels" data-target-active={layer.active && !maskActive ? "true" : undefined} disabled={readonly} onClick={(event) => {if(event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && onFitLayer){onFitLayer(layer);return;}if(!loadThumbnail(layer,event)) select(layer,event,true);}} onDoubleClick={event=>{
                event.stopPropagation();if(layer.background) convertBackground(layer);else if(!readonly) {if(layer.kind==="text" || layer.kind==="adjustment") onEditContent?.(layer);else onEditStyle?.(layer);}
              }} title={`${layer.name}：编辑内容；Shift 范围选择，Ctrl/Cmd 载入透明度选区（Shift 添加，Alt/Option 减去）`}>
                <LayerThumbnail layer={layer.id} revision={view.document?.revision ?? 0} read={thumbnail} />
              </button>
              {layer.hasMask ? <>
                <IconButton size="sm" label={layer.maskLinked ? "取消链接蒙版" : "链接蒙版"} disabled={readonly || !commands.get("layer.layerMask.linked")?.allowed}
                  onClick={() => onCommand("layer.layerMask.linked",{layer:layer.id,linked:!layer.maskLinked})}>{layer.maskLinked ? <LinkIcon size={12} /> : <UnlinkIcon size={12} />}</IconButton>
                <button type="button" className="photo-editor__layer-thumbnail photo-editor__mask-thumbnail" data-edit-target="mask" data-target-active={maskActive ? "true" : undefined}
                  draggable={!readonly && !!commands.get("layer.layerMask.delete")?.allowed && !!commands.get("layer.layerMask.delete")?.enabled}
                  onDragStart={event=>{
                    event.stopPropagation();if(readonly || !commands.get("layer.layerMask.delete")?.allowed || !commands.get("layer.layerMask.delete")?.enabled) {event.preventDefault();return;}
                    dragging.current=null;draggingMask.current=layer.id;event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("application/x-photocraft-layer-mask",String(layer.id));onMask?.(layer,{shift:false,alt:false});
                  }} onDragEnd={event=>{event.stopPropagation();clearDrag();}}
                  data-mask-enabled={String(layer.maskEnabled)} data-mask-view={view.document?.maskView === layer.id ? "true" : undefined} disabled={readonly}
                  onDoubleClick={event=>{event.stopPropagation();if(!readonly) onEditMask?.(layer);}} title={`${layer.name}：编辑蒙版；Shift 启停，Alt/Option 单独查看`} onClick={(event) => {if(!loadThumbnail(layer,event,true)) onMask?.(layer,{shift:event.shiftKey,alt:event.altKey});}}>
                  <LayerThumbnail layer={layer.id} mask revision={view.document?.revision ?? 0} read={thumbnail} />
                  {!layer.maskEnabled ? <span className="photo-editor__mask-disabled"><CloseIcon size={24} /></span> : null}
                </button>
              </> : null}
              {renaming === layer.id ? (
                <LayerNameField key={layer.id} layer={layer} onRename={onRename} onFinish={direction=>renameNext(layer,direction)}/>
              ) : (
                <button type="button" className="photo-editor__layer-name" disabled={readonly} onClick={(event) => select(layer,event)} onDoubleClick={() => {
                  if(!layer.background) setRenaming(layer.id);
                }} draggable={draggable(layer)}>
                  <span>{layer.name}</span><small>{KIND_LABELS[layer.kind] ?? layer.kind}{layer.hasEffects ? " · 样式" : ""}</small>
                </button>
              )}
              {layer.linkGroup!=null ? <span title="图层已链接"><LinkIcon size={12}/></span>:null}
              {layer.blend!=="Normal" && layer.blend!=="Pass Through" ? <span className="photo-editor__layer-blend" title={`混合模式：${BLEND_LABELS[layer.blend] ?? layer.blend}`}>{BLEND_LABELS[layer.blend] ?? layer.blend}</span> : null}
              {Object.values(layer.effectiveLocks).some(Boolean) ? <IconButton size="sm" label="解锁图层" title={`${layer.name}：${lockControls.filter(([key])=>layer.effectiveLocks[key]).map(([,label])=>label).join("、")}已锁定`}
                disabled={readonly || !commands.get("layer.setProps")?.allowed || !Object.values(layer.locks).some(Boolean)}
                onClick={()=>{
                  if(layer.background) convertBackground(layer);
                  else onCommand("layer.setProps",{layer:layer.id,locks:{transparency:false,pixels:false,position:false,artboard:false,all:false} satisfies EditorLayerLocks});
                }}><LockIcon size={13}/></IconButton> : null}
            </li>
          );
        })}
      </ul>
      {context ? <CursorMenu open={!readonly && context.selection===selectionKey && !!(commands.get("layer.hideLayers")?.allowed || commands.get("layer.setLabelColor")?.allowed || commands.get("layer.rasterize.type")?.allowed)}
        x={context.x} y={context.y} label="图层操作" onOpenChange={open=>{if(!open) setContext(null);}}
        items={[
          ...(commands.get("layer.hideLayers")?.allowed ? [{id:"layer.hideLayers",label:selected.every(layer=>!layer.visible) ? "显示所选图层" : "隐藏所选图层",disabled:!canHide,
            onSelect:()=>{setContext(null);if(canHide && context.selection===selectionKey) onCommand("layer.hideLayers");}}] : []),
          ...(commands.get("layer.setLabelColor")?.allowed ? [{id:"labels",label:"图层颜色",disabled:!commands.get("layer.setLabelColor")?.enabled,onSelect:()=>{},children:IMAGE_PROJECT_LAYER_LABELS.map(color=>({id:`label-${color}`,label:LAYER_LABEL_NAMES[color],selected:selected.length>0 && selected.every(layer=>(layer.labelColor??"none")===color),onSelect:()=>{setContext(null);if(!readonly && context.selection===selectionKey && commands.get("layer.setLabelColor")?.allowed && commands.get("layer.setLabelColor")?.enabled) onCommand("layer.setLabelColor",{color});}}))}] : []),
          ...[ ["layer.rasterize.type","栅格化文字"],["layer.linkLayers","链接 / 取消链接图层"],["layer.selectLinkedLayers","选择链接图层"],["layer.lockLayers","锁定图层…"] ].filter(([id])=>commands.get(id)?.allowed).map(([id,label])=>({id,label,disabled:!commands.get(id)?.enabled,onSelect:()=>{setContext(null);if(!readonly && context.selection===selectionKey && commands.get(id)?.allowed && commands.get(id)?.enabled) onCommand(id);}}))
        ]}/> : null}
      <div className="photo-editor__layer-actions">
        {commands.get("layer.linkLayers")?.allowed ? <IconButton size="sm" label="链接或取消链接图层" disabled={readonly || !commands.get("layer.linkLayers")?.enabled} onClick={()=>onCommand("layer.linkLayers")}><LinkIcon size={16}/></IconButton>:null}
        {commands.get(clippingCommand)?.allowed ? <Button size="sm" tone="ghost" className="photo-editor__clipping-action"
          title={commands.get(clippingCommand)?.disabledReason || `创建或释放剪贴蒙版（${commandShortcutLabel(clippingCommand)}）`}
          disabled={readonly || !active || !commands.get(clippingCommand)?.enabled}
          onClick={()=>onCommand(clippingCommand)}><ClippingMaskIcon size={14} />{active?.clipped ? "释放剪贴" : "创建剪贴"}</Button> : null}
        {commands.get("layer.layerMask.revealAll")?.allowed ? <Tooltip content={active?.hasMask ? "已有蒙版；请先删除或应用" : "添加蒙版；Alt/Option 反向"}>
          <IconButton size="sm" label="添加蒙版" disabled={readonly || !active || active.hasMask || !commands.get(view.document?.hasSelection ? "layer.layerMask.revealSelection" : "layer.layerMask.revealAll")?.enabled}
            onClick={(event) => onAddMask(event.altKey)}><MaskIcon size={16} /></IconButton>
        </Tooltip> : null}
        {adjustments.length ? <DropdownMenu label="新建调整层" side="top" align="end"
          trigger={<IconButton size="sm" label="新建调整层" title="新建调整层"
            disabled={readonly || !adjustments.some(({ id }) => commands.get(id)?.enabled)}><AdjustmentIcon size={16} /></IconButton>}
          items={adjustments.map(({ id, label }) => ({ id, label, disabled: readonly || !commands.get(id)?.enabled, onSelect: id=>onCommand(id) }))}
        /> : null}
        {[
          { id: "layer.new.group", label: "新建组", Icon: FolderPlusIcon, needsLayer: false },
          { id: "layer.new.layer", label: "新建图层", Icon: PlusIcon, needsLayer: false },
          { id: "layer.delete", label: "删除图层", Icon: TrashIcon, needsLayer: true }
        ].filter(({ id }) => commands.get(id=== "layer.delete" && view.document?.editTarget==="mask" ? "layer.layerMask.delete" : id)?.allowed).map(({ id, label, Icon, needsLayer }) => {
          const action=id==="layer.delete" && view.document?.editTarget==="mask" ? "layer.layerMask.delete" : id==="layer.new.group" && selected.length>1 ? "layer.groupLayers" : id;
          const dropAction=id==="layer.new.layer" ? "layer.duplicate" : id==="layer.new.group" ? "layer.groupLayers" : id;
          const acceptsMask=()=>id==="layer.delete" && !readonly && !!onTrashMask && draggingMask.current!==null && active?.id===draggingMask.current && !!active.hasMask && view.document?.editTarget==="mask" && !!commands.get("layer.layerMask.delete")?.allowed && !!commands.get("layer.layerMask.delete")?.enabled;
          const acceptsFooter=()=>canReorder && !!dragging.current && dragging.current.slice().sort((a,b)=>a-b).join(",")===selectionKey
            && commands.get(dropAction)?.allowed===true && commands.get(dropAction)?.enabled===true;
          return <Tooltip key={id} content={label}><IconButton size="sm" label={label}
            data-drop-action={footerDrop===id ? acceptsMask()?"layer.layerMask.delete":dropAction : undefined}
            onDragOver={event=>{if(!acceptsFooter() && !acceptsMask()) return;event.preventDefault();event.dataTransfer.dropEffect=id==="layer.new.layer" ? "copy" : "move";setDrop(null);setFooterDrop(id);}}
            onDragLeave={()=>setFooterDrop(null)}
            onDrop={event=>{const mask=acceptsMask()?draggingMask.current:null,accepted=acceptsFooter();clearDrag();if(mask!==null) {event.preventDefault();event.stopPropagation();onTrashMask?.(mask);return;}if(!accepted) return;event.preventDefault();event.stopPropagation();if(dropAction==="layer.delete" && onDelete) onDelete(event.altKey);else onCommand(dropAction);}}
            disabled={readonly || !commands.get(action)?.allowed || !commands.get(action)?.enabled || (needsLayer && !active)} onClick={event => {
            if(id==="layer.delete" && onDelete) {onDelete(event.altKey);return;}
            const target=id==="layer.new.group" && (selected.length>1 || (event.shiftKey && selected.length>0)) ? "layer.groupLayers" : id;
            if(commands.get(target)?.allowed && commands.get(target)?.enabled) onCommand(target,...(target==="layer.new.layer" && !event.altKey ? [{...(event.ctrlKey || event.metaKey ? {position:"below"} : {})}] : []));
          }}><Icon size={16} /></IconButton></Tooltip>;
        })}
      </div>
    </section>
  );
}

/** 本次编辑的操作历史；节点已保存版本仍从公共顶栏「历史」进入。 */
export function HistoryPanel({ view, readonly, onUndo, onRedo, onGoTo, collapseControl,commands,onHistoryCommand }: {
  collapseControl?:ReactNode;
  view: EditorViewModel;
  readonly: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onGoTo: (index: number) => void;
  commands?:ReadonlyMap<string,PhotocraftCommand>;
  onHistoryCommand?:(id:string,params:unknown)=>boolean;
}) {
  const documentView = view.document;
  const history = documentView?.history ?? [];
  const redoHistory = documentView?.redoHistory ?? [];
  const current = history.length - 1;
  const historyList=useRef<HTMLOListElement>(null),lastFollow=useRef<string|null>(null),skipFollow=useRef<string|null>(null);
  const [,snapshotSelectionChanged]=useState(0),historyOwner=String(documentView?.documentKey??view.sessionActiveIndex);
  const followKey=JSON.stringify([documentView?.documentKey??view.sessionActiveIndex,documentView?.historyFollowKey,current,history.at(-1),redoHistory.length]);
  useLayoutEffect(()=>{
    const changed=lastFollow.current!==followKey;lastFollow.current=followKey;
    const skip=skipFollow.current===historyOwner;skipFollow.current=null;
    if(!changed || skip)return;
    const list=historyList.current,row=list?.querySelector<HTMLElement>(".is-current");if(!list || !row || list.clientHeight<=0)return;
    const box=list.getBoundingClientRect(),item=row.getBoundingClientRect();
    if(item.top<box.top)list.scrollTop-=box.top-item.top;else if(item.bottom>box.bottom)list.scrollTop+=item.bottom-box.bottom;
  });
  const historyCommand=(id:string,params:unknown)=>{
    const result=onHistoryCommand?.(id,params)??false;
    if(result && id==="history.selectSnapshot"){skipFollow.current=historyOwner;snapshotSelectionChanged(value=>value+1);}
    return result;
  };
  return (
    <section className="photo-editor__panel photo-editor__panel--history">
      <header className="photo-editor__panel-title"><span>{collapseControl}操作历史</span>
        <div className="photo-editor__history-actions">
          <IconButton size="sm" label="撤销" title="撤销" disabled={readonly || !documentView?.canUndo} onClick={onUndo}><UndoIcon size={15} /></IconButton>
          <IconButton size="sm" label="重做" title="重做" disabled={readonly || !documentView?.canRedo} onClick={onRedo}><RedoIcon size={15} /></IconButton>
        </div>
      </header>
      {commands && onHistoryCommand && commands.get("history.newSnapshot")?.allowed?<HistorySnapshots key={documentView?.documentKey??view.sessionActiveIndex} snapshots={documentView?.historySnapshots??[]} commands={commands} disabled={readonly} onCommand={historyCommand}/>:null}
      <ol ref={historyList} className="photo-editor__history">
        {[...history, ...redoHistory].map((entry, index) => (
          <li key={`${index}-${entry}`} className={index === current ? "is-current" : index > current ? "is-future" : undefined}>
            <button type="button" disabled={readonly || index === current || !!commands && (!commands.get("history.selectState")?.allowed || !commands.get("history.selectState")?.enabled)} onClick={() => onGoTo(index)}>
              <span className="photo-editor__history-marker" />
              <span>{entry === "Open" ? "打开图片" : entry}</span>
              {index === current ? <small>当前</small> : null}
            </button>
          </li>
        ))}
      </ol>
      {commands?.get("history.deleteState")?.allowed && onHistoryCommand?<div className="photo-editor__history-actions"><Button size="sm" tone="ghost" disabled={readonly || current<=0 || !commands.get("history.deleteState")?.enabled} onClick={()=>onHistoryCommand("history.deleteState",{state:current})}>删除当前状态</Button></div>:null}
      <p className="photo-editor__panel-note">已保存的节点版本可在顶部「历史」中查看。</p>
    </section>
  );
}
