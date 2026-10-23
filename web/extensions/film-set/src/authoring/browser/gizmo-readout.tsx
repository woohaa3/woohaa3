import { useLayoutEffect, useRef } from "react";

/** Positions session preview text within the actual workspace, clear of its dock. */
export function GizmoReadout({ point, children }: { point: { x: number; y: number }; children: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const canvas = document.querySelector(".bevy-canvas-surface canvas")?.getBoundingClientRect();
    const dock = element.parentElement?.querySelector(".model-editor-dock")?.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const left = canvas?.left ?? 0;
    const top = canvas?.top ?? 0;
    const right = Math.min(canvas?.right ?? window.innerWidth, dock?.left ?? window.innerWidth);
    const bottom = canvas?.bottom ?? window.innerHeight;
    element.style.left = `${Math.max(left + 8, Math.min(left + point.x + 18, right - box.width - 12))}px`;
    element.style.top = `${Math.max(top + 8, Math.min(top + point.y + 24, bottom - box.height - 12))}px`;
  }, [point.x, point.y, children]);
  return <div ref={ref} className="film-set-gizmo-readout">{children}</div>;
}
