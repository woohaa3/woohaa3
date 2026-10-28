/**
 * Skill 媒体步骤状态与用户操作
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 5.1）。
 *
 * 只在已有 Skill 步骤的节点上出现（普通生成节点完全不受影响）。面板自身不拥有生成事实：
 * 它按 `canvasId + nodeId` 读取宿主步骤快照、轮询当前尝试，并通过独立写入口停止/重新生成。
 * 重新生成总是携带**点击时的最新 draft** 与独立 requestId，不重新提交 Agent 回合，也不会
 * 重新打开被替代的旧 run。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillMediaStepView } from "@woohaa3/contracts";
import { useOptionalService } from "../../react.js";
import type { ModelExecutionDraft } from "../../contract/model-interaction.js";
import {
  createSkillRegenerateRequestId,
  resolveSkillStepActions,
  skillStepCurrentAttempt,
  skillStepHistory,
  skillStepStatusText
} from "./skill-step-status-state.js";
import "./skill-step-status.css";

/** 当前尝试仍可能在推进时的轮询间隔；终态后继续低频轮询以发现用户的替代尝试。 */
const SKILL_STEP_POLL_MS = 2_000;

export type SkillStepStatusProps = {
  nodeId: string;
  modelKey: string;
  draft: Readonly<ModelExecutionDraft>;
  writable: boolean;
  readOnly: boolean;
};

export function SkillStepStatus(props: SkillStepStatusProps) {
  const conversations = useOptionalService("agentConversationService");
  const canvasScope = useOptionalService("canvasScope");
  const canvasId = canvasScope?.canvasId();
  const [step, setStep] = useState<SkillMediaStepView | null>(null);
  const [busy, setBusy] = useState<"" | "stop" | "regenerate">("");
  const [error, setError] = useState("");
  const disposed = useRef(false);

  const refresh = useCallback(async () => {
    if (!conversations?.skillStep || !canvasId) return;
    const result = await conversations.skillStep({ canvasId, nodeId: props.nodeId });
    if (disposed.current) return;
    if (result.ok) setStep(result.value.step);
  }, [canvasId, conversations, props.nodeId]);

  useEffect(() => {
    disposed.current = false;
    void refresh();
    const timer = setInterval(() => void refresh(), SKILL_STEP_POLL_MS);
    return () => {
      disposed.current = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const stop = useCallback(async () => {
    if (!conversations?.cancelSkillStep || !canvasId || !step || busy) return;
    setBusy("stop");
    setError("");
    try {
      const result = await conversations.cancelSkillStep({
        canvasId,
        skillRunId: step.skillRunId,
        stepId: step.stepId
      });
      if (disposed.current) return;
      if (!result.ok) {
        setError(result.error || "停止请求未确认");
        return;
      }
      setStep(result.value.step);
    } finally {
      if (!disposed.current) setBusy("");
    }
  }, [busy, canvasId, conversations, step]);

  const regenerate = useCallback(async () => {
    if (!conversations?.regenerateSkillStep || !canvasId || !step || busy) return;
    setBusy("regenerate");
    setError("");
    try {
      // 使用点击时的最新 draft；请求身份每次独立，服务端按 requestId 幂等去重。
      const result = await conversations.regenerateSkillStep({
        canvasId,
        skillRunId: step.skillRunId,
        stepId: step.stepId,
        requestId: createSkillRegenerateRequestId(),
        prompt: props.draft.prompt,
        modelKey: props.modelKey,
        parameters: { ...props.draft.parameters }
      });
      if (disposed.current) return;
      if (!result.ok) {
        setError(result.error || "重新生成失败");
        return;
      }
      setStep(result.value.step);
    } finally {
      if (!disposed.current) setBusy("");
    }
  }, [busy, canvasId, conversations, props.draft, props.modelKey, step]);

  if (!step) return null;

  return (
    <SkillStepStatusView
      step={step}
      writable={props.writable}
      readOnly={props.readOnly}
      busy={busy}
      error={error}
      onStop={() => void stop()}
      onRegenerate={() => void regenerate()}
    />
  );
}

export type SkillStepStatusViewProps = {
  step: SkillMediaStepView;
  writable: boolean;
  readOnly: boolean;
  busy: "" | "stop" | "regenerate";
  error: string;
  onStop: () => void;
  onRegenerate: () => void;
};

/** 纯展示层（静态渲染测试用）。 */
export function SkillStepStatusView(props: SkillStepStatusViewProps) {
  const { step, busy, error } = props;
  const current = skillStepCurrentAttempt(step);
  const actions = resolveSkillStepActions({ step, writable: props.writable, readOnly: props.readOnly });
  const history = skillStepHistory(step);
  return (
    <section className="skill-step-status" data-state={current?.state ?? "unknown"} aria-label="Agent 生成步骤">
      <div className="skill-step-status__header">
        <strong>Agent 步骤</strong>
        <span className="skill-step-status__state">{skillStepStatusText(step)}</span>
      </div>
      {current?.state === "cancel-requested" ? (
        <p className="skill-step-status__hint">
          停止请求已发出，正在等待确认。
        </p>
      ) : null}
      {actions.needsRecovery ? (
        <p className="skill-step-status__hint">当前尝试未成功，可使用最新提示词恢复生成。</p>
      ) : null}
      {history.length > 0 ? (
        <details className="skill-step-status__history">
          <summary>历史尝试（{history.length}）</summary>
          <ul>
            {history.map((attempt) => (
              <li key={attempt.attempt} data-state={attempt.state}>
                第 {attempt.attempt} 次 · {attempt.label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <details className="skill-step-status__history">
        <summary>技术详情</summary>
        <p>步骤 {step.stepId} · 运行 {step.skillRunId} · 提示词版本 r{step.promptRevision}</p>
        {step.latestSuccessfulRunId ? <p>最近成功运行 {step.latestSuccessfulRunId}</p> : null}
        {step.attempts.map(attempt => <p key={attempt.attempt}>第 {attempt.attempt} 次 · 运行 {attempt.runId}{attempt.supersededByRunId ? ` · 接续运行 ${attempt.supersededByRunId}` : ""}{attempt.error ? ` · ${attempt.error}` : ""}</p>)}
        {error ? <p>{error}</p> : null}
      </details>
      {actions.canStop || actions.canRegenerate ? (
        <div className="skill-step-status__actions">
          {actions.canStop ? (
            <button type="button" disabled={!!busy} onClick={props.onStop}>
              {busy === "stop" ? "正在停止…" : "停止"}
            </button>
          ) : null}
          {actions.canRegenerate ? (
            <button type="button" disabled={!!busy} onClick={props.onRegenerate}>
              {busy === "regenerate" ? "正在重新生成…" : current?.state === "failed" || current?.state === "cancelled" ? "恢复生成" : "改词重新生成"}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="skill-step-status__error" role="alert">操作未完成，请重试或查看技术详情。</p> : null}
    </section>
  );
}
