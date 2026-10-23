import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { LAYER_FILL_LIMITS } from "@woohaa3/photocraft-protocol";
import { Button, IconButton } from "./ui/Button.js";
import { Tooltip } from "./ui/Tooltip.js";
import { DropdownMenu } from "./ui/Menu.js";
import { ADJUSTMENT_LAYER_ACTIONS } from "./photo-editor-layer-actions.js";
import { EyeIcon, EyeOffIcon, MaskIcon, PlusIcon, TrashIcon, UndoIcon, RedoIcon, LinkIcon, UnlinkIcon, CloseIcon, ClippingMaskIcon } from "./ui/icons.js";
import { commandShortcutLabel } from "./photo-editor-shortcuts.js";
import { LayerLayoutControls } from "./layer-layout-controls.js";
import { LayerThumbnail, type LayerThumbnailReader } from "./layer-thumbnail.js";
import { PHOTOSHOP_BLENDS, type EditorLayerRow, type EditorLayerLocks, type EditorViewModel } from "./editor-view-model.js";
import { AdjustmentIcon, LockIcon, FolderPlusIcon, ChevronDownIcon, ChevronRightIcon } from "./ui/icons.js";

export const BLEND_LABELS: Record<string, string> = {"Normal": "正常", "Dissolve": "溶解", "Darken": "变暗", "Multiply": "正片叠底", "Color Burn": "颜色加深", "Linear Burn": "线性加深", "Darker Color": "深色", "Lighten": "变亮", "Screen": "滤色", "Color Dodge": "颜色减淡", "Linear Dodge (Add)": "线性减淡（添加）", "Lighter Color": "浅色", "Overlay": "叠加", "Soft Light": "柔光", "Hard Light": "强光", "Vivid Light": "亮光", "Linear Light": "线性光", "Pin Light": "点光", "Hard Mix": "实色混合", "Difference": "差值", "Exclusion": "排除", "Subtract": "减去", "Divide": "划分", "Hue": "色相", "Saturation": "饱和度", "Color": "颜色", "Luminosity": "明度", "Pass Through": "穿透" };
const KIND_LABELS: Record<string, string> = { raster: "像素", group: "组", text: "文字", adjustment: "调整", pixel: "像素", fill: "填充" };

/** 属性属于活动图层；选择集合与重排结果始终读取内核。 */
export function LayerPanel({ view, commands, readonly, onSelect, onToggleVisible, onBlend, onRename, onCommand, thumbnail, onMask, onAddMask, opacityEditing, collapseControl, styleEditor, filterControl, filteredLayerIds }: {
  filterControl?: ReactNode;
  filteredLayerIds?: readonly number[] | null;
  styleEditor?:ReactNode;
  collapseControl?:ReactNode;
  view: EditorViewModel;
  commands: ReadonlyMap<string, PhotocraftCommand>;
  readonly: boolean;
  onSelect: (layer: EditorLayerRow, mode: "replace" | "toggle" | "range") => void;
  onToggleVisible: (layer: EditorLayerRow) => void;
  onBlend: (layer: EditorLayerRow, blend: string) => void;
  onRename: (layer: EditorLayerRow, name: string) => void;
  onCommand: (id: string, params?: unknown) => void;
  thumbnail?: LayerThumbnailReader;
  onMask?: (layer:EditorLayerRow,modifiers:{shift:boolean;alt:boolean}) => void;
  onAddMask: (invert:boolean) => void;
  opacityEditing:{value:string;fillValue?:string;updateFill?:(value:string)=>void;active:boolean;disabled:boolean;update:(value:string)=>void;finish:(commit:boolean)=>boolean};
}) {
  const [renaming, setRenaming] = useState<number | null>(null);
  const dragging = useRef<number[] | null>(null);
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
  // Search reveals matching descendants even when their group is collapsed.
  const displayed = filteredLayerIds != null
    ? layers.filter(layer => filteredLayerIds.includes(layer.id))
    : layers.filter(layer => ancestors(layer).every(parent => parent.expanded));
  const active = layers.find((layer) => layer.active);
  const blends: readonly string[] = active?.kind === "group" ? ["Pass Through", ...PHOTOSHOP_BLENDS] : PHOTOSHOP_BLENDS;
  const clippingCommand=active?.clipped ? "layer.releaseClippingMask" : "layer.createClippingMask";
  const adjustments = ADJUSTMENT_LAYER_ACTIONS.filter(({ id }) => commands.get(id)?.allowed);
  const selected=layers.filter(layer=>layer.selected || layer.active);
  const lockControls = [
    ["transparency","透明像素"], ["pixels","像素"], ["position","位置"], ["all","全部"]
  ] as const;
  const canReorder = !readonly && renaming === null && commands.get("layer.moveTo")?.allowed === true && commands.get("layer.moveTo")?.enabled === true;
  const select = (layer:EditorLayerRow,event:{shiftKey:boolean;ctrlKey:boolean;metaKey:boolean}) =>
    onSelect(layer,event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "replace");
  const clearDrag = () => {dragging.current=null;setDrop(null);};
  const positionAt = (layer: EditorLayerRow, row: HTMLElement, y: number): "above" | "below" | "into" => {
    const rect = row.getBoundingClientRect();
    if (layer.kind === "group" && y >= rect.top + rect.height * .25 && y <= rect.top + rect.height * .75) return "into";
    return y < rect.top + rect.height / 2 ? "above" : "below";
  };
  const acceptsDrop = (layer: EditorLayerRow) => canReorder && dragging.current && !dragging.current.includes(layer.id)
    && !ancestors(layer).some(parent => dragging.current!.includes(parent.id));
  useEffect(()=>{if (readonly || renaming!==null) {dragging.current=null;setDrop(null);}},[readonly,renaming]);
  return (
    <section className="photo-editor__panel photo-editor__panel--layers">
      <header className="photo-editor__panel-title"><span>{collapseControl}图层</span><span>{layers.filter(layer=>layer.selected).length > 1 ? `已选 ${layers.filter(layer=>layer.selected).length} / ${layers.length}` : layers.length}</span></header>
      {filterControl}
      {filteredLayerIds != null && displayed.length === 0 ? <p className="photo-editor__option-hint">没有匹配的图层，请调整筛选条件</p> : null}
      <div className="photo-editor__layer-properties">
        <select value={active?.blend ?? "Normal"} disabled={readonly || !active || active.effectiveLocks.all} title="混合模式"
          onChange={(event) => active && onBlend(active, event.currentTarget.value)}>
          {blends.map((blend) => <option key={blend} value={blend}>{BLEND_LABELS[blend]}</option>)}
          {active && !blends.includes(active.blend) ? <option value={active.blend}>{active.blend}</option> : null}
        </select>
        <label data-layer-opacity>不透明度 <input type="number" min={0} max={100} value={opacityEditing.value}
          disabled={opacityEditing.disabled || !active || active.effectiveLocks.all}
          onChange={(event)=>opacityEditing.update(event.currentTarget.value)}
          onBlur={()=>opacityEditing.finish(true)}
          onKeyDown={(event)=>{
            if (event.nativeEvent.isComposing || event.keyCode===229) return;
            if (event.key==="Enter" || event.key==="Escape") {
              event.preventDefault();event.stopPropagation();opacityEditing.finish(event.key==="Enter");
            }
          }} />%</label>
        {opacityEditing.updateFill ? <label data-layer-fill>填充 <input type="number" min={0} max={100} value={opacityEditing.fillValue ?? "100"}
          disabled={opacityEditing.disabled || !active || active.effectiveLocks.all}
          onChange={(event)=>opacityEditing.updateFill?.(event.currentTarget.value)}
          onBlur={()=>opacityEditing.finish(true)}
          onKeyDown={(event)=>{
            if (event.nativeEvent.isComposing || event.keyCode===229) return;
            if (event.key==="Enter" || event.key==="Escape") {
              event.preventDefault();event.stopPropagation();opacityEditing.finish(event.key==="Enter");
            }
          }} />%</label> : null}
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
            {key==="all" ? <LockIcon size={13}/> : null}{label}
          </Button>;
        })}
      </div>
      <LayerLayoutControls commands={commands} readonly={readonly} hasSelection={view.document?.hasSelection ?? false} onCommand={onCommand} />
      {layers.length === 0 ? <p className="photo-editor__panel-empty">打开图片后，图层会显示在这里。</p> : null}
      <ul className="photo-editor__layers" onDragLeave={(event)=>{
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null);
      }}>
        {displayed.map((layer) => {
          const maskActive=layer.active && view.document?.editTarget === "mask";
          return (
            <li key={layer.id} className={`photo-editor__layer${layer.selected || layer.active ? " photo-editor__layer--selected" : ""}${layer.active ? " photo-editor__layer--active" : ""}`}
              data-layer-id={layer.id} data-drop-position={canReorder && drop?.layer===layer.id ? drop.position : undefined}
              data-link-group={layer.linkGroup === null ? undefined : layer.linkGroup}
              onDragOver={(event)=>{
                if (!acceptsDrop(layer)) { setDrop(null); return; }
                const position = positionAt(layer,event.currentTarget,event.clientY);
                if ((position === "into" ? layer.effectiveLocks.all : ancestors(layer)[0]?.effectiveLocks.all)) { setDrop(null); return; }
                event.preventDefault();event.dataTransfer.dropEffect="move";
                setDrop({layer:layer.id,position});
              }}
              onDrop={(event)=>{
                const ids=dragging.current;
                const accepted=acceptsDrop(layer);
                const position=positionAt(layer,event.currentTarget,event.clientY);
                clearDrag();
                if (!accepted || !ids || (position === "into" ? layer.effectiveLocks.all : ancestors(layer)[0]?.effectiveLocks.all)) return;
                event.preventDefault();event.stopPropagation();
                onCommand("layer.moveTo",{layers:ids,target:layer.id,position});
              }}
              style={{ paddingLeft: `${6 + layer.depth * 16}px` }}>
              <IconButton size="sm" label={layer.visible ? "隐藏图层" : "显示图层"} title={layer.visible ? "隐藏图层" : "显示图层"}
                disabled={readonly} onClick={() => onToggleVisible(layer)}>{layer.visible ? <EyeIcon size={15} /> : <EyeOffIcon size={15} />}</IconButton>
              {layer.kind === "group" ? <IconButton size="sm" className="photo-editor__group-disclosure" label={layer.expanded ? "折叠组" : "展开组"}
                title={`${layer.expanded ? "折叠组" : "展开组"}；Alt/Option 同时切换所有组`}
                disabled={readonly || !commands.get("layer.setExpanded")?.enabled || !commands.get("layer.setExpanded")?.allowed}
                onClick={(event)=>onCommand("layer.setExpanded",{layer:layer.id,expanded:!layer.expanded,...(event.altKey ? {all:true} : {})})}>
                {layer.expanded ? <ChevronDownIcon size={12}/> : <ChevronRightIcon size={12}/>}
              </IconButton> : <span className="photo-editor__group-disclosure-space"/>}
              {layer.labelColor && layer.labelColor !== "none" ? <span className="photo-editor__label-swatch" data-label={layer.labelColor} title={`图层颜色：${layer.labelColor}`} /> : null}
              {layer.linkGroup !== null ? <span className="photo-editor__clipping-indicator" title="已链接：与同组图层一起移动"><LinkIcon size={13} /></span> : null}
              {layer.clipped ? <span className="photo-editor__clipping-indicator" title="剪贴到下方基底"><ClippingMaskIcon size={13} /></span> : null}
              <button type="button" className="photo-editor__layer-thumbnail" data-edit-target="pixels" data-target-active={layer.active && !maskActive ? "true" : undefined} disabled={readonly} onClick={(event) => select(layer,event)} title={`${layer.name}：编辑内容；Shift 范围选择，Ctrl/Cmd 增减选择`}>
                <LayerThumbnail layer={layer.id} revision={view.document?.revision ?? 0} read={thumbnail} />
              </button>
              {layer.hasMask ? <>
                <IconButton size="sm" label={layer.maskLinked ? "取消链接蒙版" : "链接蒙版"} disabled={readonly || !commands.get("layer.layerMask.linked")?.allowed}
                  onClick={() => onCommand("layer.layerMask.linked",{layer:layer.id,linked:!layer.maskLinked})}>{layer.maskLinked ? <LinkIcon size={12} /> : <UnlinkIcon size={12} />}</IconButton>
                <button type="button" className="photo-editor__layer-thumbnail photo-editor__mask-thumbnail" data-edit-target="mask" data-target-active={maskActive ? "true" : undefined}
                  data-mask-enabled={String(layer.maskEnabled)} data-mask-view={view.document?.maskView === layer.id ? "true" : undefined} disabled={readonly}
                  title={`${layer.name}：编辑蒙版；Shift 启停，Alt/Option 单独查看`} onClick={(event) => onMask?.(layer,{shift:event.shiftKey,alt:event.altKey})}>
                  <LayerThumbnail layer={layer.id} mask revision={view.document?.revision ?? 0} read={thumbnail} />
                  {!layer.maskEnabled ? <span className="photo-editor__mask-disabled"><CloseIcon size={24} /></span> : null}
                </button>
              </> : null}
              {renaming === layer.id ? (
                <input autoFocus defaultValue={layer.name} onBlur={(event) => { const name=event.currentTarget.value || layer.name; if (name!==layer.name) onRename(layer,name); setRenaming(null); }}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setRenaming(null); }} />
              ) : (
                <button type="button" className="photo-editor__layer-name" disabled={readonly} onClick={(event) => select(layer,event)} onDoubleClick={() => setRenaming(layer.id)}
                  draggable={canReorder && !(layer.selected || layer.active ? selected : [layer]).some(row=>row.effectiveLocks.all)} onDragStart={(event)=>{
                    if (!canReorder || (layer.selected || layer.active ? selected : [layer]).some(row=>row.effectiveLocks.all)) {event.preventDefault();return;}
                    const selectedIds=selected.map(row=>row.id);
                    const ids=selectedIds.includes(layer.id) ? selectedIds : [layer.id];
                    if (!selectedIds.includes(layer.id)) onSelect(layer,"replace");
                    dragging.current=ids;event.dataTransfer.effectAllowed="move";
                    event.dataTransfer.setData("application/x-woohaa-image-layers",ids.join(","));
                  }} onDragEnd={clearDrag}>
                  <span>{layer.name}</span><small>{KIND_LABELS[layer.kind] ?? layer.kind}{layer.hasEffects ? " · 样式" : ""}</small>
                </button>
              )}
              {Object.values(layer.effectiveLocks).some(Boolean) ? <IconButton size="sm" label="解锁图层" title={`${layer.name}：${lockControls.filter(([key])=>layer.effectiveLocks[key]).map(([,label])=>label).join("、")}已锁定`}
                disabled={readonly || !commands.get("layer.setProps")?.allowed || !Object.values(layer.locks).some(Boolean)}
                onClick={()=>onCommand("layer.setProps",{layer:layer.id,locks:{transparency:false,pixels:false,position:false,artboard:false,all:false} satisfies EditorLayerLocks})}><LockIcon size={13}/></IconButton> : null}
            </li>
          );
        })}
      </ul>
      <div className="photo-editor__layer-actions">
        {commands.get("layer.setLabelColor")?.allowed ? <DropdownMenu label="图层颜色" side="top" align="end"
          trigger={<IconButton size="sm" label="图层颜色" title="图层颜色标签"
            disabled={readonly || selected.length === 0 || !commands.get("layer.setLabelColor")?.enabled}>
            <span className="photo-editor__label-swatch" data-label={active?.labelColor && active.labelColor !== "none" ? active.labelColor : "gray"} /></IconButton>}
          items={LAYER_FILL_LIMITS.labelColors.map((color) => ({
            id: color,
            label: color === "none" ? "无" : color,
            selected: (active?.labelColor ?? "none") === color,
            disabled: readonly || selected.length === 0,
            onSelect: () => onCommand("layer.setLabelColor", { color })
          }))}
        /> : null}
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
          items={adjustments.map(({ id, label }) => ({ id, label, disabled: readonly || !commands.get(id)?.enabled, onSelect: onCommand }))}
        /> : null}
        {[
          { id: "layer.new.group", label: "新建组", Icon: FolderPlusIcon, needsLayer: false },
          { id: "layer.new.layer", label: "新建图层", Icon: PlusIcon, needsLayer: false },
          { id: "layer.delete", label: "删除图层", Icon: TrashIcon, needsLayer: true }
        ].filter(({ id }) => commands.get(id)?.allowed).map(({ id, label, Icon, needsLayer }) => (
          <Tooltip key={id} content={label}><IconButton size="sm" label={label} disabled={readonly || !commands.get(id)?.enabled || (needsLayer && !active)} onClick={() => onCommand(id)}><Icon size={16} /></IconButton></Tooltip>
        ))}
      </div>
    </section>
  );
}

/** 本次编辑的操作历史；节点已保存版本仍从公共顶栏「历史」进入。 */
export function HistoryPanel({ view, readonly, onUndo, onRedo, onGoTo, collapseControl }: {
  collapseControl?:ReactNode;
  view: EditorViewModel;
  readonly: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onGoTo: (index: number) => void;
}) {
  const documentView = view.document;
  const history = documentView?.history ?? [];
  const redoHistory = documentView?.redoHistory ?? [];
  const current = history.length - 1;
  return (
    <section className="photo-editor__panel photo-editor__panel--history">
      <header className="photo-editor__panel-title"><span>{collapseControl}操作历史</span>
        <div className="photo-editor__history-actions">
          <IconButton size="sm" label="撤销" title="撤销" disabled={readonly || !documentView?.canUndo} onClick={onUndo}><UndoIcon size={15} /></IconButton>
          <IconButton size="sm" label="重做" title="重做" disabled={readonly || !documentView?.canRedo} onClick={onRedo}><RedoIcon size={15} /></IconButton>
        </div>
      </header>
      <ol className="photo-editor__history">
        {[...history, ...redoHistory].map((entry, index) => (
          <li key={`${index}-${entry}`} className={index === current ? "is-current" : index > current ? "is-future" : undefined}>
            <button type="button" disabled={readonly || index === current} onClick={() => onGoTo(index)}>
              <span className="photo-editor__history-marker" />
              <span>{entry === "Open" ? "打开图片" : entry}</span>
              {index === current ? <small>当前</small> : null}
            </button>
          </li>
        ))}
      </ol>
      <p className="photo-editor__panel-note">已保存的节点版本可在顶部「历史」中查看。</p>
    </section>
  );
}
