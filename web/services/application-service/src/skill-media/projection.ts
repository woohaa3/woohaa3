/**
 * Skill 步骤读模型投影（纯函数）
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 2.2 / 4.3）。
 */
import { isSafeSkillMediaText, type SkillMediaAttemptView, type SkillMediaStepView } from "@woohaa3/contracts";
import type { SkillMediaAttemptRecord, SkillMediaStepRecord } from "./records.js";

export function safeSkillError(message: string | null | undefined): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (trimmed === "") return undefined;
  const bounded = trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
  return isSafeSkillMediaText(bounded) ? bounded : "生成失败（错误详情已隐藏）";
}

export function toAttemptView(step: SkillMediaStepRecord, attempt: SkillMediaAttemptRecord): SkillMediaAttemptView {
  const superseded = attempt.supersededByAttempt !== null || attempt.supersededByRunId !== null;
  return {
    skillRunId: attempt.skillRunId,
    stepId: attempt.stepId,
    attempt: attempt.attempt,
    promptRevision: attempt.promptRevision,
    runId: attempt.runId,
    requestId: attempt.requestId,
    state: attempt.state,
    current: attempt.attempt === step.currentAttempt,
    superseded,
    ...(attempt.supersededByAttempt !== null ? { supersededByAttempt: attempt.supersededByAttempt } : {}),
    ...(attempt.supersededByRunId !== null ? { supersededByRunId: attempt.supersededByRunId } : {}),
    ...(attempt.modelKey !== null ? { modelKey: attempt.modelKey } : {}),
    ...(attempt.jobId !== null ? { jobId: attempt.jobId } : {}),
    ...(attempt.mediaKind !== null ? { mediaKind: attempt.mediaKind as SkillMediaAttemptView["mediaKind"] } : {}),
    ...(attempt.error !== null ? { error: safeSkillError(attempt.error) } : {}),
    prompt: attempt.prompt,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    ...(attempt.settledAt !== null ? { settledAt: attempt.settledAt } : {})
  };
}

export function toStepView(step: SkillMediaStepRecord, attempts: SkillMediaAttemptRecord[]): SkillMediaStepView {
  const latestSuccess = step.latestSuccessfulRunId
    ? attempts.find((entry) => entry.runId === step.latestSuccessfulRunId && entry.state === "succeeded")
    : undefined;
  return {
    canvasId: step.canvasId,
    nodeId: step.nodeId,
    ...(step.rootGroupId !== null ? { rootGroupId: step.rootGroupId } : {}),
    ...(step.scopeEpoch !== null ? { scopeEpoch: step.scopeEpoch } : {}),
    skillRunId: step.skillRunId,
    stepId: step.stepId,
    currentAttempt: step.currentAttempt,
    ...(step.currentRunId !== null ? { currentRunId: step.currentRunId } : {}),
    promptRevision: step.promptRevision,
    ...(step.latestSuccessfulRunId !== null ? { latestSuccessfulRunId: step.latestSuccessfulRunId } : {}),
    ...(latestSuccess
      ? { latestSuccess: { attempt: latestSuccess.attempt, promptRevision: latestSuccess.promptRevision, runId: latestSuccess.runId } }
      : {}),
    attempts: attempts.map((attempt) => toAttemptView(step, attempt)),
    createdAt: step.createdAt,
    updatedAt: step.updatedAt
  };
}

export function currentAttemptOf(
  step: SkillMediaStepRecord,
  attempts: SkillMediaAttemptRecord[]
): SkillMediaAttemptRecord | undefined {
  return attempts.find((entry) => entry.attempt === step.currentAttempt);
}
