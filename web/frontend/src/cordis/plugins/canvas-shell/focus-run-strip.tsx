/**
 * 聚焦（node-focus）运行反馈条
 * （change: 2026-10-12-unify-generation-history-strip，design D6）。
 *
 * 普通节点聚焦时隐藏历史圆点；片场保留内容区半透明遮罩和下缘阶段，其它聚合沿用运行遮罩。
 * 组件只消费 `RUN_STATE_SERVICE`，
 * 不写 canonical、不提交命令。
 */
import { useSyncExternalStore } from "react";
import { useOptionalService } from "../../react.js";
import type { CanvasNodeRunSummary } from "@woohaa3/contracts";
import { FILM_SET_RUN_LABELS } from "@woohaa3/contracts";

const noopSubscribe = (): (() => void) => () => undefined;
const EMPTY_RUN_STATE_SNAPSHOT = { canvasId: "", summaries: new Map<string, CanvasNodeRunSummary>(), records: [] as const };
const emptyRunStateSnapshot = (): typeof EMPTY_RUN_STATE_SNAPSHOT => EMPTY_RUN_STATE_SNAPSHOT;

/** 聚焦运行反馈：片场内容区遮罩与阶段 / 其它聚合运行遮罩。 */
export function FocusRunStrip({ canvasId, nodeId }: { canvasId: string; nodeId: string }) {
  const runState = useOptionalService("runState") as import("../service-keys.js").RunStateService | undefined;
  useSyncExternalStore(
    runState?.subscribe ?? noopSubscribe,
    runState?.snapshot ?? emptyRunStateSnapshot,
    runState?.snapshot ?? emptyRunStateSnapshot
  );
  if (!runState) return null;
  const summary: CanvasNodeRunSummary | null = runState.getNodeSummary(canvasId, nodeId);
  const isAggregate = summary?.isAggregate ?? false;
  if (summary && "filmSetFeedback" in summary) {
    const feedback = summary.filmSetFeedback;
    return feedback ? <div className="focus-run-strip focus-run-strip--film-set" data-phase={feedback.phase}>
      <span>{FILM_SET_RUN_LABELS[feedback.labelCode]}</span>
    </div> : null;
  }
  if (isAggregate) {
    const active = summary?.aggregateRunning ?? false;
    return (
      <div
        className="focus-run-strip focus-run-strip--aggregate"
        data-focus-run="aggregate"
        data-active={active ? "true" : "false"}
        aria-live="polite"
      >
        {active ? <span className="focus-run-strip__overlay">运行中</span> : null}
      </div>
    );
  }

  return null;
}
