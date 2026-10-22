/**
 * 节点右键「查看生成溯源」与溯源解析
 * （change: l0-generation-provenance）。
 *
 * 用户从一个画布产物出发，要回答「它是谁生成的、上游任务号是多少」。链路：
 *   nodeData.activeRunId / nodeData.outputAssetId
 *     → assets[].provenance.runId
 *     → jobs[] 中 runId 匹配项的 taskId
 *     → 任务监控用 taskKey 精确定位。
 * 解析到 taskKey 时在**当前画布**打开「生成溯源」浮窗（dialog），不离开画布；解析不到 taskKey
 * 时回退 canvasId + nodeId 筛选的任务监控页（列表按时间倒序，用户点最新一条即可），保持降级路径。
 *
 * 菜单项按既有 `canvas.context-menu` 扩展贡献注册（与「保存为片段…」同一模式），不另建菜单 UI；
 * 是否出现由「节点可溯源 + tasks.inspect 门禁」共同决定，与执行面板「查看任务」一致。
 */
import type { Context } from "@deepseek-ai/cordis";
import { CANVAS_MENU_SECTION, type ServerCanvas } from "@woohaa3/contracts";
import type { ContextMenuContext } from "../../contracts.js";

/** 菜单项稳定 ID（菜单选择与诊断共用）。 */
export const GENERATION_TRACE_MENU_ID = "view-generation-trace";

/** 菜单项文案。 */
export const GENERATION_TRACE_MENU_LABEL = "查看生成溯源";

/**
 * 右键菜单项（结构兼容 `CanvasContextMenuItem`）。
 *
 * 刻意不 import canvas-menu 插件的内部类型：跨插件内部 import 受架构审计约束（见
 * `cordis/architecture.test.ts`），菜单宿主只按 `canvas.context-menu` slot 契约消费。
 */
export type GenerationTraceMenuItem = {
  id: string;
  label: string;
  section: string;
  order: number;
};

/** 溯源跳转目标：`taskKey` 缺失时按 canvasId + nodeId 筛选。 */
export type GenerationTraceTarget = {
  canvasId: string;
  nodeId: string;
  /** 精确任务号；缺失表示未解析到，回退列表筛选。 */
  taskKey?: string;
};

/**
 * 画布内「生成溯源」浮窗的打开 payload：只带一次调用的身份，不带任何 React/业务闭包。
 *
 * `canvasId`/`nodeId` 用于浮窗内「在任务监控中打开」的兜底筛选，不参与精确读取。
 */
export type GenerationTraceDialogPayload = {
  taskKey: string;
  canvasId?: string;
  nodeId?: string;
};

/**
 * 解析结果 → 落点（纯函数）：有 taskKey 时优先打开**画布内浮窗**，解析不到 taskKey 时回退
 * 任务监控页筛选。浮窗打开失败（未注册/校验拒绝）同样回退页面，绝不点了没有反应。
 *
 * 返回实际落点，供诊断与测试断言。
 */
export function openGenerationTrace(
  target: GenerationTraceTarget | null,
  deps: {
    /** 打开画布内浮窗；返回是否真的入栈。 */
    openDialog?: (payload: GenerationTraceDialogPayload) => boolean;
    /** 降级路径：打开任务监控页（taskKey 精确定位或 canvasId + nodeId 筛选）。 */
    openPage: (target: GenerationTraceTarget) => void;
  }
): "dialog" | "page" | "none" {
  if (!target) return "none";
  if (target.taskKey && deps.openDialog) {
    const opened = deps.openDialog({
      taskKey: target.taskKey,
      canvasId: target.canvasId,
      ...(target.nodeId ? { nodeId: target.nodeId } : {})
    });
    if (opened) return "dialog";
  }
  deps.openPage(target);
  return "page";
}

/** 非空字符串；其余（含数字、空串、缺失）一律 null。 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 节点自身承载的产物 / 最近一次 run 身份（只读运行时字段）。 */
function traceFieldsOf(canvas: ServerCanvas, nodeId: string): { activeRunId: string | null; outputAssetId: string | null } {
  const data = canvas.nodeData[nodeId] as { activeRunId?: unknown; outputAssetId?: unknown } | undefined;
  return {
    activeRunId: nonEmptyString(data?.activeRunId),
    outputAssetId: nonEmptyString(data?.outputAssetId)
  };
}

/**
 * 解析节点对应的 run 标识：最近一次 run 优先，其次产物溯源里的 run（纯函数）。
 *
 * `activeRunId` 是 latest-run-wins 的客户端 run 身份，比资产 provenance 更新；资产 provenance
 * 在「上传/外部素材」场景可能缺失，因此两者都缺失时返回 null。
 */
export function resolveTraceRunId(canvas: ServerCanvas, nodeId: string): string | null {
  const { activeRunId, outputAssetId } = traceFieldsOf(canvas, nodeId);
  if (activeRunId) return activeRunId;
  if (!outputAssetId) return null;
  const asset = (canvas.assets ?? []).find((entry) => entry.id === outputAssetId);
  return nonEmptyString(asset?.provenance?.runId);
}

/**
 * 解析「查看生成溯源」的跳转目标（纯函数）。
 *
 * 不可溯源（节点不存在、既无产物也无最近 run）时返回 null：菜单项不出现，避免点了没有落点。
 * 可溯源但 jobs 里没有 runId 匹配项时仍返回目标，只是不带 taskKey（回退列表筛选）。
 */
export function resolveGenerationTraceTarget(
  canvas: ServerCanvas | null,
  nodeId: string
): GenerationTraceTarget | null {
  if (!canvas) return null;
  if (!canvas.document.nodes.some((node) => node.id === nodeId)) return null;
  const { activeRunId, outputAssetId } = traceFieldsOf(canvas, nodeId);
  const runId = resolveTraceRunId(canvas, nodeId);
  // 「有产物」或「有最近一次 run」即可溯源；两者都没有的节点不显示入口。
  if (!activeRunId && !outputAssetId && !runId) return null;
  const job = runId
    ? (canvas.jobs ?? []).find((entry) => entry.runId === runId && entry.nodeId === nodeId && nonEmptyString(entry.taskId))
    : undefined;
  const taskKey = nonEmptyString(job?.taskId);
  return {
    canvasId: canvas.id,
    nodeId,
    ...(taskKey ? { taskKey } : {})
  };
}

/**
 * 右键菜单项（纯函数）：只在命中节点、可溯源且具备 `tasks.inspect` 时出现。
 *
 * 无权限时**静默隐藏**而不是禁用：与执行面板「查看任务」一致（无该 action 时不渲染入口），
 * 不把全局管理数据引导给普通用户。拉线创建（`connectFrom`）不是节点动作，不出现。
 */
export function generationTraceMenuItems(input: {
  canvas: ServerCanvas | null;
  context: ContextMenuContext;
  canInspect: boolean;
}): GenerationTraceMenuItem[] {
  const { canvas, context, canInspect } = input;
  if (!canInspect) return [];
  if (!context.nodeId || context.connectFrom) return [];
  if (!resolveGenerationTraceTarget(canvas, context.nodeId)) return [];
  // 与「重命名作品 / 删除作品」同属「其他操作」section；order 让溯源排在编辑动作之前。
  return [{ id: GENERATION_TRACE_MENU_ID, label: GENERATION_TRACE_MENU_LABEL, section: CANVAS_MENU_SECTION.other, order: 10 }];
}

/** 菜单贡献依赖：由宿主插件注入，便于纯函数测试不装配 Cordis。 */
export type GenerationTraceMenuDeps = {
  /** 贡献 owner（插件 ID），用于诊断与同 ID 去重。 */
  owner: string;
  /** 读取当前 working/canonical 画布（菜单打开时实时读取，不缓存）。 */
  getCanvas: () => ServerCanvas | null;
  /** 是否有任务监控权限（与「查看任务」同一门禁）。 */
  canInspect: () => boolean;
  /** 打开画布内「生成溯源」浮窗；返回是否入栈（false 时回退任务监控页）。 */
  openTraceDialog?: (payload: GenerationTraceDialogPayload) => boolean;
  /** 降级路径：打开任务监控页（有 taskKey 精确定位，否则回退 canvasId + nodeId 筛选）。 */
  openTrace: (target: GenerationTraceTarget) => void;
};

/**
 * 注册 `canvas.context-menu` 贡献（扩展菜单项模式）。
 *
 * 返回释放函数，由插件 effect 统一撤销；宿主只按通用 slot 合并菜单项，不感知任务业务。
 */
export function registerGenerationTraceMenu(ctx: Context, deps: GenerationTraceMenuDeps): () => void {
  return ctx.slots.register("canvas.context-menu", {
    id: "generation-trace",
    owner: deps.owner,
    priority: 5,
    items: (context: ContextMenuContext) =>
      generationTraceMenuItems({ canvas: deps.getCanvas(), context, canInspect: deps.canInspect() }),
    onSelect: (itemId: string, context: ContextMenuContext) => {
      if (itemId !== GENERATION_TRACE_MENU_ID || !context.nodeId) return;
      const target = resolveGenerationTraceTarget(deps.getCanvas(), context.nodeId);
      // 有 taskKey → 画布内浮窗（不拆 Canvas page scope）；解析不到或浮窗未入栈 → 回退任务监控页筛选。
      const routed = openGenerationTrace(target, {
        ...(deps.openTraceDialog ? { openDialog: deps.openTraceDialog } : {}),
        openPage: deps.openTrace
      });
      // 只有「解析不到 taskKey」或「dialog 被参与者拒绝」才会走到页面；留一条可诊断的痕迹，
      // 避免用户只看到「莫名其妙跳走了」。开发期可在控制台确认是哪种。
      if (routed === "page") {
        // eslint-disable-next-line no-console
        console.warn("[generation-trace] 未能打开画布内浮窗，已回退任务监控页", { target });
      }
    }
  });
}
