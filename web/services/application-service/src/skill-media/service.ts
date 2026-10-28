/**
 * Skill 媒体步骤应用服务
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 2.2–2.4）。
 *
 * 职责：
 * - 按 owner/canvas/root group/scope epoch 授权后读写步骤 ledger；
 * - 相同 requestId 幂等重放，不同规范化输入拒绝；
 * - 替代事务先落盘，再取消旧 run / 启动新 run；
 * - 结算按 Canvas 权威状态复核；旧 run 的迟到结果只写自己的历史；
 * - 步骤事件写入宿主游标并支持分页重放。
 *
 * 不写 Y.Doc、不直接调用 Provider、不保存媒体 bytes。
 */
import {
  applySkillMediaTransition,
  encodeSkillStepUpdatedEvent,
  isSkillMediaTerminal,
  SKILL_STEP_EVENT_TYPE,
  type SkillMediaState,
  type SkillMediaStepView,
  type SkillStepEventPage,
  type SkillStepOutputView,
  type SkillStepUpdatedEvent,
  type SkillStepWaitView
} from "@woohaa3/contracts";
import type {
  SkillMediaAuthorizeInput,
  SkillMediaEventMirror,
  SkillMediaServiceOptions,
  SkillMediaSettlement
} from "./ports.js";
import { currentAttemptOf, safeSkillError, toStepView } from "./projection.js";
import { createSkillQueries } from "./queries.js";
import { boundedPrompt, promptHashOf, requestHashOf } from "./hash.js";
import { createSkillSettler } from "./settlement.js";
import type { SkillMediaAttemptRecord, SkillMediaStepKey, SkillMediaStepRecord } from "./records.js";

const DEFAULT_POLL_MS = 100;

export type SkillMediaScope = {
  owner: string;
  canvasId: string;
  rootGroupId?: string;
  scopeEpoch?: number;
};

export type SkillMediaError = { ok: false; code: string; message: string; step?: SkillMediaStepView };
type Ok<T> = { ok: true } & T;

export type BeginSkillStepInput = SkillMediaScope & {
  skillRunId: string;
  stepId: string;
  nodeId: string;
  requestId: string;
  runId: string;
  jobId?: string;
  prompt?: string;
  promptRevision?: number;
  modelKey?: string;
};

export type ReplaceSkillStepInput = SkillMediaScope & {
  skillRunId: string;
  stepId: string;
  requestId: string;
  runId?: string;
  prompt?: string;
  modelKey?: string;
  parameters?: Record<string, unknown>;
};

export type SkillMediaService = {
  begin(input: BeginSkillStepInput): Promise<Ok<{ step: SkillMediaStepView; duplicate: boolean }> | SkillMediaError>;
  replace(input: ReplaceSkillStepInput): Promise<Ok<{ step: SkillMediaStepView; runId: string }> | SkillMediaError>;
  cancel(input: SkillMediaScope & { skillRunId: string; stepId: string }): Promise<Ok<{ step: SkillMediaStepView; state: "cancel-requested" | "already-terminal" }> | SkillMediaError>;
  wait(input: SkillMediaScope & { skillRunId: string; stepId: string; waitMs: number; followLatest?: boolean; signal?: AbortSignal }): Promise<Ok<{ view: SkillStepWaitView }> | SkillMediaError>;
  latestOutput(input: SkillMediaScope & { skillRunId: string; stepId: string; allowFallback?: boolean }): Promise<Ok<{ view: SkillStepOutputView }> | SkillMediaError>;
  snapshot(input: SkillMediaScope & { skillRunId: string; stepId: string }): Promise<Ok<{ step: SkillMediaStepView }> | SkillMediaError>;
  snapshotByNode(input: SkillMediaScope & { nodeId: string }): Promise<Ok<{ step: SkillMediaStepView | null }> | SkillMediaError>;
  /** 画布内最近的步骤（任务 5.2 活动面板投影；只读、有界）。 */
  list(input: SkillMediaScope & { limit?: number }): Promise<Ok<{ steps: SkillMediaStepView[] }> | SkillMediaError>;
  events(input: SkillMediaScope & { skillRunId: string; stepId: string; after?: number; limit?: number }): Promise<Ok<{ page: SkillStepEventPage }> | SkillMediaError>;
  /**
   * Canvas run 受理前的 attempt 复核（任务 3.1）。
   *
   * 只允许与步骤当前 attempt、当前 runId 完全一致的请求启动；旧请求/旧回调不得重新打开
   * 已被替代的节点。未关联 Skill 的普通 run 不经过这里。
   */
  assertCurrent(input: SkillMediaScope & { nodeId: string; runId: string; skill: { skillRunId: string; stepId: string; attempt: number; promptRevision: number } }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  settleFromRun(record: SkillMediaSettlement): void;
};

export function createSkillMediaService(options: SkillMediaServiceOptions): SkillMediaService {
  const { store, canvas } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const mirror: SkillMediaEventMirror = options.mirrorEvent ?? (() => undefined);
  let pendingMirror: Parameters<SkillMediaEventMirror>[0][] = [];

  /** 事务内只写 skill 事件；会话镜像在提交后调用，避免跨 SQLite 连接持锁写入。 */
  function transaction<T>(run: () => T): T {
    const result = store.atomic(run);
    const pending = pendingMirror;
    pendingMirror = [];
    for (const entry of pending) mirror(entry);
    return result;
  }

  const keyOf = (input: SkillMediaScope & { skillRunId: string; stepId: string }): SkillMediaStepKey => ({
    owner: input.owner,
    canvasId: input.canvasId,
    skillRunId: input.skillRunId,
    stepId: input.stepId
  });

  async function authorize(
    input: SkillMediaScope & { permission: "read" | "write"; nodeId?: string }
  ): Promise<SkillMediaError | null> {
    if (!options.authorize) return null;
    const request: SkillMediaAuthorizeInput = {
      owner: input.owner,
      canvasId: input.canvasId,
      permission: input.permission,
      ...(input.rootGroupId !== undefined ? { rootGroupId: input.rootGroupId } : {}),
      ...(input.scopeEpoch !== undefined ? { scopeEpoch: input.scopeEpoch } : {}),
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {})
    };
    const result = await options.authorize(request);
    return result.ok ? null : { ok: false, code: result.code, message: result.message };
  }

  function loadStep(input: SkillMediaScope & { skillRunId: string; stepId: string }):
    { step: SkillMediaStepRecord; attempts: SkillMediaAttemptRecord[] } | null {
    const step = store.getStep(keyOf(input));
    if (!step) return null;
    if (input.rootGroupId !== undefined && step.rootGroupId !== null && step.rootGroupId !== input.rootGroupId) return null;
    return { step, attempts: store.listAttempts(keyOf(input)) };
  }

  function stepView(step: SkillMediaStepRecord, attempts = store.listAttempts(step)): SkillMediaStepView {
    return toStepView(step, attempts);
  }

  function appendEvent(step: SkillMediaStepRecord, attempt: SkillMediaAttemptRecord, state: SkillMediaState, extra: Partial<SkillStepUpdatedEvent> = {}): void {
    const event: SkillStepUpdatedEvent = {
      type: SKILL_STEP_EVENT_TYPE,
      canvasId: step.canvasId,
      nodeId: step.nodeId,
      skillRunId: step.skillRunId,
      stepId: step.stepId,
      attempt: attempt.attempt,
      promptRevision: attempt.promptRevision,
      state,
      current: attempt.attempt === step.currentAttempt,
      superseded: attempt.supersededByAttempt !== null || attempt.supersededByRunId !== null,
      ...(attempt.runId !== "" ? { runId: attempt.runId } : {}),
      ...(attempt.jobId !== null ? { jobId: attempt.jobId } : {}),
      ...(step.latestSuccessfulRunId !== null ? { latestSuccessfulRunId: step.latestSuccessfulRunId } : {}),
      ...(attempt.error !== null ? { error: safeSkillError(attempt.error) } : {}),
      at: now(),
      ...extra
    };
    const encoded = encodeSkillStepUpdatedEvent(event);
    if (!encoded.ok) return;
    store.appendEvent({
      owner: step.owner,
      canvasId: step.canvasId,
      skillRunId: step.skillRunId,
      stepId: step.stepId,
      attempt: attempt.attempt,
      type: SKILL_STEP_EVENT_TYPE,
      payloadJson: JSON.stringify(encoded.payload),
      createdAt: event.at
    });
    pendingMirror.push({ owner: step.owner, canvasId: step.canvasId, nodeId: step.nodeId, event, createdAt: event.at });
  }

  function failStep(code: string, message: string, step?: SkillMediaStepRecord, attempts?: SkillMediaAttemptRecord[]): SkillMediaError {
    return { ok: false, code, message, ...(step ? { step: stepView(step, attempts) } : {}) };
  }

  const settleFromRun = createSkillSettler({ store, transaction, appendEvent, now });

  async function begin(input: BeginSkillStepInput): Promise<Ok<{ step: SkillMediaStepView; duplicate: boolean }> | SkillMediaError> {
    const denied = await authorize({ ...input, permission: "write", nodeId: input.nodeId });
    if (denied) return denied;
    const prompt = boundedPrompt(input.prompt);
    const requestHash = requestHashOf({ ...input, prompt });
    const existing = store.getAttemptByRequest(input.owner, input.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) return { ok: false, code: "request-id-reused", message: "相同 requestId 携带了不同输入" };
      const step = store.getStep({ owner: existing.owner, canvasId: existing.canvasId, skillRunId: existing.skillRunId, stepId: existing.stepId });
      return step ? { ok: true, duplicate: true, step: stepView(step) } : failStep("skill-step-not-found", "步骤不存在");
    }
    const at = now();
    try {
      const created = transaction(() => {
        const key = keyOf(input);
        const previous = store.getStep(key);
        const attemptsBefore = previous ? store.listAttempts(key) : [];
        const previousAttempt = previous ? currentAttemptOf(previous, attemptsBefore) : undefined;
        const attemptNo = previous ? previous.currentAttempt + 1 : 1;
        const promptHash = promptHashOf(prompt);
        const promptRevision = previous
          ? Math.max(previous.promptRevision, input.promptRevision ?? 0) + (previousAttempt && previousAttempt.promptHash !== promptHash ? 1 : 0)
          : Math.max(1, input.promptRevision ?? 1);
        if (previous) {
          store.updateStep(key, {
            nodeId: input.nodeId,
            rootGroupId: input.rootGroupId ?? previous.rootGroupId,
            scopeEpoch: input.scopeEpoch ?? previous.scopeEpoch,
            currentAttempt: attemptNo,
            currentRequestId: input.requestId,
            currentRunId: input.runId,
            promptRevision,
            updatedAt: at
          });
        } else {
          store.insertStep({
            owner: input.owner,
            canvasId: input.canvasId,
            rootGroupId: input.rootGroupId ?? null,
            scopeEpoch: input.scopeEpoch ?? null,
            skillRunId: input.skillRunId,
            stepId: input.stepId,
            nodeId: input.nodeId,
            currentAttempt: attemptNo,
            currentRequestId: input.requestId,
            currentRunId: input.runId,
            promptRevision,
            latestSuccessfulRunId: null,
            createdAt: at,
            updatedAt: at
          });
        }
        const attempt: SkillMediaAttemptRecord = {
          owner: input.owner,
          canvasId: input.canvasId,
          skillRunId: input.skillRunId,
          stepId: input.stepId,
          attempt: attemptNo,
          requestId: input.requestId,
          requestHash,
          runId: input.runId,
          jobId: input.jobId ?? null,
          promptRevision,
          promptHash,
          prompt,
          modelKey: input.modelKey ?? null,
          state: "queued",
          mediaKind: null,
          error: null,
          supersededByAttempt: null,
          supersededByRunId: null,
          createdAt: at,
          updatedAt: at,
          settledAt: null
        };
        store.insertAttempt(attempt);
        const step = store.getStep(key)!;
        appendEvent(step, attempt, "queued");
        return { step, attempt };
      });
      return { ok: true, duplicate: false, step: stepView(created.step) };
    } catch (error) {
      return { ok: false, code: "request-id-reused", message: error instanceof Error ? error.message : "步骤写入失败" };
    }
  }

  async function replace(input: ReplaceSkillStepInput): Promise<Ok<{ step: SkillMediaStepView; runId: string }> | SkillMediaError> {
    const denied = await authorize({ ...input, permission: "write" });
    if (denied) return denied;
    const current = loadStep(input);
    if (!current) return failStep("skill-step-not-found", "步骤不存在");
    const prompt = boundedPrompt(input.prompt);
    const requestHash = requestHashOf({ ...input, nodeId: current.step.nodeId, prompt });
    const existing = store.getAttemptByRequest(input.owner, input.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.skillRunId !== input.skillRunId || existing.stepId !== input.stepId) {
        return failStep("request-id-reused", "相同 requestId 携带了不同输入", current.step, current.attempts);
      }
      return { ok: true, step: stepView(current.step), runId: existing.runId };
    }
    const runId = input.runId ?? options.deriveRunId?.({ canvasId: input.canvasId, nodeId: current.step.nodeId, requestId: input.requestId });
    if (!runId) return failStep("malformed-request", "缺少 run 身份且宿主未提供派生器", current.step, current.attempts);
    const collision = store.findAttemptByRun(input.canvasId, runId);
    if (collision && (collision.skillRunId !== input.skillRunId || collision.stepId !== input.stepId)) {
      return failStep("request-id-reused", "运行身份已关联到其它步骤", current.step, current.attempts);
    }
    const at = now();
    const previousAttempt = currentAttemptOf(current.step, current.attempts);
    if (!previousAttempt) return failStep("skill-step-not-found", "步骤没有可替代的尝试", current.step, current.attempts);
    const promptHash = promptHashOf(prompt);
    const promptRevision = current.step.promptRevision + (previousAttempt.promptHash === promptHash ? 0 : 1);
    const attemptNo = current.step.currentAttempt + 1;
    const replacement = transaction(() => {
      const key = keyOf(input);
      const oldState: SkillMediaState = previousAttempt.state === "running" || previousAttempt.state === "cancel-requested" || previousAttempt.state === "queued"
        ? "cancel-requested"
        : isSkillMediaTerminal(previousAttempt.state) ? previousAttempt.state : "superseded";
      store.updateAttempt(
        { ...key, attempt: previousAttempt.attempt },
        { state: oldState, supersededByAttempt: attemptNo, supersededByRunId: runId, updatedAt: at }
      );
      const attempt: SkillMediaAttemptRecord = {
        owner: input.owner,
        canvasId: input.canvasId,
        skillRunId: input.skillRunId,
        stepId: input.stepId,
        attempt: attemptNo,
        requestId: input.requestId,
        requestHash,
        runId,
        jobId: null,
        promptRevision,
        promptHash,
        prompt,
        modelKey: input.modelKey ?? previousAttempt.modelKey,
        state: "queued",
        mediaKind: null,
        error: null,
        supersededByAttempt: null,
        supersededByRunId: null,
        createdAt: at,
        updatedAt: at,
        settledAt: null
      };
      store.insertAttempt(attempt);
      store.updateStep(key, {
        currentAttempt: attemptNo,
        currentRequestId: input.requestId,
        currentRunId: runId,
        promptRevision,
        updatedAt: at
      });
      const step = store.getStep(key)!;
      const oldUpdated = store.getAttempt({ ...key, attempt: previousAttempt.attempt })!;
      appendEvent(step, oldUpdated, oldUpdated.state, { superseded: true, supersededByAttempt: attemptNo, supersededByRunId: runId });
      appendEvent(step, attempt, "queued");
      return { step, attempt };
    });

    // 替代关系已落盘。取消旧 run 只是请求；失败不回滚新 attempt。
    try {
      const cancelled = await canvas.cancel({
        owner: input.owner,
        canvasId: input.canvasId,
        nodeId: replacement.step.nodeId,
        runId: previousAttempt.runId
      });
      if (cancelled.ok && cancelled.state === "already-terminal") void reconcileStep(keyOf(input));
    } catch { /* keep cancel-requested / superseded fact */ }

    const started = await canvas.run({
      owner: input.owner,
      canvasId: input.canvasId,
      nodeId: replacement.step.nodeId,
      requestId: input.requestId,
      runId,
      skill: { skillRunId: input.skillRunId, stepId: input.stepId, attempt: attemptNo, promptRevision },
      ...(prompt !== "" ? { prompt } : {}),
      ...(input.modelKey !== undefined ? { modelKey: input.modelKey } : {}),
      ...(input.parameters !== undefined ? { parameters: input.parameters } : {})
    });
    if (!started.ok) {
      settleFromRun({
        canvasId: input.canvasId,
        nodeId: replacement.step.nodeId,
        runId,
        state: "failed",
        error: started.message,
        terminalAt: now()
      });
      return failStep(started.code, started.message);
    }
    transaction(() => {
      store.updateAttempt(
        { owner: input.owner, canvasId: input.canvasId, skillRunId: input.skillRunId, stepId: input.stepId, attempt: attemptNo },
        { jobId: started.jobId, updatedAt: now() }
      );
    });
    const step = store.getStep(keyOf(input))!;
    return { ok: true, step: stepView(step), runId: started.runId };
  }

  async function cancel(input: SkillMediaScope & { skillRunId: string; stepId: string }):
    Promise<Ok<{ step: SkillMediaStepView; state: "cancel-requested" | "already-terminal" }> | SkillMediaError> {
    const denied = await authorize({ ...input, permission: "write" });
    if (denied) return denied;
    await reconcileStep(keyOf(input));
    const current = loadStep(input);
    if (!current) return failStep("skill-step-not-found", "步骤不存在");
    const attempt = currentAttemptOf(current.step, current.attempts);
    if (!attempt) return failStep("skill-step-not-found", "步骤没有当前尝试", current.step, current.attempts);
    if (isSkillMediaTerminal(attempt.state)) return { ok: true, step: stepView(current.step), state: "already-terminal" };
    const result = await canvas.cancel({
      owner: input.owner,
      canvasId: input.canvasId,
      nodeId: current.step.nodeId,
      runId: attempt.runId
    });
    if (!result.ok) return failStep(result.code, result.message, current.step, current.attempts);
    const at = now();
    if (result.state === "cancel-requested") {
      transaction(() => {
        store.updateAttempt(
          { owner: input.owner, canvasId: input.canvasId, skillRunId: input.skillRunId, stepId: input.stepId, attempt: attempt.attempt },
          { state: "cancel-requested", updatedAt: at }
        );
        const step = store.getStep(keyOf(input))!;
        appendEvent(step, store.getAttempt({ ...keyOf(input), attempt: attempt.attempt })!, "cancel-requested");
      });
      return { ok: true, step: stepView(store.getStep(keyOf(input))!), state: "cancel-requested" };
    }
    await reconcileStep(keyOf(input));
    return { ok: true, step: stepView(store.getStep(keyOf(input))!), state: "already-terminal" };
  }

  async function reconcileStep(key: SkillMediaStepKey): Promise<SkillMediaStepRecord | null> {
    const step = store.getStep(key);
    if (!step) return null;
    const attempts = store.listAttempts(key);
    const attempt = currentAttemptOf(step, attempts);
    if (!attempt || isSkillMediaTerminal(attempt.state)) return step;
    const status = await canvas.status({
      owner: key.owner,
      canvasId: key.canvasId,
      nodeId: step.nodeId,
      runId: attempt.runId,
      skill: { skillRunId: step.skillRunId, stepId: step.stepId, attempt: attempt.attempt, promptRevision: attempt.promptRevision }
    });
    if (!status.ok) return store.getStep(key);
    const view = status.view;
    if (view.phase === "terminal") {
      if (!view.state || String(view.state) === "unknown") {
        await markUnconfirmed(key, attempt, step.nodeId);
      } else {
        settleFromRun({
          canvasId: key.canvasId,
          nodeId: step.nodeId,
          runId: attempt.runId,
          jobId: view.jobId,
          state: view.state,
          ...(view.error ? { error: view.error } : {}),
          ...(attempt.mediaKind ? { mediaKind: attempt.mediaKind as SkillMediaSettlement["mediaKind"] } : {})
        });
      }
    } else if (view.stale && !isSkillMediaTerminal(attempt.state)) {
      await markUnconfirmed(key, attempt, step.nodeId);
    }
    return store.getStep(key);
  }

  /**
   * D2：核对窗口结束/终态缺状态时，先撤销仍匹配的 Provider 运行，再按 failed 结算。
   * 撤销失败不阻塞结算；迟到结果由 settler 只写入该尝试的历史，不覆盖当前输出。
   */
  async function markUnconfirmed(key: SkillMediaStepKey, attempt: SkillMediaAttemptRecord, nodeId: string): Promise<void> {
    const error = "结果无法确认（result-unconfirmed），已撤销匹配的 Provider 运行";
    await canvas.cancel({
      owner: key.owner,
      canvasId: key.canvasId,
      nodeId,
      runId: attempt.runId
    }).catch(() => undefined);
    const transition = applySkillMediaTransition(attempt, "failed");
    if (!transition.ok || !transition.changed) return;
    const at = now();
    transaction(() => {
      store.updateAttempt(
        { ...key, attempt: attempt.attempt },
        { state: "failed", error, updatedAt: at, settledAt: at }
      );
      appendEvent(store.getStep(key)!, store.getAttempt({ ...key, attempt: attempt.attempt })!, "failed", { error });
    });
  }

  async function snapshot(input: SkillMediaScope & { skillRunId: string; stepId: string }): Promise<Ok<{ step: SkillMediaStepView }> | SkillMediaError> {
    const denied = await authorize({ ...input, permission: "read" });
    if (denied) return denied;
    await reconcileStep(keyOf(input));
    const current = loadStep(input);
    if (!current) return failStep("skill-step-not-found", "步骤不存在");
    return { ok: true, step: stepView(current.step, current.attempts) };
  }

  async function snapshotByNode(input: SkillMediaScope & { nodeId: string }): Promise<Ok<{ step: SkillMediaStepView | null }> | SkillMediaError> {
    const denied = await authorize({ ...input, permission: "read", nodeId: input.nodeId });
    if (denied) return denied;
    const found = store.findStepByNode({ owner: input.owner, canvasId: input.canvasId, nodeId: input.nodeId });
    if (!found) return { ok: true, step: null };
    if (input.rootGroupId !== undefined && found.rootGroupId !== null && found.rootGroupId !== input.rootGroupId) {
      return failStep("forbidden", "步骤不属于当前组");
    }
    const step = await reconcileStep({ owner: found.owner, canvasId: found.canvasId, skillRunId: found.skillRunId, stepId: found.stepId });
    return { ok: true, step: step ? stepView(step) : null };
  }

  async function list(input: SkillMediaScope & { limit?: number }): Promise<Ok<{ steps: SkillMediaStepView[] }> | SkillMediaError> {
    const denied = await authorize({ ...input, permission: "read" });
    if (denied) return denied;
    const records = store.listStepsByCanvas({ owner: input.owner, canvasId: input.canvasId, ...(input.limit !== undefined ? { limit: input.limit } : {}) });
    const visible = records.filter((record) =>
      input.rootGroupId === undefined || record.rootGroupId === null || record.rootGroupId === input.rootGroupId
    );
    return { ok: true, steps: visible.map((record) => stepView(record)) };
  }


  async function assertCurrent(input: SkillMediaScope & {
    nodeId: string;
    runId: string;
    skill: { skillRunId: string; stepId: string; attempt: number; promptRevision: number };
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const denied = await authorize({ ...input, permission: "write", nodeId: input.nodeId });
    if (denied) return { ok: false, code: denied.code, message: denied.message };
    const stepKey: SkillMediaStepKey = {
      owner: input.owner,
      canvasId: input.canvasId,
      skillRunId: input.skill.skillRunId,
      stepId: input.skill.stepId
    };
    const step = store.getStep(stepKey);
    if (!step) return { ok: false, code: "skill-step-not-found", message: "步骤不存在" };
    if (step.nodeId !== input.nodeId) return { ok: false, code: "skill-step-not-found", message: "步骤不属于该节点" };
    if (step.currentAttempt !== input.skill.attempt || step.promptRevision !== input.skill.promptRevision) {
      return { ok: false, code: "skill-attempt-superseded", message: "该尝试已被更新尝试替代" };
    }
    if (step.currentRunId !== null && step.currentRunId !== input.runId) {
      return { ok: false, code: "skill-attempt-superseded", message: "步骤当前 run 已变化" };
    }
    const attempt = store.getAttempt({ ...stepKey, attempt: input.skill.attempt });
    if (!attempt || attempt.runId !== input.runId) {
      return { ok: false, code: "skill-attempt-superseded", message: "尝试与运行身份不一致" };
    }
    if (attempt.state !== "queued" && attempt.state !== "running" && attempt.state !== "cancel-requested") {
      return { ok: false, code: "skill-attempt-superseded", message: "尝试已结束，不能重新启动" };
    }
    return { ok: true };
  }

  const queries = createSkillQueries({
    store,
    canvas,
    authorize,
    keyOf,
    loadStep,
    stepView,
    failStep,
    reconcileStep,
    pollMs,
    sleep
  });

  return {
    begin,
    replace,
    cancel,
    wait: queries.wait,
    latestOutput: queries.latestOutput,
    snapshot,
    snapshotByNode,
    list,
    events: queries.events,
    assertCurrent,
    settleFromRun
  };
}
