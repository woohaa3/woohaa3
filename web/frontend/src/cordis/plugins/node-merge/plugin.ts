/**
 * 同类型节点合并插件
 * （change: 2026-10-27-merge-same-type-node-history，任务 2.3 / 2.4 / design D2–D4）。
 *
 * 职责：
 * - 拖动期把 `nodeMerge.preview` 转成 DOM 高亮（rAF 合帧，viewport/画布变更重算）；
 * - 释放时确认合并：复用共享 `AlertDialog` + `registerAlertAction`，打开即生成 `operationId`；
 * - 确认后调用 `ctx.canvasRemote.mergeNodeHistory`（唯一写面在 Canvas Service），成功后选中目标
 *   节点；失败保留弹窗并在框内显示稳定原因，画布保持不变（不提交任何本地命令）。
 *
 * 合并不可撤销（design D4）：确认文案明确说明；本插件不记录前端撤销栈。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { isMergeEligibleNode, type ServerCanvas } from "@woohaa3/contracts";
import { definePlugin } from "../../plugin.js";
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";
import { nodeMerge, type NodeMergeDrag } from "../../services/node-merge/index.js";
import type { NodeHistoryResult } from "../../contracts.js";
import { INLINE_HISTORY_SERVICE, type InlineHistoryService } from "../service-keys.js";
import { createNodeMergeOverlay } from "./merge-overlay.js";

export const NODE_MERGE_PLUGIN_ID = "node-merge";

/** AlertAction key 前缀；每个确认框使用一个一次性 key。 */
export const NODE_MERGE_ACTION_PREFIX = "node-merge:";

/**
 * 打开确认框时生成的操作身份（design D7）：确认与重试复用同一个，服务端据此幂等。
 *
 * 优先 `crypto.randomUUID`；不可用时回退时间戳 + 随机段（测试/老浏览器）。
 */
export function newNodeMergeOperationId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID();
  return `node-merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 节点标题（缺省回退稳定文案；不暴露内部 id）。 */
function nodeTitleOf(canvas: ServerCanvas, nodeId: string): string {
  const title = (canvas.nodeData[nodeId] as { title?: unknown } | undefined)?.title;
  return typeof title === "string" && title.trim() !== "" ? title.trim() : "未命名节点";
}

/**
 * 合并失败的可读原因（稳定错误码 → 用户文案）。
 *
 * 服务端在提交前拒绝时画布与历史都不变；这里只负责解释，不触发重试或回滚。
 */
export function nodeMergeFailureText(code: string, fallback: string): string {
  switch (code) {
    case "NODE_HISTORY_NOT_FOUND":
      return "节点已不存在，合并已取消。";
    case "NODE_HISTORY_INVALID":
      return "这两类节点不能合并：只有同类型的文本、图片、视频、音频与 3D 模型可以合并。";
    case "NODE_HISTORY_CONFLICT":
      return "节点内容已变化或有进行中的生成/编辑，请稍后再试。";
    case "NODE_HISTORY_UNRECOVERABLE":
      // 服务端把「没有与当前内容匹配的历史条目」和「条目媒体不可恢复」都归到这个稳定码；
      // 具体原因（例如来源是复制/导入节点、从未登记版本）只有服务端 message 知道，优先展示它。
      return fallback.trim() !== "" ? fallback : "来源节点的当前版本不可恢复，未执行合并。";
    case "NODE_HISTORY_MERGE_FAILED":
      return "合并未完成，画布与历史保持原状，请稍后重试。";
    case "unavailable":
      return "无法连接画布服务，请检查连接后重试。";
    default:
      return fallback.trim() !== "" ? fallback : "合并失败，请稍后重试。";
  }
}

export function nodeMergeExtension(): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    const overlay = createNodeMergeOverlay(ctx.canvasRuntime);
    let currentDrag: NodeMergeDrag | null = null;
    let frame: number | null = null;
    let disposed = false;
    // 同帧合并：一帧内多次 preview 只刷新一次，并读取最新的 working/画布状态。
    const clear = () => {
      currentDrag = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      overlay.clear();
    };
    const refresh = () => {
      if (disposed || !currentDrag || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (disposed || !currentDrag) return;
        overlay.update(ctx.canvasState.getWorkingCanvas(), currentDrag);
      });
    };
    const unsubscribeViewport = ctx.canvasRuntime.subscribeViewport(refresh);
    const unsubscribeCanvas = ctx.canvasState.subscribe(refresh);

    /** 释放前重新校验并打开确认框；返回 `false` 表示不消费释放。 */
    const openConfirm = (drag: NodeMergeDrag, canvas: ServerCanvas): boolean => {
      const sourceNodeId = drag.sourceNodeIds[0];
      if (!sourceNodeId) return false;
      const source = canvas.document.nodes.find((node) => node.id === sourceNodeId);
      const target = canvas.document.nodes.find((node) => node.id === drag.targetNodeId);
      // 拖动期间的画布可能已被并发修改：候选失效时交回普通移动。
      if (!source || !target || source.type !== target.type) return false;
      if (!isMergeEligibleNode({ node: source, data: canvas.nodeData[source.id] })) return false;
      if (!isMergeEligibleNode({ node: target, data: canvas.nodeData[target.id] })) return false;

      const canvasId = canvas.id;
      const operationId = newNodeMergeOperationId();
      const actionKey = `${NODE_MERGE_ACTION_PREFIX}${operationId}`;
      let instanceId: string | null = null;
      let disposeAction: (() => void) | null = null;
      let unsubscribe: (() => void) | null = null;
      let inFlight: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
      const settle = () => {
        disposeAction?.();
        disposeAction = null;
        unsubscribe?.();
        unsubscribe = null;
      };
      disposeAction = ctx.dialogs.registerAlertAction(actionKey, () => {
        // 重复点击（同一弹窗多次确认）共用同一个在途请求：服务端幂等之外再加一层本地护栏。
        if (inFlight) return inFlight;
        inFlight = (async () => {
          const result: NodeHistoryResult<unknown> = await ctx.canvasRemote.mergeNodeHistory({
            canvasId,
            targetNodeId: target.id,
            sourceNodeId: source.id,
            operationId
          });
          if (!result.ok) {
            // 保留弹窗、退出 busy 并显示稳定原因；画布不变。
            return { ok: false as const, error: nodeMergeFailureText(result.code, result.error) };
          }
          settle();
          if (instanceId) ctx.dialogs.close(instanceId);
          ctx.canvasRuntime.controller()?.selectNode(target.id);
          // 合并写入历史但不一定改变目标内容 identity（同图合并时 outputAssetId 不变），
          // canvas store 的增量同步不会触发内联历史刷新；显式按目标节点失效缓存，
          // 让已打开的历史面板与节点历史条立即出现新增版本。
          const history = ctx.get(INLINE_HISTORY_SERVICE as never) as InlineHistoryService | undefined;
          void history?.refreshNode(target.id);
          return { ok: true as const };
        })().finally(() => {
          inFlight = null;
        });
        return inFlight;
      });
      const opened = ctx.dialogs.open({
        dialogId: ALERT_DIALOG_ID,
        payload: {
          title: "合并同类型节点",
          description:
            `把「${nodeTitleOf(canvas, source.id)}」的当前版本与全部历史版本合并到`
            + `「${nodeTitleOf(canvas, target.id)}」，并删除来源节点。此操作不可撤销。`,
          confirmLabel: "合并",
          cancelLabel: "取消",
          danger: true,
          actionKey
        }
      });
      if (!opened.ok) {
        settle();
        return false;
      }
      instanceId = opened.instance.instanceId;
      // 取消/其它关闭释放一次性 action；确认成功路径已经在 action 内 settle。
      unsubscribe = ctx.dialogs.subscribe(() => {
        if (instanceId && !ctx.dialogs.find(instanceId)) settle();
      });
      return true;
    };

    const unbind = nodeMerge.bind({
      preview: (drag) => {
        if (!drag) {
          clear();
          return;
        }
        currentDrag = drag;
        refresh();
      },
      drop: (drag) => {
        const canvas = ctx.canvasState.getWorkingCanvas();
        if (!canvas) return false;
        // 释放即结束拖动：先移除高亮；拒绝时 source 走普通移动。
        clear();
        return openConfirm(drag, canvas);
      }
    });

    ctx.effect(() => () => {
      disposed = true;
      unbind();
      unsubscribeViewport();
      unsubscribeCanvas();
      clear();
    }, "node-merge-dispatch");
  }, { name: NODE_MERGE_PLUGIN_ID, inject: ["canvasState", "canvasRuntime", "dialogs", "canvasRemote"] });
}
