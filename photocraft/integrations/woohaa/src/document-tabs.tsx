/**
 * 文档 tab 条
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 2.2 / design D2）。
 *
 * 只放**文档标签**，不放任何动作按钮：打开文件属于「文件」菜单，文档清单属于「窗口」菜单。
 * 标签显示名称、来源、未保存/保存中/错误状态与关闭按钮；名称重复时用来源补充信息区分；
 * 顺序按打开顺序稳定（激活不重排）。
 *
 * 溢出：横向滚动，活动项自动滚入可见区。电脑与 Pad 共用同一布局。
 */
import { useEffect, useRef } from "react";
import type { EditorDocumentEntry, EditorDocumentWorkspaceSnapshot } from "@woohaa3/photocraft-editor";

export type DocumentTabsProps = {
  snapshot: EditorDocumentWorkspaceSnapshot;
  onActivate: (documentId: string) => void;
  onClose: (documentId: string) => void;
  onReorder?: (documentId: string, targetDocumentId: string) => void;
};

/** 状态标签与呈现语气；干净文档不显示任何徽标。 */
function statusOf(entry: EditorDocumentEntry): { label: string; tone: string } | null {
  switch (entry.status) {
    case "dirty": return { label: "未保存", tone: "dirty" };
    case "saving": return { label: "保存中", tone: "saving" };
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

export function DocumentTabs({ snapshot, onActivate, onClose, onReorder }: DocumentTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const duplicates = duplicateNames(snapshot.entries);
  const activeId = snapshot.activeId;

  // 活动项自动进入可见区（不改变顺序，也不滚动整个页面）。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeId) return;
    const active = strip.querySelector<HTMLElement>(`[data-document-id="${CSS.escape(activeId)}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, snapshot.entries.length]);

  useEffect(() => {
    const cycle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key !== "Tab" || snapshot.entries.length < 2) return;
      const index = Math.max(0, snapshot.entries.findIndex((entry) => entry.id === activeId));
      const step = event.shiftKey ? -1 : 1;
      const next = snapshot.entries[(index + step + snapshot.entries.length) % snapshot.entries.length];
      if (!next) return;
      event.preventDefault();
      onActivate(next.id);
    };
    window.addEventListener("keydown", cycle);
    return () => window.removeEventListener("keydown", cycle);
  }, [activeId, onActivate, snapshot.entries]);

  if (snapshot.entries.length === 0) return null;
  return (
    <div className="photo-document-tabs" data-document-tabs="true" data-document-count={snapshot.entries.length}>
      <div className="photo-document-tabs__strip" ref={stripRef} role="tablist" aria-label="打开的文档">
        {snapshot.entries.map((entry) => {
          const status = statusOf(entry);
          const active = entry.id === activeId;
          const detail = duplicates.has(entry.name) ? entry.detail : null;
          return (
            <div key={entry.id} role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
              draggable={!!onReorder}
              data-document-id={entry.id} data-active={active ? "true" : undefined} data-status={status?.tone}
              className={`photo-document-tab${active ? " photo-document-tab--active" : ""}`}
              title={`${entry.name}${entry.detail ? ` · ${entry.detail}` : ""}${entry.message ? ` · ${entry.message}` : ""}`}
              onClick={() => onActivate(entry.id)}
              onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/x-photocraft-document", entry.id); }}
              onDragOver={(event) => { if (onReorder && event.dataTransfer.types.includes("text/x-photocraft-document")) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } }}
              onDrop={(event) => { const moving = event.dataTransfer.getData("text/x-photocraft-document"); if (moving) {event.preventDefault();event.stopPropagation();if(moving !== entry.id) onReorder?.(moving, entry.id);} }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onActivate(entry.id); return; }
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  const index = snapshot.entries.findIndex((candidate) => candidate.id === entry.id);
                  const step = event.key === "ArrowLeft" ? -1 : 1;
                  const next = snapshot.entries[(index + step + snapshot.entries.length) % snapshot.entries.length];
                  if (next) onActivate(next.id);
                }
              }}>
              <span className="photo-document-tab__icon" data-source={entry.source.kind} aria-hidden="true" />
              <span className="photo-document-tab__name">{entry.name}</span>
              {detail ? <span className="photo-document-tab__detail">{detail}</span> : null}
              {status ? <span className="photo-document-tab__status" data-tone={status.tone}>{status.label}</span> : null}
              <button type="button" className="photo-document-tab__close" aria-label={`关闭 ${entry.name}`}
                title="关闭文档" onClick={(event) => { event.stopPropagation(); onClose(entry.id); }}>×</button>
            </div>
          );
        })}
      </div>
      {snapshot.activeGate ? <div className="photo-document-tabs__gate" role="status">{snapshot.activeGate}</div> : null}
    </div>
  );
}
