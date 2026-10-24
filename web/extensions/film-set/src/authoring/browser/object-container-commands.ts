import { decodeFilmSetNodeData, filmSetObjectContainerId, isFilmSetNode, type CanvasCommand } from "@woohaa3/contracts";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";

/** Visibility is presentation state on the owner; the scene object stays intact. */
export async function setFilmSetObjectContainerVisible(ctx: FilmSetHostContext, filmSetNodeId: string, itemId: string, visible: boolean) {
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  if (!canvas || !ctx.canvasSession.isWritable()) return { ok: false as const, reason: "当前不可写，无法修改容器显示" };
  const data = canvas.nodeData[filmSetNodeId];
  const decoded = decodeFilmSetNodeData(data);
  if (!decoded.ok || !decoded.value.filmSetContent.items.some(item => item.id === itemId)) return { ok: false as const, reason: "片场对象已不存在" };
  const hidden = new Set(Array.isArray(data.filmSetObjectContainersHidden) ? data.filmSetObjectContainersHidden as string[] : []);
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
      if (decoded.value.filmSetContent.items.some(item => !hidden.includes(item.id) && !canvas.document.nodes.some(entry => entry.id === filmSetObjectContainerId(node.id, item.id)))) {
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
