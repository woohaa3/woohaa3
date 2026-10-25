import { FILM_SET_MAX_VISIBLE_OBJECTS, filmSetVisibleObjectIds, decodeFilmSetNodeData, filmSetObjectContainerId, isFilmSetNode, type CanvasCommand } from "@woohaa3/contracts";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";

/** Visibility is presentation state on the owner; the scene object stays intact. */
export async function setFilmSetObjectContainerVisible(ctx: FilmSetHostContext, filmSetNodeId: string, itemId: string, visible: boolean) {
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  if (!canvas || !ctx.canvasSession.isWritable()) return { ok: false as const, reason: "当前不可写，无法修改容器显示" };
  const data = canvas.nodeData[filmSetNodeId];
  const decoded = decodeFilmSetNodeData(data);
  if (!decoded.ok || !decoded.value.filmSetContent.items.some(item => item.id === itemId)) return { ok: false as const, reason: "片场对象已不存在" };
  const hidden = new Set(Array.isArray(data.filmSetObjectContainersHidden) ? data.filmSetObjectContainersHidden as string[] : []);
  const visibleIds = new Set(filmSetVisibleObjectIds(decoded.value.filmSetContent.items.map(item => item.id), [...hidden]));
  if (visible && !visibleIds.has(itemId) && visibleIds.size >= FILM_SET_MAX_VISIBLE_OBJECTS) return { ok: false as const, reason: `每个片场最多外显 ${FILM_SET_MAX_VISIBLE_OBJECTS} 个对象，请先关闭一个容器` };
  // Materialize effective defaults before editing a legacy scene with more than six objects.
  for (const item of decoded.value.filmSetContent.items) if (!visibleIds.has(item.id)) hidden.add(item.id);
  if (visible) hidden.delete(itemId); else hidden.add(itemId);
  return ctx.canvasEdit.record([{ type: "nodeData.patch", nodeId: filmSetNodeId, value: { filmSetObjectContainersHidden: [...hidden].sort() } }], visible ? "显示对象容器" : "关闭对象容器");
}

/** Upgrade existing scenes on opening without adding an artificial user undo step. */
export function installDefaultFilmSetObjectContainers(ctx: FilmSetHostContext): () => void {
  const pending = new Set<string>();
  let alive = true;
  const reconcile = () => {
    if (!alive || !ctx.canvasSession.isWritable()) return;
    const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
    if (!canvas || pending.has(canvas.id)) return;
    const commands: CanvasCommand[] = [];
    for (const node of canvas.document.nodes) {
      const data = canvas.nodeData[node.id];
      if (!isFilmSetNode(node.type, data)) continue;
      const decoded = decodeFilmSetNodeData(data);
      if (!decoded.ok) continue;
      const hidden = Array.isArray(data.filmSetObjectContainersHidden) ? data.filmSetObjectContainersHidden as string[] : [];
      const visible = new Set(filmSetVisibleObjectIds(decoded.value.filmSetContent.items.map(item => item.id), hidden));
      const overflow = decoded.value.filmSetContent.items.some(item => !hidden.includes(item.id) && !visible.has(item.id));
      if (overflow || [...visible].some(id => !canvas.document.nodes.some(entry => entry.id === filmSetObjectContainerId(node.id, id)))) {
        // A presentation-neutral patch invokes the canonical default-container invariant.
        commands.push({ type: "nodeData.patch", nodeId: node.id, value: {} });
      }
    }
    if (!commands.length) return;
    pending.add(canvas.id);
    const submitted = ctx.canvasSession.submitCommands(commands, `film-object-defaults-${crypto.randomUUID()}`);
    if (submitted.ok) void submitted.handle.settled.then(() => pending.delete(canvas.id), () => pending.delete(canvas.id));
    else pending.delete(canvas.id);
  };
  const unsubState = ctx.canvasState.subscribe(reconcile);
  const unsubSession = ctx.canvasSession.subscribe(reconcile);
  reconcile();
  return () => { alive = false; unsubState(); unsubSession(); pending.clear(); };
}
