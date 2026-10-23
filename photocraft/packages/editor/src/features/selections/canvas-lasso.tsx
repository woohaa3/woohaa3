import { useEffect, useRef, useState } from "react";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { DocumentPoint, SelectionMode } from "../../photo-editor-tools.js";
import { magneticLassoParams } from "./draft-state.js";

/** 主画布上的多边形/磁性套索。点列为临时手势，选区候选与追边由内核拥有。 */
export function useCanvasLasso(controller: EditorWorkspaceController, tool: string, width: number, height: number, mode: SelectionMode, zoom: number, changed: () => void, message: (value: string | null) => void) {
  const points = useRef<DocumentPoint[]>([]);
  const draft = useRef(false);
  const invalid = useRef(false);
  const [revision, update] = useState(0);
  const [edgeWidth, setEdgeWidth] = useState(10);
  const [contrast, setContrast] = useState(10);
  const outline = useRef<number[][]>([]);
  const lastMove = useRef(0);
  const supported = tool === "polygon-lasso" || tool === "magnetic-lasso";
  const cancel = () => {
    if (draft.current) controller.features.selections.cancelSelectionDraft();
    controller.setCanvasToolDraft(false);
    draft.current = false; invalid.current = false; points.current = []; outline.current = [];
    update(value => value + 1); changed();
  };
  useEffect(() => () => {
    if (draft.current) controller.features.selections.cancelSelectionDraft();
    controller.setCanvasToolDraft(false);
  }, [controller]);
  const preview = () => {
    if (points.current.length < 3) return false;
    const params = magneticLassoParams(points.current, { mode, width: edgeWidth, contrast, trace: tool === "magnetic-lasso", canvas: { width, height } });
    if (!params) return false;
    controller.setCanvasToolDraft(false);
    const result = draft.current ? controller.features.selections.updateMagneticLasso(params) : controller.features.selections.beginMagneticLasso(params);
    if (!result.ok) { invalid.current = true; controller.setCanvasToolDraft(!draft.current); message(result.message); return false; }
    draft.current = true; invalid.current = false;
    const edges = controller.features.selections.draftOutline();
    outline.current = edges.ok && Array.isArray(edges.value) ? edges.value.filter((edge): edge is number[] => Array.isArray(edge) && edge.length === 4) : [];
    changed(); return true;
  };
  const finish = () => {
    if (!preview() || invalid.current) { if (points.current.length < 3) message("至少需要三个锚点才能闭合选区"); return; }
    const result = controller.features.selections.commitSelectionDraft();
    if (!result.ok) { message(result.message); return; }
    draft.current = false; points.current = []; outline.current = []; controller.setCanvasToolDraft(false);
    update(value => value + 1); message(null); changed();
  };
  const add = (point: DocumentPoint, close = false, snapClose = true) => {
    if (!supported) return false;
    // 浏览器在第二次 pointerdown 之后还会派发 dblclick，闭合后不重新起笔。
    if (close && points.current.length === 0) return true;
    if (points.current.length === 0 && controller.hasActiveDraft()) { message("请先确认或取消当前编辑"); return true; }
    const first = points.current[0], last = points.current.at(-1);
    if (points.current.length >= 3 && (close || (snapClose && first && Math.hypot(first.x - point.x, first.y - point.y) * zoom < 6))) { finish(); return true; }
    if (points.current.length >= 4096) { message("套索锚点已达上限，请闭合或回退"); return true; }
    if (!last || Math.hypot(last.x - point.x, last.y - point.y) > .5) points.current.push({x: Math.max(0,Math.min(width,point.x)), y: Math.max(0,Math.min(height,point.y))});
    if (!draft.current) controller.setCanvasToolDraft(true);
    if (points.current.length >= 3) preview();
    update(value => value + 1); return true;
  };
  return {
    active: points.current.length > 0, revision, count: points.current.length, edgeWidth, setEdgeWidth, contrast, setContrast,
    add, finish, cancel,
    hover(point: DocumentPoint) {
      if (tool !== "magnetic-lasso" || !points.current.length || performance.now() - lastMove.current < 40) return;
      const last = points.current.at(-1)!;
      if (Math.hypot(last.x - point.x,last.y - point.y) * zoom < 6) return;
      lastMove.current = performance.now(); add(point, false, false);
    },
    back() {
      points.current.pop(); outline.current = [];
      if (points.current.length < 3 && draft.current) { controller.features.selections.cancelSelectionDraft(); draft.current = false; changed(); }
      if (points.current.length >= 3) preview();
      else controller.setCanvasToolDraft(points.current.length > 0);
      update(value => value + 1);
    },
    overlay(origin: {x:number;y:number}, scale: number) {
      if (!points.current.length) return null;
      const path = outline.current.length ? outline.current.map(([x0,y0,x1,y1]) => `M${origin.x+x0!*scale},${origin.y+y0!*scale}L${origin.x+x1!*scale},${origin.y+y1!*scale}`).join(" ")
        : points.current.map((p,i) => `${i ? "L" : "M"}${origin.x+p.x*scale},${origin.y+p.y*scale}`).join(" ");
      return <svg className="photo-editor__lasso-overlay" width="100%" height="100%"><path d={path} fill="none" stroke="white" strokeWidth="3"/><path d={path} fill="none" stroke="black" strokeDasharray="4 4"/>{points.current.map((p,i) => <circle key={i} cx={origin.x+p.x*scale} cy={origin.y+p.y*scale} r={i===0?4:2} fill="white" stroke="black"/>)}</svg>;
    }
  };
}
