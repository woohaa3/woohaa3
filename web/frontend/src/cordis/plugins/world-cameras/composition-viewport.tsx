import { useEffect, useRef, useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { WorldPoint } from "@woohaa3/contracts";
import { worldCameraEditorStore, type WorldCameraEditSession } from "../../services/world-camera-editor-store.js";
import { composeCamera, type CompositionTool } from "./composition-motion.js";

/** This DOM frame uses the same accepted CSS rectangle as the renderer's editor lens. */
export function CompositionViewport({ ctx, session, disabled, tool, center, selectingCenter, onCenter, onNotice }: {
  ctx: Context; session: WorldCameraEditSession; disabled: boolean; tool: CompositionTool;
  center: WorldPoint; selectingCenter: boolean; onCenter: (center: WorldPoint) => void; onNotice: (text: string) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; draft: WorldCameraEditSession["draft"]; tool: CompositionTool } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ratio = session.draft.aspect.width / session.draft.aspect.height;
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.min(rect.width, rect.height * ratio);
      setSize({ width, height: width / ratio });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, [ratio]);
  useEffect(() => { if (disabled) drag.current = null; }, [disabled]);
  return <div ref={area} className="world-camera-editor__view-area">
    <div className="world-camera-editor__control" data-tool={selectingCenter ? "center" : tool}
      style={{ width: size.width, height: size.height }}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || drag.current) return;
        const current = worldCameraEditorStore.getSnapshot();
        if (!current || current.phase !== "editing") return;
        event.preventDefault();
        if (selectingCenter) {
          const runtime = ctx.canvasRuntime.runtime?.();
          const canvas = event.currentTarget.closest(".world-camera-editor")?.parentElement?.querySelector("canvas");
          const bounds = canvas?.getBoundingClientRect();
          const generation = runtime?.interactionGeneration?.();
          const result = bounds && generation !== undefined ? runtime?.queryCameraEditorSurface?.({ generation,
            x: event.clientX - bounds.left, y: event.clientY - bounds.top, width: bounds.width, height: bounds.height }) : null;
          if (result?.ok && result.value) { onCenter(result.value); onNotice("已设置环绕中心，镜头位置保持不变"); }
          else onNotice("此处没有可用模型表面，请点击模型设置环绕中心");
          return;
        }
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, draft: current.draft, tool: event.shiftKey ? "pan" : tool };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (disabled || !start || start.id !== event.pointerId) return;
        worldCameraEditorStore.update(composeCamera(start.draft, start.tool, event.clientX - start.x, event.clientY - start.y, size.height, center));
      }}
      onPointerUp={event => {
        if (drag.current?.id !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={event => {
        if (drag.current?.id !== event.pointerId) return;
        worldCameraEditorStore.update(drag.current.draft); drag.current = null;
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onWheel={event => {
        if (disabled || selectingCenter) return;
        event.stopPropagation();
        const current = worldCameraEditorStore.getSnapshot();
        const dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
        if (current) worldCameraEditorStore.update(composeCamera(current.draft, "dolly", 0, -dy * 0.3, size.height, center));
      }} />
  </div>;
}
