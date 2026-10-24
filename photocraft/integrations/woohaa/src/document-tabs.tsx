/**
 * 文档 tab 条
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 2.2 / design D2）。
 *
 * 只放**文档标签**，不放任何动作按钮：打开文件属于「文件」菜单，文档清单属于「窗口」菜单。
 * 标签显示名称、实际取景/活动层/目标/模式位深、来源、未保存/保存中/错误状态与关闭按钮；名称重复时用来源补充信息区分；
 * 激活不重排；拖动标签可改变显示顺序，资源仍按稳定id持有。
 *
 * 溢出：横向滚动，活动项自动滚入可见区。电脑与 Pad 共用同一布局。
 */
import { useEffect, useId, useRef, useState } from "react";
import {CursorMenu} from "@woohaa3/photocraft-editor/ui";
import type { EditorDocumentEntry, EditorDocumentWorkspaceSnapshot } from "@woohaa3/photocraft-editor";

export type DocumentTabContext={documentId:string;generation:number;zoom:number;layer:string|null;target:"pixels"|"mask";mode:string;depthBits:number;dirty?:boolean;savePercent?:number};
export type DocumentTabsProps = {
  large?:boolean;
  activeContext?:DocumentTabContext|null;
  onCloseAll?:()=>void;
  onCloseOthers?:(documentId:string)=>void;
  onReorder?:(documentId:string,beforeId:string|null,generation:number,beforeGeneration?:number)=>void;
  snapshot: EditorDocumentWorkspaceSnapshot;
  onActivate: (documentId: string) => void;
  onClose: (documentId: string) => void;
};

/** 状态标签与呈现语气；干净文档不显示任何徽标。 */
function statusOf(entry: EditorDocumentEntry, savePercent?: number): { label: string; tone: string } | null {
  switch (entry.status) {
    case "dirty": return { label: "未保存", tone: "dirty" };
    // 打开中只显示宿主真实上报的进度；未上报阶段不编造百分比。
    case "opening": return { label: entry.openPercent === undefined ? "打开中" : `打开中 ${entry.openPercent}%`, tone: "saving" };
    // 只有在宿主上报真实进度时才带百分比；没有可测进度时保持「保存中」。
    case "saving": return { label: savePercent === undefined ? "保存中" : `保存中 ${savePercent}%`, tone: "saving" };
    case "history-pending": return { label: "待登记", tone: "saving" };
    case "error": return { label: "保存失败", tone: "error" };
    case "conflict": return { label: "内容冲突", tone: "error" };
    case "unavailable": return { label: "不可写", tone: "warn" };
    default: return null;
  }
}

/** 同名检测：只有存在同名项时才显示来源补充信息，避免每条都背一段噪音。 */
function duplicateNames(entries: readonly EditorDocumentEntry[]): Set<string> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
}

export function DocumentTabs({ snapshot, onActivate, onClose,activeContext,large=false,onCloseAll,onCloseOthers,onReorder }: DocumentTabsProps) {
  const token=useId(),drag=useRef<{id:string;generation:number}|null>(null),latest=useRef(snapshot);latest.current=snapshot;
  const [context,setContext]=useState<{id:string;generation:number;x:number;y:number}|null>(null),[dropBefore,setDropBefore]=useState<string|null>(null);
  const current=(id:string,generation:number)=>latest.current.entries.some(entry=>entry.id===id && entry.generation===generation);
  const clearDrag=()=>{drag.current=null;setDropBefore(null);};
  const contextEntry=context && current(context.id,context.generation)?context:null;
  const contexts=useRef(new Map<string,DocumentTabContext>());
  for(const [id,context] of contexts.current)if(!snapshot.entries.some(entry=>entry.id===id && entry.generation===context.generation))contexts.current.delete(id);
  if(activeContext && activeContext.documentId===snapshot.activeId && snapshot.entries.some(entry=>entry.id===activeContext.documentId && entry.generation===activeContext.generation))contexts.current.set(activeContext.documentId,activeContext);
  const stripRef = useRef<HTMLDivElement>(null);
  const duplicates = duplicateNames(snapshot.entries);
  const activeId = snapshot.activeId;

  // 活动项自动进入可见区（不改变顺序，也不滚动整个页面）。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeId) return;
    const active = strip.querySelector<HTMLElement>(`[data-document-id="${CSS.escape(activeId)}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, large, snapshot.entries.map(entry=>entry.id).join("|")]);

  if (snapshot.entries.length === 0) return null;
  return (
    <div className="photo-document-tabs" data-document-tabs="true" data-large-tabs={large || undefined} data-document-count={snapshot.entries.length}>
      <div className="photo-document-tabs__strip" ref={stripRef} role="tablist" aria-label="打开的文档">
        {snapshot.entries.map((entry) => {
          const active = entry.id === activeId;
          const detail = duplicates.has(entry.name) ? entry.detail : null;
          const context=contexts.current.get(entry.id);
          // 保存百分比只属于正在保存的那个文档：宿主上报的进度按活动文档归属，非活动项不借它显示。
          const status = statusOf(entry, entry.id===activeId ? context?.savePercent : undefined);
          const parts=context?[context.layer,context.target==="mask"?"图层蒙版":null,context.mode && context.depthBits>0?`${context.mode}/${context.depthBits}`:context.mode].filter(Boolean):[];
          const name=`${entry.name}${context && Number.isFinite(context.zoom) && context.zoom>0?` @ ${(context.zoom*100).toLocaleString("zh-CN",{maximumFractionDigits:2})}%`:""}${parts.length?` (${parts.join("，")})`:""}${entry.status==="dirty" || entry.status!=="clean" && context?.dirty?" *":""}`;
          return (
            <div key={entry.id} role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
              data-document-id={entry.id} data-active={active ? "true" : undefined} data-status={status?.tone}
              className={`photo-document-tab${active ? " photo-document-tab--active" : ""}`}
              title={`${name}${entry.detail ? ` · ${entry.detail}` : ""}${entry.message ? ` · ${entry.message}` : ""}`}
              draggable={!!onReorder && !snapshot.activeGate}
              data-drop-before={dropBefore===entry.id || undefined}
              data-drop-after={dropBefore==="end" && entry.id===snapshot.entries.at(-1)?.id || undefined}
              onPointerDown={event=>{if(event.button===1)event.preventDefault();}}
              onAuxClick={event=>{if(event.button===1){event.preventDefault();event.stopPropagation();if(current(entry.id,entry.generation))onClose(entry.id);}}}
              onContextMenu={event=>{event.preventDefault();event.stopPropagation();setContext({id:entry.id,generation:entry.generation,x:event.clientX,y:event.clientY});}}
              onDragStart={event=>{if(!onReorder || snapshot.activeGate || (event.target as Element).closest("button")){event.preventDefault();return;}setContext(null);drag.current={id:entry.id,generation:entry.generation};event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("application/x-photocraft-document-tab",token);}}
              onDragEnd={clearDrag}
              onDragOver={event=>{const source=drag.current;if(!onReorder || !source || latest.current.activeGate || !current(source.id,source.generation))return;event.preventDefault();event.dataTransfer.dropEffect="move";const rect=event.currentTarget.getBoundingClientRect(),entries=latest.current.entries,index=entries.findIndex(item=>item.id===entry.id);setDropBefore(event.clientX<rect.left+rect.width/2?entry.id:entries[index+1]?.id??"end");const strip=stripRef.current;if(strip){const bounds=strip.getBoundingClientRect();if(event.clientX<bounds.left+24)strip.scrollLeft-=16;else if(event.clientX>bounds.right-24)strip.scrollLeft+=16;}}}
              onDrop={event=>{event.preventDefault();event.stopPropagation();const source=drag.current;if(onReorder && source && !latest.current.activeGate && current(source.id,source.generation) && current(entry.id,entry.generation) && event.dataTransfer.getData("application/x-photocraft-document-tab")===token){const rect=event.currentTarget.getBoundingClientRect(),entries=latest.current.entries,index=entries.findIndex(item=>item.id===entry.id),before=event.clientX<rect.left+rect.width/2?entry:entries[index+1];onReorder(source.id,before?.id??null,source.generation,before?.generation);}clearDrag();}}
              onClick={() => { if (entry.status !== "opening") onActivate(entry.id); }}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (entry.status !== "opening") onActivate(entry.id); } }}>
              <span className="photo-document-tab__icon" data-source={entry.source.kind} aria-hidden="true" />
              <span className="photo-document-tab__name">{name}</span>
              {detail ? <span className="photo-document-tab__detail">{detail}</span> : null}
              {status ? <span className="photo-document-tab__status" data-tone={status.tone}>{status.label}</span> : null}
              {entry.status==="opening"?<span className="photo-document-tab__progress" data-open-progress={entry.openPercent??0} aria-hidden="true"><i style={{width:`${entry.openPercent??0}%`}}/></span>:null}
              <button type="button" className="photo-document-tab__close" aria-label={entry.status==="opening"?`取消打开 ${entry.name}`:`关闭 ${entry.name}`}
                title={entry.status==="opening"?"取消打开":"关闭文档"} onClick={(event) => { event.stopPropagation(); onClose(entry.id); }}>×</button>
            </div>
          );
        })}
      </div>
      {contextEntry?<CursorMenu open x={contextEntry.x} y={contextEntry.y} label="文档标签" onOpenChange={open=>{if(!open)setContext(null);}} items={[
        {id:"close",label:"关闭",onSelect:()=>{if(current(contextEntry.id,contextEntry.generation))onClose(contextEntry.id);setContext(null);}},
        ...(onCloseOthers?[{id:"others",label:"关闭其他文档",disabled:snapshot.entries.length<2,onSelect:()=>{if(current(contextEntry.id,contextEntry.generation))onCloseOthers(contextEntry.id);setContext(null);}}]:[]),
        ...(onCloseAll?[{id:"all",label:"关闭全部",onSelect:()=>{if(current(contextEntry.id,contextEntry.generation))onCloseAll();setContext(null);}}]:[])
      ]}/>:null}
      {snapshot.activeGate ? <div className="photo-document-tabs__gate" role="status">{snapshot.activeGate}</div> : null}
    </div>
  );
}
