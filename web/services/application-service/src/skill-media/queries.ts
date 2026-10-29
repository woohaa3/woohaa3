/**
 * Skill 步骤查询面：最新输出、有界等待与事件重放
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 2.4 / 4.2 / 4.3）。
 *
 * 从 `service.ts` 拆出（业务源码规模门禁）：只读/等待路径不产生生成副作用。
 */
import {
  decodeSkillStepUpdatedEvent,
  SKILL_STEP_EVENT_TYPE,
  type SkillMediaStepView,
  type SkillStepEventPage,
  type SkillStepOutputReason,
  type SkillStepOutputView,
  type SkillStepUpdatedEvent,
  type SkillStepWaitView
} from "@woohaa3/contracts";
import type { SkillMediaCanvasPort } from "./ports.js";
import { currentAttemptOf } from "./projection.js";import type { SkillMediaAttemptRecord, SkillMediaStepKey, SkillMediaStepRecord } from "./records.js";
import type { SqliteSkillMediaStore } from "./store.js";
import type { SkillMediaError, SkillMediaScope } from "./service.js";

const MAX_WAIT_MS = 30_000;

export type SkillQueryContext = {
  store: SqliteSkillMediaStore;
  canvas: SkillMediaCanvasPort;
  authorize: (input: SkillMediaScope & { permission: "read" | "write"; nodeId?: string }) => Promise<SkillMediaError | null>;
  keyOf: (input: SkillMediaScope & { skillRunId: string; stepId: string }) => SkillMediaStepKey;
  loadStep: (input: SkillMediaScope & { skillRunId: string; stepId: string }) => {
    step: SkillMediaStepRecord;
    attempts: SkillMediaAttemptRecord[];
  } | null;
  stepView: (step: SkillMediaStepRecord, attempts?: SkillMediaAttemptRecord[]) => SkillMediaStepView;
  failStep: (code: string, message: string, step?: SkillMediaStepRecord, attempts?: SkillMediaAttemptRecord[]) => SkillMediaError;
  reconcileStep: (key: SkillMediaStepKey) => Promise<SkillMediaStepRecord | null>;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
};

type Ok<T> = { ok: true } & T;

export function createSkillQueries(context: SkillQueryContext) {
  const { store, canvas, authorize, keyOf, loadStep, stepView, failStep, reconcileStep, pollMs, sleep } = context;

  async function outputView(
    step: SkillMediaStepRecord,
    attempts: SkillMediaAttemptRecord[],
    attempt: SkillMediaAttemptRecord | undefined,
    allowFallback: boolean
  ): Promise<SkillStepOutputView> {
    if (!attempt) {
      return {
        available: false,
        skillRunId: step.skillRunId,
        stepId: step.stepId,
        attempt: step.currentAttempt,
        promptRevision: step.promptRevision,
        reason: "no-output",
        message: "步骤没有尝试",
        fallbackAvailable: false
      };
    }
    const base = {
      skillRunId: step.skillRunId,
      stepId: step.stepId,
      attempt: attempt.attempt,
      promptRevision: attempt.promptRevision,
      runId: attempt.runId
    };
    if (attempt.state === "succeeded") {
      const output = await canvas.output({ owner: step.owner, canvasId: step.canvasId, nodeId: step.nodeId, runId: attempt.runId });
      if (output.ok && output.view.available) return { available: true, current: true, ...base, output: output.view.output };
      return { available: false, ...base, reason: "output-unavailable", message: "媒体尚无稳定引用", fallbackAvailable: false };
    }
    if (attempt.state === "running" || attempt.state === "queued" || attempt.state === "cancel-requested") {
      return { available: false, ...base, reason: "running", message: "当前尝试尚未结束", fallbackAvailable: false };
    }
    const reason: SkillStepOutputReason = attempt.state === "cancelled" ? "cancelled"
      : attempt.state === "superseded" ? "superseded" : "failed";
    const fallbackAttempt = step.latestSuccessfulRunId
      ? attempts.find((entry) => entry.runId === step.latestSuccessfulRunId && entry.state === "succeeded" && entry.runId !== attempt.runId)
      : undefined;
    if (allowFallback && fallbackAttempt) {
      const output = await canvas.output({ owner: step.owner, canvasId: step.canvasId, nodeId: step.nodeId, runId: fallbackAttempt.runId });
      if (output.ok && output.view.available) {
        return {
          available: true,
          current: false,
          fallback: {
            attempt: fallbackAttempt.attempt,
            promptRevision: fallbackAttempt.promptRevision,
            runId: fallbackAttempt.runId,
            output: output.view.output
          },
          ...base,
          reason,
          message: "当前尝试未成功，返回显式请求的旧成功版本"
        };
      }
    }
    return {
      available: false,
      ...base,
      reason,
      message: attempt.error ?? (reason === "cancelled" ? "当前尝试已取消" : reason === "superseded" ? "当前尝试已被替代" : "当前尝试失败"),
      fallbackAvailable: fallbackAttempt !== undefined
    };
  }

  async function latestOutput(input: SkillMediaScope & { skillRunId: string; stepId: string; allowFallback?: boolean }):
    Promise<Ok<{ view: SkillStepOutputView }> | SkillMediaError> {
    const denied = await authorize({ ...input, permission: "read" });
    if (denied) return denied;
    await reconcileStep(keyOf(input));
    const current = loadStep(input);
    if (!current) return failStep("skill-step-not-found", "步骤不存在");
    const attempt = currentAttemptOf(current.step, current.attempts);
    const view = await outputView(current.step, current.attempts, attempt, input.allowFallback === true);
    return { ok: true, view };
  }

  async function wait(input: SkillMediaScope & { skillRunId: string; stepId: string; waitMs: number; followLatest?: boolean; signal?: AbortSignal }):
    Promise<Ok<{ view: SkillStepWaitView }> | SkillMediaError> {
    const denied = await authorize({ ...input, permission: "read" });
    if (denied) return denied;
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Math.trunc(input.waitMs)));
    const deadline = Date.now() + waitMs;
    const replacedRunIds: string[] = [];
    let followed = false;
    let trackedAttempt = 0;
    for (;;) {
      const step = await reconcileStep(keyOf(input));
      if (!step) return failStep("skill-step-not-found", "步骤不存在");
      const attempts = store.listAttempts(keyOf(input));
      const attempt = currentAttemptOf(step, attempts);
      if (!attempt) return failStep("skill-step-not-found", "步骤没有当前尝试", step, attempts);
      if (trackedAttempt !== 0 && attempt.attempt > trackedAttempt && (input.followLatest ?? true)) {
        followed = true;
        const previous = attempts.find((entry) => entry.attempt === trackedAttempt);
        if (previous && !replacedRunIds.includes(previous.runId)) replacedRunIds.push(previous.runId);
      }
      trackedAttempt = attempt.attempt;
      const base = {
        skillRunId: step.skillRunId,
        stepId: step.stepId,
        attempt: attempt.attempt,
        promptRevision: attempt.promptRevision,
        runId: attempt.runId,
        step: stepView(step, attempts),
        followed,
        replacedRunIds
      };
      if (attempt.state === "succeeded") {
        return { ok: true, view: { ...base, phase: "succeeded", outputView: await outputView(step, attempts, attempt, false) } };
      }
      if (attempt.state === "failed") return { ok: true, view: { ...base, phase: "failed" } };
      if (attempt.state === "cancelled") return { ok: true, view: { ...base, phase: "cancelled" } };
      if (attempt.state === "superseded") return { ok: true, view: { ...base, phase: "superseded" } };
      if (input.signal?.aborted) return { ok: true, view: { ...base, phase: "running", cancelled: true } };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: true, view: { ...base, phase: "timeout" } };
      await sleep(Math.min(pollMs, remaining));
    }
  }

  async function events(input: SkillMediaScope & { skillRunId: string; stepId: string; after?: number; limit?: number }):
    Promise<Ok<{ page: SkillStepEventPage }> | SkillMediaError> {
    const denied = await authorize({ ...input, permission: "read" });
    if (denied) return denied;
    const key = keyOf(input);
    const current = loadStep(input);
    if (!current) return failStep("skill-step-not-found", "步骤不存在");
    const after = Math.max(0, Math.trunc(input.after ?? 0));
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 100)));
    const max = store.maxEventSequence(key);
    const min = store.minEventSequence(key);
    if (after > max || (min !== null && after > 0 && after < min - 1)) {
      return { ok: true, page: { events: [], cursor: max, resetRequired: true } };
    }
    const rows = store.listEvents(key, after, limit);
    const events: Array<SkillStepUpdatedEvent & { sequence: number }> = [];
    for (const row of rows) {
      const decoded = decodeSkillStepUpdatedEvent(safeParse(row.payloadJson));
      if (!decoded.ok) return { ok: true, page: { events: [], cursor: max, resetRequired: true } };
      events.push({ ...decoded.value, sequence: row.sequence });
    }
    return { ok: true, page: { events, cursor: events.at(-1)?.sequence ?? after, resetRequired: false } };
  }

  return { outputView, latestOutput, wait, events };
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

export { SKILL_STEP_EVENT_TYPE };
