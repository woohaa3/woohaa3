import { useRef, type PointerEvent } from "react";
import type { CurveMap } from "./tool-parameters.js";

/**
 * 铅笔曲线绘制面（U41）：直接在 256 级映射上画，交给内核的 `pencil` 语义求值。
 *
 * 与点曲线编辑器分开：点曲线是「控制点 + 样条」，铅笔是「整条 256 级映射」。两者都由上游同一
 * 份参数表示（`points` 或分通道键），切换由参数构造器负责换算，这里只管画。
 */
export function CurveMapEditor({ map, readonly, onChange }: {
  map: CurveMap;
  readonly: boolean;
  onChange: (map: CurveMap) => void;
}) {
  const working = useRef<CurveMap>(map);
  working.current = map;
  const last = useRef<{ x: number; y: number } | null>(null);

  const position = (event: PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round(Math.max(0, Math.min(255, ((event.clientX - rect.left) / Math.max(1, rect.width)) * 255)));
    const y = Math.round(Math.max(0, Math.min(255, 255 - ((event.clientY - rect.top) / Math.max(1, rect.height)) * 255)));
    return { x, y };
  };

  // 两个采样点之间的列按线性补齐，快速拖动也不会留下没画到的空洞。
  const paint = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const start = Math.min(from.x, to.x);
    const end = Math.max(from.x, to.x);
    const next = [...working.current];
    for (let x = start; x <= end; x++) {
      const ratio = to.x === from.x ? 1 : (x - from.x) / (to.x - from.x);
      next[x] = Math.round(from.y + (to.y - from.y) * ratio);
    }
    onChange(next);
  };

  return (
    <svg viewBox="0 0 255 255" width={192} height={192} data-curve-map tabIndex={0}
      onPointerDown={(event) => {
        if (readonly || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const at = position(event);
        last.current = at;
        paint(at, at);
      }}
      onPointerMove={(event) => {
        if (readonly || !last.current || !event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
        const at = position(event);
        paint(last.current, at);
        last.current = at;
      }}
      onPointerUp={(event) => {
        last.current = null;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { last.current = null; }}>
      <path d="M0 255L255 0 M0 128H255 M128 0V255" className="photo-editor-curve__grid" />
      <polyline points={map.map((y, x) => `${x},${255 - y}`).join(" ")} />
    </svg>
  );
}
