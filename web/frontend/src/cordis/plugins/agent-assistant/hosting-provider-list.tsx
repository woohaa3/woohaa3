import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { TemporaryHostingCandidateView, TemporaryHostingRouteView } from "@woohaa3/contracts";
import { Button, SettingsFeedback } from "@woohaa3/ui";
import { ElevationIcon, StarIcon } from "@woohaa3/ui/icons";
import type { BackendSettingsStore } from "../settings/backend-settings-store.js";

type Drag = {
  pointerId: number; id: string; startY: number;
  positions: Array<{ id: string; middle: number }>;
  original: string[]; order: string[]; moved: boolean;
  element: HTMLElement; startTop: number; startMiddle: number; clientY: number; offset: number;
  previousTops: Map<HTMLElement, number>;
};

/** The displayed order is the upload priority; dropping a row persists it immediately. */
export function HostingProviderList({ route, store, onOpenOwner }: {
  route: TemporaryHostingRouteView; store?: BackendSettingsStore; onOpenOwner: (id: string) => void;
}) {
  const candidates = route.candidates.filter(candidate => candidate.configured);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const release = useRef<(() => void) | null>(null);
  const activeDrag = useRef<Drag | null>(null);
  const landing = useRef<{ element: HTMLElement; top: number } | null>(null);
  const animations = useRef(new Map<HTMLElement, Animation>());
  const saving = useRef(false);
  const mounted = useRef(true);
  const state = store?.getState();
  const settings = state?.status === "ready" ? state.snapshot.settings : [];
  const orderEntry = settings.find(entry => entry.key === "exposer.order");
  const primary = settings.find(entry => entry.key === "exposer.primary");
  const lockedBy = orderEntry?.lockedBy || (primary?.value !== "auto" ? primary?.lockedBy : null);
  const disabled = !store || !orderEntry || Boolean(lockedBy) || busy;
  const rows = draft ? draft.map(id => candidates.find(candidate => candidate.exposerId === id)).filter((row): row is TemporaryHostingCandidateView => Boolean(row))
    .concat(candidates.filter(candidate => !draft.includes(candidate.exposerId))) : candidates;

  const animatePosition = (element: HTMLElement, from: number) => {
    animations.current.get(element)?.cancel();
    if (!from || typeof element.animate !== "function") return;
    const animation = element.animate([
      { transform: `translateY(${from}px)` }, { transform: "translateY(0px)" }
    ], { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    animations.current.set(element, animation);
    animation.onfinish = () => { if (animations.current.get(element) === animation) animations.current.delete(element); };
  };

  // Keep the grabbed point under the pointer even when React moves the row to its new slot.
  const followPointer = (drag: Drag) => {
    const layoutTop = drag.element.getBoundingClientRect().top - drag.offset;
    drag.offset = drag.startTop + drag.clientY - drag.startY - layoutTop;
    drag.element.style.transform = `translateY(${drag.offset}px)`;
  };

  useLayoutEffect(() => {
    const drag = activeDrag.current;
    if (drag) {
      followPointer(drag);
      for (const [element, top] of drag.previousTops) {
        animations.current.get(element)?.cancel();
        animatePosition(element, top - element.getBoundingClientRect().top);
      }
      drag.previousTops.clear();
    } else if (landing.current) {
      const { element, top } = landing.current;
      landing.current = null;
      animatePosition(element, top - element.getBoundingClientRect().top);
    }
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; release.current?.(); landing.current = null;
      animations.current.forEach(animation => animation.cancel()); animations.current.clear();
    };
  }, []);

  useEffect(() => {
    release.current?.(); setDragging(null); setDraft(null);
  }, [route]);

  const save = async (ids: string[]) => {
    if (!store || disabled || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    // Keep hidden/unavailable registrations and previously saved IDs so temporary removal does not erase preference.
    const previous = typeof orderEntry?.value === "string" ? orderEntry.value.split(",").map(id => id.trim()).filter(Boolean) : [];
    const order = [...new Set([...ids, ...route.candidates.map(candidate => candidate.exposerId), ...previous])];
    try {
      const result = await store.save({
        "exposer.order": order.join(","),
        ...(primary?.lockedBy ? {} : { "exposer.primary": "auto" })
      });
      if (!mounted.current) return;
      if (result.ok) setDraft(null);
      else setError(result.issues.find(issue => issue.key === "exposer.order" || issue.key === "exposer.primary")?.message ?? result.error);
    } catch { if (mounted.current) setError("顺序保存失败，请重试。"); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  };

  const begin = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || disabled || candidates.length < 2 || release.current) return;
    event.preventDefault();
    const original = rows.map(row => row.exposerId);
    const element = event.currentTarget.closest("li")!;
    const rect = element.getBoundingClientRect();
    animations.current.get(element)?.cancel();
    const drag: Drag = {
      pointerId: event.pointerId, id, startY: event.clientY, original, order: original, moved: false,
      element, startTop: rect.top, startMiddle: rect.top + rect.height / 2, clientY: event.clientY, offset: 0,
      previousTops: new Map(),
      positions: Array.from(list.current?.children ?? []).map(row => {
        const rect = row.getBoundingClientRect();
        return { id: (row as HTMLElement).dataset.hostingId!, middle: rect.top + rect.height / 2 };
      })
    };
    activeDrag.current = drag;
    setDragging(id);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== drag.pointerId) return;
      next.preventDefault();
      drag.clientY = next.clientY;
      followPointer(drag);
      if (!drag.moved && Math.abs(next.clientY - drag.startY) < 4) return;
      drag.moved = true;
      const order = drag.original.filter(item => item !== drag.id);
      const middle = drag.startMiddle + next.clientY - drag.startY;
      const index = drag.positions.filter(position => position.id !== drag.id && position.middle < middle).length;
      order.splice(index, 0, drag.id);
      if (order.join(",") === drag.order.join(",")) return;
      drag.previousTops = new Map(Array.from(list.current?.children ?? [])
        .filter(row => row !== element).map(row => [row as HTMLElement, row.getBoundingClientRect().top]));
      drag.order = order; setDraft(order);
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== drag.pointerId) return;
      move(next);
      release.current?.(); setDragging(null);
      if (drag.order.join(",") !== drag.original.join(",")) void save(drag.order);
    };
    const cancel = (next: PointerEvent) => {
      if (next.pointerId !== drag.pointerId) return;
      release.current?.(); setDragging(null); setDraft(draft);
    };
    const blur = () => { release.current?.(); setDragging(null); setDraft(draft); };
    release.current = () => {
      landing.current = { element, top: element.getBoundingClientRect().top };
      element.style.removeProperty("transform");
      activeDrag.current = null;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      release.current = null;
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
  };

  return <>
    {rows.length ? <section className="agent-assistant__capability-suppliers">
      <ul ref={list} className="agent-assistant__list agent-assistant__hosting-list" data-saving={busy}>{rows.map((candidate, index) => <li key={candidate.exposerId} data-hosting-id={candidate.exposerId} data-dragging={dragging === candidate.exposerId}>
        <button type="button" className="agent-assistant__hosting-drag" title="拖动调整优先级" disabled={disabled || candidates.length < 2} onPointerDown={event => begin(event, candidate.exposerId)}><ElevationIcon size={16} /></button>
        <div className="agent-assistant__identity"><strong className="agent-assistant__hosting-name">{candidate.label}{index === 0 ? <span className="agent-assistant__hosting-priority" data-hosting-priority="first" title="优先使用"><StarIcon size={14} /></span> : null}</strong><p>已配置{!candidate.available ? " · 当前请求不可用" : ""}</p>{candidate.lastError ? <SettingsFeedback tone="warning">最近失败：{candidate.lastError}</SettingsFeedback> : null}</div>
        <div className="agent-assistant__actions">{candidate.ownerExtensionId ? <Button size="sm" tone="ghost" onClick={() => onOpenOwner(candidate.ownerExtensionId!)}>配置</Button> : null}</div>
      </li>)}</ul>
    </section> : null}
    {lockedBy ? <SettingsFeedback tone="warning">优先顺序由环境变量 {lockedBy} 锁定。</SettingsFeedback> : null}
    {error ? <SettingsFeedback tone="danger">{error} <Button size="sm" disabled={busy} onClick={() => void save(rows.map(row => row.exposerId))}>重试</Button></SettingsFeedback> : null}
  </>;
}
