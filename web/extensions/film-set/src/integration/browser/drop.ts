import { isFilmSetGroupNode } from "@woohaa3/contracts";
import { createFilmSetImportRequestId, filmSetAcceptsSources, planFilmSetImportCommand, resolveFilmSetDrop } from "../../authoring/shared/drop-planner.js";
import type { FilmSetContext } from "./context.js";

/** 失败反馈自动消失时间；成功提交立即清空。 */
const FEEDBACK_TIMEOUT_MS = 4_000;

/**
 * 片场拖入接收方（change: 2026-10-18-restrict-film-set-drop-to-models）。
 *
 * 片场只接收普通模型：`acceptsSources` 让宿主在拖动图片/视频时**不**为片场绘制接收提示，
 * 释放仍消费为明确失败（提示原因、来源回位，不导入、不回退成普通移动）。
 */
export function extendFilmSetDrop(ctx: FilmSetContext): () => void {
  let alive = true;
  let region: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = (message: string | null) => {
    if (!alive || typeof document === "undefined") return;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!region) {
      region = document.createElement("div"); region.id = "film-set-drop-feedback";
      region.setAttribute("role", "status"); region.setAttribute("aria-live", "polite");
      region.className = "film-set-drop-feedback"; document.body.appendChild(region);
    }
    region.textContent = message ?? ""; region.hidden = !message;
    if (message) timer = setTimeout(() => { timer = null; report(null); }, FEEDBACK_TIMEOUT_MS);
  };
  const remove = ctx.slots.register("canvas.node-drop", {
    id: "film-set-node-drop", owner: "film-set", nodeType: "group",
    dropLabel: "放到此处加入片场",
    matchesTarget: ({ canvas, targetNodeId }) => isFilmSetGroupNode(canvas.document.nodes.find(node => node.id === targetNodeId), canvas.nodeData[targetNodeId]),
    // 图片/视频等不受支持的来源不点亮片场提示（change: 2026-10-18 片场只接收普通模型）。
    acceptsSources: ({ canvas, targetNodeId, sourceNodeIds }) => filmSetAcceptsSources(canvas, targetNodeId, sourceNodeIds),
    // 目标 identity 由宿主 accepted 查询固定（change: 2026-10-12 片场菱形范围，design D5）：
    // preview 与 drop 使用同一 targetNodeId，不再用规范矩形中心伪造鼠标点或私有矩形复判。
    onPreview: input => { const result = resolveFilmSetDrop(input.canvas, input.sourceNodeIds, input.targetNodeId); return result && !result.ok ? result.reason : null; },
    onDrop(input) {
      const result = resolveFilmSetDrop(input.canvas, input.sourceNodeIds, input.targetNodeId);
      if (!result) { report("无法解析片场拖入目标"); return true; }
      if (!result.ok) { report(result.reason); return true; }
      // 软摘除对象拖回：不导入副本，交回普通组移动；拖动规划器会在同一批次
      // 清除 binding.detached，保留原动作脚本。
      if ("reattach" in result) return false;
      if (!ctx.canvasSession.isWritable()) { report("当前会话不可写，无法导入片场"); return true; }
      const plan = planFilmSetImportCommand({ canvas: input.canvas, target: result.target, now: new Date().toISOString() });
      if (!plan.ok) { report(`无法导入片场：${plan.reason}`); return true; }
      const commandId = `film-set-import:${input.canvas.id}:${input.targetNodeId}:${createFilmSetImportRequestId()}`;
      const receipt = ctx.canvasSession.submitCommands(plan.commands, commandId);
      if (!receipt.ok) { report(`片场导入失败：${receipt.reason}`); return true; }
      void receipt.handle.settled.then(outcome => report(outcome.state === "committed" ? null : `片场导入失败：${outcome.error ?? "命令未提交"}`)).catch(() => report("片场导入结果读取失败"));
      return true;
    }
  });
  return () => {
    alive = false;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    remove(); region?.remove(); region = null;
  };
}
