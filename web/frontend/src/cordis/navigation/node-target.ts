/**
 * 打开画布时的一次性节点目标（任务监控 / 任务历史 → 画布往返）
 * （change: task-monitor-canvas-roundtrip）。
 *
 * 页面跳转只把 `nodeId` 当**目标**写进 URL：Router 解析后由 page scope 在画布壳就绪时
 * 调用这里定位并选中该节点。它不是 presentation 状态（不写 mode/panel），也不进入规范
 * 画布数据；只在打开画布时消费一次。
 *
 * 画布数据（canonical store）与渲染宿主（interaction controller）都异步就绪，且到达顺序
 * 不固定，因此这里同时订阅 store 变化并在未成功时定时兜底重试；成功一次即结束。定位复用
 * `canvasLocate` 的既有语义（平移视口 + 选中节点），不把用户直接甩进沉浸聚焦工作区。
 */
import type { Context } from "@deepseek-ai/cordis";

/** 只依赖目标节点存在性；不复制 ServerCanvas 类型。 */
export type CanvasNodeTargetCanvas = {
  document: { nodes: ReadonlyArray<{ id: string }> };
};

export type CanvasNodeTargetEnvironment = {
  getCanvas(): CanvasNodeTargetCanvas | null;
  /** 定位并选中节点；返回失败表示画布宿主尚未就绪，而不是目标不存在。 */
  locate(nodeId: string): { ok: boolean; reason?: string };
  /** 画布 store 变化（数据到达/刷新）时立即重试。 */
  subscribe?(listener: () => void): () => void;
  /** 定时兜底（渲染宿主晚于数据就绪）。返回取消函数。 */
  schedule?(task: () => void, delayMs: number): () => void;
  /** 最多尝试次数（含首次）；缺省 60 次约 15 秒。 */
  maxAttempts?: number;
  /** 重试间隔；缺省 250ms。 */
  retryDelayMs?: number;
};

const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 60;

function defaultSchedule(task: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(task, delayMs);
  return () => globalThis.clearTimeout(timer);
}

/**
 * 等待画布上出现目标节点并定位一次；返回清理函数（换画布/离开画布/卸载时调用）。
 *
 * 目标节点最终不存在（已删除或 URL 过期）时静默结束：不做可见报错，也不改导航，
 * 避免一次失效深链接阻塞画布打开。
 */
export function locateOpenedNode(nodeId: string, environment: CanvasNodeTargetEnvironment): () => void {
  const maxAttempts = Math.max(1, environment.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = environment.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const schedule = environment.schedule ?? defaultSchedule;
  let attempts = 0;
  let finished = false;
  let cancelRetry: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  const settle = () => {
    if (finished) return;
    finished = true;
    cancelRetry?.();
    cancelRetry = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  const attempt = () => {
    if (finished) return;
    cancelRetry?.();
    cancelRetry = null;
    attempts += 1;
    const canvas = environment.getCanvas();
    const present = canvas?.document.nodes.some((node) => node.id === nodeId) ?? false;
    if (present && environment.locate(nodeId).ok) {
      settle();
      return;
    }
    if (attempts >= maxAttempts) {
      settle();
      return;
    }
    cancelRetry = schedule(attempt, retryDelayMs);
  };

  // 监听注册在首次尝试之前：数据可能在尝试之间到达，错过一次通知就要等下一次定时兜底。
  unsubscribe = environment.subscribe?.(attempt) ?? null;
  attempt();
  return settle;
}

type CanvasStateService = {
  getCanvas(): CanvasNodeTargetCanvas | null;
  subscribe(listener: () => void): () => void;
};

type CanvasLocateServiceLike = {
  locateNodes(nodeIds: readonly string[]): { ok: boolean; reason?: string };
};

/**
 * 从 Canvas page scope 装配上下文取服务并启动定位（page scope 调用）。
 *
 * `canvasLocate` 由画布插件在 install 之后提供，必须惰性读取；`canvasState` 在本 scope
 * 安装期即提供。缺少任一服务时退化为 no-op（恢复页/准备态没有完整画布）。
 */
export function attachOpenedNodeTarget(
  ctx: Context,
  nodeId: string,
  options: Pick<CanvasNodeTargetEnvironment, "maxAttempts" | "retryDelayMs"> = {}
): () => void {
  const state = ctx.get("canvasState" as never) as CanvasStateService | undefined;
  if (!state) return () => undefined;
  return locateOpenedNode(nodeId, {
    getCanvas: () => state.getCanvas(),
    subscribe: (listener) => state.subscribe(listener),
    locate: (id) => {
      const locate = ctx.get("canvasLocate" as never) as CanvasLocateServiceLike | undefined;
      return locate?.locateNodes([id]) ?? { ok: false, reason: "画布定位服务不可用" };
    },
    ...options
  });
}
