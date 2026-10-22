/**
 * 遥测复盘页的状态面板：五种状态各有专属文案，互不合并
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.4 / design D9/D11 + spec）。
 *
 * 「没有记录」「记录已关闭」「存储不可用」是三种不同的事实：
 * - 没有记录 = 功能在跑、只是还没发生过；
 * - 记录已关闭 = 用户自己关了，代价是**事后无法复盘**，必须明说并给出开启入口；
 * - 存储不可用 = 故障，要给出文件路径并保证不自动删除用户数据。
 * 合并成"暂无数据"会让复盘在最需要线索时失去线索。
 */
import { Button } from "../../shared/ui/index.js";
import type { TelemetryViewState } from "./model.js";

export type TelemetryStatePanelProps = {
  state: Exclude<TelemetryViewState, { kind: "ready" }>;
  onRetry?: () => void;
  onOpenSettings?: () => void;
  onClearFilters?: () => void;
};

export function TelemetryStatePanel({ state, onRetry, onOpenSettings, onClearFilters }: TelemetryStatePanelProps) {
  if (state.kind === "loading") {
    return (
      <div className="telemetry__state" role="status" data-testid="telemetry-state-loading">
        <p className="telemetry__state-title">正在读取本机遥测…</p>
        <div className="telemetry__skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  if (state.kind === "service-unavailable") {
    return (
      <div className="telemetry__state is-error" role="alert" data-testid="telemetry-state-unavailable">
        <p className="telemetry__state-title">遥测服务不可用</p>
        <p className="telemetry__state-body">
          读取本机遥测失败：{state.message}。本机宿主可能未启动、路由未就绪或请求被拒绝；
          画布编辑、保存与同步不受影响。
        </p>
        {onRetry ? (
          <Button size="sm" tone="ghost" onClick={onRetry} data-testid="telemetry-retry">
            重试
          </Button>
        ) : null}
      </div>
    );
  }

  if (state.kind === "store-unavailable") {
    return (
      <div className="telemetry__state is-error" role="alert" data-testid="telemetry-state-store-unavailable">
        <p className="telemetry__state-title">本地存储不可用</p>
        <p className="telemetry__state-body">
          本机遥测数据库打不开，新的记录不会落盘；已有文件不会被自动删除或重建。业务功能不受影响。
        </p>
        {state.storePath ? (
          <p className="telemetry__state-path">
            存储位置：<code>{state.storePath}</code>
          </p>
        ) : null}
        {onRetry ? (
          <Button size="sm" tone="ghost" onClick={onRetry} data-testid="telemetry-retry">
            重试
          </Button>
        ) : null}
      </div>
    );
  }

  if (state.kind === "disabled") {
    return (
      <div className="telemetry__state" role="status" data-testid="telemetry-state-disabled">
        <p className="telemetry__state-title">本机遥测记录已关闭</p>
        <p className="telemetry__state-body">
          关闭后新事件不再记录，<strong>事后无法复盘</strong>；已记录的历史仍会保留到保留期结束。
          需要复盘时请到设置里重新打开「本机遥测记录」。
        </p>
        {onOpenSettings ? (
          <Button size="sm" onClick={onOpenSettings} data-testid="telemetry-open-settings">
            去设置里开启
          </Button>
        ) : null}
      </div>
    );
  }

  // empty
  if (state.filtered) {
    return (
      <div className="telemetry__state" role="status" data-testid="telemetry-state-empty-filtered">
        <p className="telemetry__state-title">没有匹配当前条件的事件</p>
        <p className="telemetry__state-body">放宽时间窗口或清除事件名/结果/错误码筛选后再看。</p>
        {onClearFilters ? (
          <Button size="sm" tone="ghost" onClick={onClearFilters} data-testid="telemetry-clear-filters">
            清除筛选
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="telemetry__state" role="status" data-testid="telemetry-state-empty">
      <p className="telemetry__state-title">还没有本机记录</p>
      <p className="telemetry__state-body">
        本机遥测默认开启：画布打开、保存、编辑、同步与任务终态发生时会自动记录。
        用一会儿再回来就能看到复盘数据。
      </p>
    </div>
  );
}
