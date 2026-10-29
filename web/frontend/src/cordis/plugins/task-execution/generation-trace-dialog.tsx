/**
 * 画布内「生成溯源」浮窗（dialog）
 * （change: 生成溯源改为画布内浮窗）。
 *
 * 从节点右键「查看生成溯源」打开，只渲染**一次调用**的溯源详情：正文复用
 * `shared/task-trace/task-trace-body`（与独立任务监控页详情同一组件），因此两处内容一致。
 *
 * 为什么是 dialog：跳独立页面会拆掉 Canvas page scope（Y.Doc 连接、渲染器、视口全部重建），
 * 用户只是想「看一眼这一次调用」。关闭只关浮层，画布与视口原样保留。
 *
 * 浮窗内的「在任务监控中打开」是次要入口（全局排查用），仍走既有页面导航；打开门禁仍由
 * 菜单侧的 `tasks.inspect` 判定，这里不重复放行。加载/失败都有明确状态，不静默空白。
 */
import { useEffect, useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { DialogRegistration } from "../../contracts.js";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { objectPayload } from "../../services/dialogs/registry.js";
import type { DialogRendererProps } from "../../services/dialogs/renderer-registry.js";
import type { DialogDefinition } from "../../services/dialogs/types.js";
import { Button } from "@woohaa3/ui";
import { TaskTraceBody } from "../../../shared/task-trace/task-trace-body.js";
import type { TaskMonitorRemote } from "../../../shared/task-trace/remote.js";
import type { TaskExecutionDetail } from "@woohaa3/contracts";
import type { GenerationTraceDialogPayload } from "./generation-trace.js";
import "./generation-trace-dialog.css";

/** 画布内生成溯源浮窗的稳定 dialog ID（入口与诊断共用）。 */
export const GENERATION_TRACE_DIALOG_ID = "generation-trace";

/** payload：一次调用的 taskKey（必需）与来路画布/节点（兜底筛选用，可选）。 */
export const generationTraceDialogDefinition: DialogDefinition = {
  dismissible: true,
  // 连续右键不同节点时不堆叠多个浮窗：替换 payload 即可，仍只覆盖一层。
  singleton: true,
  size: "lg",
  variant: "standard",
  validatePayload: objectPayload<GenerationTraceDialogPayload>(GENERATION_TRACE_DIALOG_ID, (payload) => {
    const taskKey = payload.taskKey;
    if (typeof taskKey !== "string" || taskKey === "") return null;
    const canvasId = typeof payload.canvasId === "string" && payload.canvasId !== "" ? payload.canvasId : undefined;
    const nodeId = typeof payload.nodeId === "string" && payload.nodeId !== "" ? payload.nodeId : undefined;
    return {
      taskKey,
      ...(canvasId ? { canvasId } : {}),
      ...(nodeId ? { nodeId } : {})
    };
  })
};

export type GenerationTraceDialogDeps = {
  /** 复用任务监控的只读查询 adapter（同一个 `createTaskMonitorRemote`）。 */
  remote: TaskMonitorRemote;
  /** 结果缩略图的受控同源地址解析（画布 scope 的 mediaRemote.urlFor，带详情画布提示）。 */
  resolveMediaUrl?: (storageKey: string, canvasId?: string) => string;
  /** 次要入口：跳到独立任务监控页做全局排查（仍然只在该权限下可见）。 */
  openTaskMonitor: (payload: GenerationTraceDialogPayload) => void;
};

type TraceLoadState =
  | { status: "loading" }
  | { status: "ready"; detail: TaskExecutionDetail }
  | { status: "error"; message: string };

/** 详情加载状态机（打开即读一次；关闭/换 payload 时中止迟到结果）。 */
function useTraceDetail(remote: TaskMonitorRemote, taskKey: string): TraceLoadState {
  const [state, setState] = useState<TraceLoadState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading" });
    void remote
      .detail({ taskKey, signal: controller.signal })
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          setState({ status: "ready", detail: outcome.value });
          return;
        }
        if (outcome.code === "aborted") return;
        setState({
          status: "error",
          // not-found 有两种成因：提交阶段就失败（Task Service 从未落记录，2026-10-21 现场）
          // 或记录已过保留期。旧文案只提「保留期」，把可排查的提交失败说成了过期。
          message:
            outcome.code === "not-found"
              ? "没有这次运行的任务记录：可能提交阶段就失败了（未调用模型），或记录已超过保留期。"
              : outcome.error
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: error instanceof Error ? error.message : "读取任务详情失败" });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [remote, taskKey]);
  return state;
}

/** 在途耗时按秒递增（终态由 `effectiveTotalMs` 冻结）。 */
function useTickingNow(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

/**
 * Dialog renderer：只读渲染一次调用的溯源详情，不写画布、不改 URL。
 *
 * Escape / 遮罩 / 关闭按钮都走 Dialog Host 的既有 close 通路（这里不自建监听）。
 */
export function createGenerationTraceRenderer(deps: GenerationTraceDialogDeps) {
  return function GenerationTraceDialog({ instance, requestClose }: DialogRendererProps) {
    const payload = instance.payload as GenerationTraceDialogPayload;
    const state = useTraceDetail(deps.remote, payload.taskKey);
    const nowMs = useTickingNow();
    const titleId = `${instance.instanceId}-title`;
    const openTaskMonitor = () => {
      // 先关浮层再导航：Canvas page scope 会被页面切换释放，避免在已释放的 scope 上再改 dialog 栈。
      requestClose();
      deps.openTaskMonitor(payload);
    };
    return (
      <Dialog.Content
        variant="standard"
        size="lg"
        className="generation-trace"
        labelledBy={titleId}
        instanceId={instance.instanceId}
        onOverlayClick={requestClose}
      >
        <DialogHeader onClose={requestClose}>
          <DialogTitle id={titleId}>生成溯源</DialogTitle>
        </DialogHeader>
        <DialogBody className="generation-trace__body">
          {state.status === "loading" ? (
            <p className="task-monitor__muted" role="status">
              正在读取任务详情…
            </p>
          ) : null}
          {state.status === "error" ? (
            <div className="task-monitor__error-block" role="alert">
              <strong>读取任务详情失败</strong>
              <p>{state.message}</p>
              {/* 没有记录时，任务号是用户唯一能拿去对日志/重试的稳定身份。 */}
              <p className="task-monitor__muted">任务号：{payload.taskKey}</p>
              <Button size="sm" tone="ghost" onClick={openTaskMonitor}>
                在任务监控中打开
              </Button>
            </div>
          ) : null}
          {state.status === "ready" ? (
            <TaskTraceBody
              detail={state.detail}
              error={null}
              loading={false}
              nowMs={nowMs}
              resolveMediaUrl={deps.resolveMediaUrl}
            />
          ) : null}
        </DialogBody>
        <DialogFooter>
          {state.status === "ready" ? (
            <Button size="sm" tone="ghost" onClick={openTaskMonitor}>
              在任务监控中打开
            </Button>
          ) : null}
          <Button size="sm" tone="primary" onClick={requestClose}>
            关闭
          </Button>
        </DialogFooter>
      </Dialog.Content>
    );
  };
}

/** 在 Canvas scope 注册浮窗（definition + renderer）；返回注销函数，由插件 effect 统一撤销。 */
export function registerGenerationTraceDialog(ctx: Context, deps: GenerationTraceDialogDeps): () => void {
  const registration: DialogRegistration = {
    definition: generationTraceDialogDefinition,
    renderer: createGenerationTraceRenderer(deps)
  };
  return ctx.dialogs.registerDialog(GENERATION_TRACE_DIALOG_ID, registration);
}
