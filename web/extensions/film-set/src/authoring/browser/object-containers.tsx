import {
  decodeModel3DNodeData, filmSetObjectOwnershipOf, filmSetItemEditHash,
  modelSourceHash, replaceFilmSetObjectModel, resolveFilmSetObject
} from "@woohaa3/contracts";
import type { FilmSetHostContext as FilmSetContext } from "../../state/browser/host-ports.js";
import { installDefaultFilmSetObjectContainers } from "./object-container-commands.js";

/** Film-set owns snapshot replacement; the shared composite child panel owns its presentation. */
export function installFilmSetObjectContainers(ctx: FilmSetContext, feedback = new Map<string, string>()): () => void {
  const releases: (() => void)[] = [];
  const pending = new Set<string>();
  let alive = true;
  const report = (id: string, message: string) => { if (alive) { feedback.set(id, message); ctx.compositeAssets.invalidate(); } };
  try {
    releases.push(installDefaultFilmSetObjectContainers(ctx));
    releases.push(ctx.slots.register("canvas.node-drop", {
      id: "film-set-object-replacement", owner: "film-set", nodeType: "composite-asset", dropLabel: "放开以替换对象模型（复制快照）",
      matchesTarget: ({ canvas, targetNodeId }) => !!filmSetObjectOwnershipOf(canvas.nodeData[targetNodeId]),
      acceptsSources: ({ canvas, sourceNodeIds }) => sourceNodeIds.length === 1 && canvas.document.nodes.some(node => node.id === sourceNodeIds[0] && node.type === "model3d"),
      onPreview: ({ canvas, sourceNodeIds }) => sourceNodeIds.length === 1 && canvas.document.nodes.some(node => node.id === sourceNodeIds[0] && node.type === "model3d") ? null : "一次只能拖入一个普通 3D 模型",
      onDrop({ canvas, targetNodeId, sourceNodeIds }) {
        const target = resolveFilmSetObject(canvas, targetNodeId);
        if (!target || !ctx.canvasSession.isWritable()) { report(targetNodeId, "当前不可写或对象已不存在"); return true; }
        if (pending.has(targetNodeId)) { report(targetNodeId, "正在替换，请等待完成"); return true; }
        const source = sourceNodeIds.length === 1 ? canvas.document.nodes.find(node => node.id === sourceNodeIds[0] && node.type === "model3d") : null;
        const decoded = source ? decodeModel3DNodeData(canvas.nodeData[source.id]) : null;
        if (!source || !decoded?.ok) { report(targetNodeId, "一次只能拖入一个已就绪的普通 3D 模型"); return true; }
        const op = { kind: "replace-model" as const, sourceNodeId: source.id, expectedSourceHash: modelSourceHash(decoded.value.model.modelScript), expectedModelHash: decoded.value.model.contentVersion.contentHash, expectedItemHash: filmSetItemEditHash(target.item), importedAt: new Date().toISOString() };
        const plan = replaceFilmSetObjectModel({ animation: target.animation, itemId: target.item.id, sourceData: canvas.nodeData[source.id], ...op });
        if (!plan.ok) { report(targetNodeId, plan.reason); return true; }
        pending.add(targetNodeId); report(targetNodeId, "正在替换模型…");
        void ctx.canvasEdit.record([{ type: "filmSet.itemPatch", nodeId: target.owner.filmSetNodeId, itemId: target.item.id, op }], "替换片场对象模型")
          .then(result => report(targetNodeId, result.ok ? (plan.disabledClips.length ? `模型已替换；${plan.disabledClips.join("、")}的对象动作不兼容，已停用，可撤销恢复` : "模型已替换 · 来源后续修改不会同步") : result.reason))
          .catch(() => report(targetNodeId, "模型替换失败，请重试"))
          .finally(() => { pending.delete(targetNodeId); });
        return true;
      }
    }));

  } catch (error) { for (const release of releases.reverse()) release(); throw error; }
  return () => { alive = false; for (const release of releases.reverse()) release(); feedback.clear(); pending.clear(); };
}
