/**
 * ChatGPT 生成面板的状态与降级视图
 * （change: 2026-10-10-unify-extension-frontend-entry；由 `generation-panel.tsx` 拆出，
 *  change: 2026-10-12-add-agent-conversation-panel 新增 Agent 权威回合状态区）。
 *
 * 只做展示：权威回合状态、本地 run 阶段、授权降级与 LLM 回复折叠。状态与提交语义仍由
 * `ChatGptGenerationPanel` 持有；拆分不改变 DOM 结构与样式类。
 */
import { useEffect, useState } from "react";
import { Button } from "@woohaa3/ui/primitives";
import type { ConversationTurn } from "@woohaa3/contracts";
import type { ChatGptRunState } from "./service.js";

/**
 * Agent 权威回合的状态区：展示真实阶段/结果摘要与恢复入口。
 *
 * - 非终态：显示阶段与停止（取消只停止后续执行并核对已提交结果，不宣称撤销）；
 * - 终态：显示权威结果摘要与失败原因，失败走统一重试/详情入口。
 */
export function AgentTurnStatus(props: {
  turn: ConversationTurn | null;
  onCancel?: () => void;
}) {
  const turn = props.turn;
  if (!turn) return null;
  const status = turn.status;
  const label = TURN_STATUS_LABEL[status] ?? status;
  const active = status === "queued" || status === "running" || status === "committing";
  return (
    <div className="chatgpt-generate__status" data-phase={status} role={active ? "status" : "alert"} aria-live="polite">
      {active ? <span className="chatgpt-generate__spinner" aria-hidden="true" /> : null}
      <span className="chatgpt-generate__badge" data-tone={status === "failed" ? "danger" : status === "succeeded" ? "success" : undefined}>
        {label}
      </span>
      {active && props.onCancel ? (
        <Button size="sm" tone="neutral" onClick={props.onCancel}>
          停止
        </Button>
      ) : null}
      {turn.error ? (
        <span className="chatgpt-generate__stage" title={turn.error.message}>
          {turn.error.message}
        </span>
      ) : null}
    </div>
  );
}

export const TURN_STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "正在执行",
  committing: "正在校验并写入画布…",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已停止"
};

/**
 * 生成过程状态条：展示当前阶段、已用时长、进度动效与取消。
 *
 * 推理过程必须对用户有可见反馈（design D5）；草稿/运行状态属于插件 scope，不写入共享画布，
 * 因此这里在面板内呈现，而不是改动画布节点规范状态。
 * 收到推理完成不提前显示成功——只有权威提交回执（succeeded）才显示成功。
 */
export function GenerationStatus(props: {
  run: ChatGptRunState;
  modelsError?: string;
  onCancel: () => void;
}) {
  const run = props.run;
  const running = run.phase === "running";
  const elapsed = useElapsedSeconds(running ? run.startedAt : null);

  if (run.phase === "running") {
    return (
      <div className="chatgpt-generate__status" data-phase="running" role="status" aria-live="polite">
        <span className="chatgpt-generate__spinner" aria-hidden="true" />
        <span className="chatgpt-generate__stage">{stageLabel(run.progress)}</span>
        <span className="chatgpt-generate__elapsed">{formatElapsed(elapsed)}</span>
        <Button size="sm" tone="neutral" onClick={props.onCancel}>
          取消
        </Button>
      </div>
    );
  }
  if (run.phase === "succeeded") {
    return (
      <div className="chatgpt-generate__status" data-phase="succeeded" role="status" aria-live="polite">
        <span className="chatgpt-generate__badge" data-tone="success">
          已完成
        </span>
        <span className="chatgpt-generate__stage" title={run.llmOutput}>已写入原节点</span>
        <LlmReply output={run.llmOutput} />
      </div>
    );
  }
  if (run.phase === "partial") {
    const failedText = run.failed.map((entry) => `${entry.part}：${entry.message}`).join("；");
    return (
      <div className="chatgpt-generate__status" data-phase="partial" role="alert">
        <span className="chatgpt-generate__badge" data-tone="warn">
          部分完成
        </span>
        <span className="chatgpt-generate__stage" title={run.llmOutput}>
          已更新{run.applied.join("、")}；未完成：{failedText}
        </span>
        <LlmReply output={run.llmOutput} />
      </div>
    );
  }
  if (run.phase === "failed") {
    return (
      <div className="chatgpt-generate__status" data-phase="failed" role="alert">
        <span className="chatgpt-generate__badge" data-tone="danger">
          失败
        </span>
        <span className="chatgpt-generate__stage" title={run.llmOutput}>{run.message}</span>
        <LlmReply output={run.llmOutput} />
      </div>
    );
  }
  if (props.modelsError) {
    return (
      <p className="chatgpt-generate__models-error" role="note">
        {props.modelsError}
      </p>
    );
  }
  return null;
}

/** 运行中每 0.5s 刷新一次的已用秒数（停止时归零）。 */
function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === null) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** 后端 SSE 阶段 → 可读中文文案。 */
function stageLabel(stage: string): string {
  switch (stage) {
    case "queued":
      return "排队中…";
    case "reasoning":
      return "正在推理生成…";
    case "committing":
      return "正在校验并写入画布…";
    case "提交中…":
      return "提交中…";
    default:
      return stage || "生成中…";
  }
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

/** 授权不可用时的降级视图：同一面板外观内提示授权/重新授权。 */
export function AuthFallback(props: {
  loading?: boolean;
  state?: string;
  message?: string | null;
  onAuthorize?: () => void;
}) {
  const needsReauth = props.state === "connected-without-plan" || props.state === "reauthorization-required";
  return (
    <div className="chatgpt-generate chatgpt-generate--auth" data-state={props.state ?? "unknown"}>
      <div className="mc-panel" data-surface="dock" role="region" aria-label="ChatGPT 生成">
        <p className="chatgpt-generate__hint" role="status">
          {props.loading ? "正在读取 ChatGPT 授权状态…" : authMessage(props.state, props.message)}
        </p>
        {props.onAuthorize ? (
          <div className="chatgpt-generate__actions">
            <Button size="sm" tone="primary" onClick={props.onAuthorize}>
              {needsReauth ? "重新授权" : "授权 ChatGPT"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function authMessage(state: string | undefined, message: string | null | undefined): string {
  if (message) return message;
  switch (state) {
    case "authorizing":
      return "正在等待授权完成…";
    case "connected-without-plan":
      return "已登录，但未同意使用 ChatGPT 订阅额度。";
    case "reauthorization-required":
      return "授权已失效，请重新授权。";
    case "disconnected":
      return "尚未授权个人 ChatGPT。";
    default:
      return "授权状态不可用。";
  }
}

function LlmReply({ output }: { output?: string }) {
  return output ? <details><summary>查看 LLM 回复</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{output}</pre></details> : null;
}
