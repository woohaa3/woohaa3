/**
 * Skill 步骤结算：只由 Canvas/Task 权威回调或权威状态复核调用
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 2.3 / 3.1）。
 *
 * 旧 run 的迟到结果只写自己的历史终态；当前尝试指针与节点输出均不被覆盖。
 */
import { applySkillMediaTransition, type SkillMediaState, type SkillStepUpdatedEvent } from "@woohaa3/contracts";
import { safeSkillError } from "./projection.js";
import type { SkillMediaAttemptRecord, SkillMediaStepKey, SkillMediaStepRecord } from "./records.js";
import type { SqliteSkillMediaStore } from "./store.js";
import type { SkillMediaSettlement } from "./ports.js";

export type SkillSettlerContext = {
  store: SqliteSkillMediaStore;
  transaction: <T>(run: () => T) => T;
  appendEvent: (
    step: SkillMediaStepRecord,
    attempt: SkillMediaAttemptRecord,
    state: SkillMediaState,
    extra?: Partial<SkillStepUpdatedEvent>
  ) => void;
  now: () => string;
};

export function createSkillSettler(context: SkillSettlerContext): (record: SkillMediaSettlement) => void {
  const { store, transaction, appendEvent, now } = context;
  return (record) => {
    const attempt = store.findAttemptByRun(record.canvasId, record.runId);
    if (!attempt) return;
    const key: SkillMediaStepKey = {
      owner: attempt.owner,
      canvasId: attempt.canvasId,
      skillRunId: attempt.skillRunId,
      stepId: attempt.stepId
    };
    const step = store.getStep(key);
    if (!step) return;
    /**
     * 已被更新尝试替代的旧尝试只写自己的历史事实（媒体种类 / 安全错误 / 结算时间）。
     *
     * 即使它当前状态是 `cancel-requested`（Provider 尚未确认取消），迟到成功也不得转成
     * `succeeded`、不更新 `latestSuccessfulRunId`、不发送成功续接事件——否则旧结果会冒充
     * 当前尝试成功，并污染外部 Agent 的最新媒体查询。
     */
    if (attempt.supersededByAttempt !== null || attempt.supersededByRunId !== null) {
      if (record.mediaKind !== undefined || record.error !== undefined) {
        store.updateAttempt({ ...key, attempt: attempt.attempt }, {
          ...(record.mediaKind ? { mediaKind: record.mediaKind } : {}),
          ...(record.error ? { error: safeSkillError(record.error) } : {}),
          settledAt: record.terminalAt ?? now(),
          updatedAt: now()
        });
      }
      return;
    }
    const transition = applySkillMediaTransition(attempt, record.state);
    if (!transition.ok) {
      // 已终态尝试的迟到结果只留下媒体种类与安全错误，不覆盖状态。
      if (attempt.state === "superseded") {
        store.updateAttempt({ ...key, attempt: attempt.attempt }, {
          ...(record.mediaKind ? { mediaKind: record.mediaKind } : {}),
          ...(record.error ? { error: safeSkillError(record.error) } : {}),
          settledAt: record.terminalAt ?? now(),
          updatedAt: now()
        });
      }
      return;
    }
    transaction(() => {
      const at = record.terminalAt ?? now();
      store.updateAttempt({ ...key, attempt: attempt.attempt }, {
        state: record.state,
        ...(record.mediaKind ? { mediaKind: record.mediaKind } : {}),
        ...(record.error ? { error: safeSkillError(record.error) } : {}),
        settledAt: at,
        updatedAt: at
      });
      if (record.state === "succeeded") {
        store.updateStep(key, { latestSuccessfulRunId: record.runId, updatedAt: at });
      }
      const fresh = store.getStep(key)!;
      appendEvent(fresh, store.getAttempt({ ...key, attempt: attempt.attempt })!, record.state,
        record.error ? { error: safeSkillError(record.error) } : {});
    });
  };
}
