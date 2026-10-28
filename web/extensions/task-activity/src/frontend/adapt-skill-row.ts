/**
 * Skill 媒体步骤 → `ActivityRow`
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 5.2 / design D5）。
 *
 * 来源是宿主应用服务轮询出的**步骤快照**（`SkillMediaStepView`），不是 Y.Doc 或任务事件：
 * 一个步骤只把 `currentAttempt` 投影成主行状态，全部历史尝试留在行详情里核对。因此迟到
 * 回调不会通过活动面板改写当前结果，面板也不自行推断「已取消」——`cancel-requested` 与
 * `superseded` 按宿主事实原样显示。
 *
 * 「是否进行中」是 Skill 来源语义（当前尝试仍在排队/执行/取消中），不上提到面板层。
 */
import type { SkillMediaStepView } from "@woohaa3/contracts";
import {
  SKILL_STATE_LABELS,
  skillStateActive,
  skillStateTone,
  type ActivityRow,
  type ActivityRowCapabilities
} from "./rows.js";

/** 稳定身份：`skill:<skillRunId>:<stepId>`（同一节点可有多次尝试，身份不随 attempt 变化）。 */
export function skillRowKey(step: Pick<SkillMediaStepView, "skillRunId" | "stepId">): string {
  return `skill:${step.skillRunId}:${step.stepId}`;
}

/** 当前尝试；快照损坏（指针缺失）时返回 `undefined`，由调用方按「待核对」处理。 */
export function currentSkillAttempt(step: SkillMediaStepView) {
  return step.attempts.find((attempt) => attempt.attempt === step.currentAttempt);
}

export function skillStepActive(step: SkillMediaStepView): boolean {
  const current = currentSkillAttempt(step);
  return current ? skillStateActive(current.state) : false;
}

/** 主行文案：节点标题优先，其次按已知媒体类型兜底（不猜测模型名）。 */
export function skillStepTitle(step: SkillMediaStepView, capabilities: ActivityRowCapabilities = {}): string {
  const resolved = capabilities.skill?.resolveTitle?.(step.nodeId)?.trim();
  if (resolved) return resolved;
  const latestSuccessAttempt = step.latestSuccessfulRunId
    ? step.attempts.find((attempt) => attempt.runId === step.latestSuccessfulRunId)
    : undefined;
  const kind = currentSkillAttempt(step)?.mediaKind ?? latestSuccessAttempt?.mediaKind;
  if (kind === "video") return "Agent 视频生成";
  if (kind === "image") return "Agent 图片生成";
  return "Agent 媒体生成";
}

export function adaptSkillRow(step: SkillMediaStepView, capabilities: ActivityRowCapabilities = {}): ActivityRow {
  const current = currentSkillAttempt(step);
  const active = current ? skillStateActive(current.state) : false;
  const state = current?.state ?? "unknown";
  const title = skillStepTitle(step, capabilities);
  const attemptLabel = `第 ${current?.attempt ?? step.currentAttempt} 次 · 提示词 r${current?.promptRevision ?? step.promptRevision}`;
  const secondary = current?.modelKey ? `${attemptLabel} · ${current.modelKey}` : attemptLabel;
  const locate = capabilities.locateNode ? () => capabilities.locateNode!(step.nodeId) : undefined;
  const refresh = capabilities.skill?.refresh ? () => capabilities.skill!.refresh!(step) : undefined;
  return {
    key: skillRowKey(step),
    kind: "skill",
    title,
    secondary,
    ...(current?.error ? { detail: current.error } : {}),
    status: current ? SKILL_STATE_LABELS[current.state] : SKILL_STATE_LABELS.unknown,
    state,
    tone: skillStateTone(state),
    nodeId: step.nodeId,
    createdAt: current?.createdAt ?? step.createdAt,
    updatedAt: step.updatedAt,
    active,
    actions: {
      close: !active,
      ...(locate ? { locate } : {}),
      ...(refresh ? { verify: refresh } : {}),
      // 详情包含旧尝试与提示词核对，点击锁定，避免只读悬停时无法阅读。
      ...(refresh ? { pinOnOpen: true } : {})
    },
    source: { kind: "skill", step }
  };
}
