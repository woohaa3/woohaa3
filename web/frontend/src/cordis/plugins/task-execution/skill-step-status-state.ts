/**
 * Skill 步骤执行面板的纯状态投影
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 5.1 / 5.3）。
 *
 * 面板只把宿主步骤快照翻译成用户可见的状态与可用动作：
 * - `cancel-requested` **不是**「已取消」，停止按钮保持可用（可重复取消或等待终态）；
 * - 当前尝试已终态时只提供「重新生成」，不改写历史尝试；
 * - 已有更新尝试时旧尝试只作为历史核对，不参与主状态。
 *
 * 纯函数便于覆盖取消竞态与迟到旧结果的展示规则，不依赖 React 或网络。
 */
import type { SkillMediaState, SkillMediaStepView } from "@woohaa3/contracts";

/** 执行面板状态文案（活动面板另有按行样式，但语义相同）。 */
export const SKILL_STEP_STATE_LABELS: Record<SkillMediaState, string> = {
  queued: "排队中",
  running: "生成中",
  "cancel-requested": "取消中（等待确认）",
  cancelled: "已取消",
  superseded: "已被后续尝试替代",
  succeeded: "已完成",
  failed: "失败"
};

export function skillStepCurrentAttempt(step: SkillMediaStepView) {
  return step.attempts.find((attempt) => attempt.attempt === step.currentAttempt);
}

export function skillStepIsActive(step: SkillMediaStepView): boolean {
  const state = skillStepCurrentAttempt(step)?.state;
  return state === "queued" || state === "running" || state === "cancel-requested";
}

export type SkillStepActions = {
  /** 停止：当前尝试仍在排队/执行，或等待 Provider 确认取消。 */
  canStop: boolean;
  /** 重新生成：只要步骤存在且画布可写就允许；它创建新的 attempt，不覆盖旧历史。 */
  canRegenerate: boolean;
  /** 当前尝试失败/取消后仍需恢复入口。 */
  needsRecovery: boolean;
};

export function resolveSkillStepActions(input: {
  step: SkillMediaStepView;
  writable: boolean;
  readOnly: boolean;
}): SkillStepActions {
  const state = skillStepCurrentAttempt(input.step)?.state ?? "failed";
  const writable = input.writable && !input.readOnly;
  return {
    canStop: writable && (state === "queued" || state === "running" || state === "cancel-requested"),
    canRegenerate: writable,
    needsRecovery: state === "failed" || state === "cancelled"
  };
}

/** 主状态行：当前尝试与替代关系；旧尝试不参与主状态。 */
export function skillStepStatusText(step: SkillMediaStepView): string {
  const current = skillStepCurrentAttempt(step);
  if (!current) return "步骤状态未确认，已按失败结算";
  const base = `第 ${current.attempt} 次 · ${SKILL_STEP_STATE_LABELS[current.state]}`;
  if (current.supersededByRunId || current.supersededByAttempt) {
    return `${base} · 由第 ${current.supersededByAttempt ?? "?"} 次接续`;
  }
  return base;
}

/**
 * 旧尝试的核对摘要：只列被替代/终态并且不是当前尝试的行，最新尝试永远单独显示。
 */
export function skillStepHistory(step: SkillMediaStepView) {
  return step.attempts
    .filter((attempt) => attempt.attempt !== step.currentAttempt)
    .map((attempt) => ({
      attempt: attempt.attempt,
      state: attempt.state,
      runId: attempt.runId,
      label: SKILL_STEP_STATE_LABELS[attempt.state],
      supersededByRunId: attempt.supersededByRunId
    }));
}

/**
 * 请求身份：同一 `skillRunId + stepId` 的一次重新生成使用独立 requestId。
 *
 * 优先使用 `crypto.randomUUID`，无该 API 的环境退化为时间戳 + 随机串（仅本地生成，服务端
 * 仍按 requestId 幂等校验）。
 */
export function createSkillRegenerateRequestId(now: () => number = Date.now): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return `skill-regen-${cryptoApi.randomUUID()}`;
  return `skill-regen-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
