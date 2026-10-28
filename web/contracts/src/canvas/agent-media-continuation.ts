/**
 * Agent Skill 媒体步骤续接契约
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 1.1–1.3 / design D1–D5）。
 *
 * 本模块是宿主（Application Service）与外部 Agent（MCP）、前端活动面板之间的**纯类型 + 无副作用
 * 规则**：步骤/尝试身份、合法状态转换、`skill-step-updated` 事件 codec 与最新媒体投影。
 *
 * 边界：
 * - 步骤 ledger 属于 Agent 会话侧，不写 Y.Doc，也不代替 Canvas/Task 的任务权威；
 * - 输出只允许稳定同源相对引用与安全 metadata，**不含** storage key、签名 URL、data/blob URL
 *   或原始 bytes；
 * - 事件只用于反馈与重放，事实查询必须读取步骤快照/最新输出。
 */
import { isBoundedId, isFiniteNumber, isJsonObject } from "../validation.js";
import type { AgentNodeOutput } from "./agent-canvas-run.js";

/** Skill 媒体尝试状态。`superseded` 表示宿主已不再接受它成为当前结果。 */
export const SKILL_MEDIA_STATES = [
  "queued",
  "running",
  "cancel-requested",
  "cancelled",
  "superseded",
  "succeeded",
  "failed",
  "unknown"
] as const;
export type SkillMediaState = (typeof SKILL_MEDIA_STATES)[number];

export function isSkillMediaState(value: unknown): value is SkillMediaState {
  return typeof value === "string" && (SKILL_MEDIA_STATES as readonly string[]).includes(value);
}

/** 终态：不再接受 Provider 状态推进（迟到回调只作为该尝试的历史事实核对）。 */
export const SKILL_MEDIA_TERMINAL_STATES: readonly SkillMediaState[] = ["succeeded", "failed", "cancelled", "superseded"];
export function isSkillMediaTerminal(state: SkillMediaState): boolean {
  return SKILL_MEDIA_TERMINAL_STATES.includes(state);
}

/**
 * 合法转换表。
 *
 * - `cancel-requested` 不是终态：Provider 尚未确认时不得报告为 `cancelled`；
 * - 已终态不允许回到运行态（防止迟到回调用旧事实覆盖新结果）；
 * - `failed/cancelled` 不自动转成 `succeeded`；要恢复必须创建新 attempt。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<SkillMediaState, readonly SkillMediaState[]>> = {
  queued: ["running", "cancel-requested", "cancelled", "succeeded", "failed", "superseded", "unknown"],
  running: ["cancel-requested", "cancelled", "succeeded", "failed", "superseded", "unknown"],
  "cancel-requested": ["cancelled", "succeeded", "failed", "superseded", "unknown"],
  unknown: ["queued", "running", "cancel-requested", "cancelled", "succeeded", "failed", "superseded"],
  cancelled: [],
  superseded: [],
  succeeded: [],
  failed: []
};

export function canTransitionSkillMediaState(from: SkillMediaState, to: SkillMediaState): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

/** 纯转换：非法回退返回 `ok:false`，不修改输入。 */
export function applySkillMediaTransition(
  attempt: { state: SkillMediaState },
  next: SkillMediaState
): { ok: true; state: SkillMediaState; changed: boolean } | { ok: false; code: "illegal-transition"; message: string } {
  if (!canTransitionSkillMediaState(attempt.state, next)) {
    return { ok: false, code: "illegal-transition", message: `不允许从 ${attempt.state} 转换到 ${next}` };
  }
  return { ok: true, state: next, changed: attempt.state !== next };
}

/** 一次运行与 Skill 步骤的稳定关联（可放进 run 视图，不替代 run 身份）。 */
export type SkillMediaRunRef = {
  skillRunId: string;
  stepId: string;
  attempt: number;
  promptRevision: number;
};

/** 单个尝试的持久事实（owner 授权后的读模型）。 */
export type SkillMediaAttemptView = SkillMediaRunRef & {
  runId: string;
  requestId: string;
  state: SkillMediaState;
  /** 是否为步骤当前尝试。 */
  current: boolean;
  /** 是否已被同一步骤的更新尝试替代（即使 Provider 仍返回结果）。 */
  superseded: boolean;
  supersededByAttempt?: number;
  supersededByRunId?: string;
  modelKey?: string;
  jobId?: string;
  mediaKind?: "text" | "image" | "video" | "audio";
  /** 安全错误摘要；不含堆栈、本机路径、provider 凭据或签名地址。 */
  error?: string;
  /** 该尝试确认的提示词（历史核对用；事件与 MCP 输出不携带）。 */
  prompt?: string;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
};

/** 步骤快照：一个步骤多个尝试，只有一个 `currentAttempt` 指针。 */
export type SkillMediaStepView = {
  canvasId: string;
  nodeId: string;
  rootGroupId?: string;
  scopeEpoch?: number;
  skillRunId: string;
  stepId: string;
  currentAttempt: number;
  currentRunId?: string;
  promptRevision: number;
  latestSuccessfulRunId?: string;
  /** 最新成功尝试（可被显式回退使用；不代表当前尝试成功）。 */
  latestSuccess?: { attempt: number; promptRevision: number; runId: string };
  attempts: readonly SkillMediaAttemptView[];
  createdAt: string;
  updatedAt: string;
};

/** 事件 codec 的类型标识（与 Agent 会话事件游标共用 `type` 字段）。 */
export const SKILL_STEP_EVENT_TYPE = "skill-step-updated" as const;

/**
 * 步骤状态变化事件。
 *
 * payload 只含身份、状态与安全摘要；**禁止**完整 prompt、storage key、签名地址与媒体 bytes。
 */
export type SkillStepUpdatedEvent = {
  type: typeof SKILL_STEP_EVENT_TYPE;
  canvasId: string;
  nodeId: string;
  skillRunId: string;
  stepId: string;
  attempt: number;
  promptRevision: number;
  state: SkillMediaState;
  current: boolean;
  superseded: boolean;
  runId?: string;
  jobId?: string;
  progress?: number;
  supersededByAttempt?: number;
  supersededByRunId?: string;
  latestSuccessfulRunId?: string;
  error?: string;
  at: string;
};

const EVENT_KEYS = [
  "type",
  "canvasId",
  "nodeId",
  "skillRunId",
  "stepId",
  "attempt",
  "promptRevision",
  "state",
  "current",
  "superseded",
  "runId",
  "jobId",
  "progress",
  "supersededByAttempt",
  "supersededByRunId",
  "latestSuccessfulRunId",
  "error",
  "at"
] as const;

/**
 * 敏感形态：内部 storage key、绝对签名 URL、data/blob URL、COS 凭据字段。
 *
 * 同源相对地址（以单个 `/` 开头，例如 `/api/media/<opaque>`）是允许的输出引用；这里只拒绝
 * 绝对 URL 与内部 locator。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sha256-[0-9a-f]{64}/i,
  /generation-outputs\/[0-9a-f]{64}/i,
  /(?:^|[^a-z])https?:\/\//i,
  /(?:^|[^a-z])data:/i,
  /(?:^|[^a-z])blob:/i,
  /(?:x-cos|cos-secret|cos-key|authorization|access[_-]?token|secret[_-]?key|signature=)/i
];

/** 文本是否可安全进入 Agent 事件 / 外部工具输出。 */
export function isSafeSkillMediaText(value: string): boolean {
  return !SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function readOptionalBoundedId(raw: Record<string, unknown>, key: string): string | undefined | null {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isBoundedId(value) || !isSafeSkillMediaText(value)) return null;
  return value;
}

function readOptionalSafeText(raw: Record<string, unknown>, key: string): string | undefined | null {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000 || !isSafeSkillMediaText(value)) return null;
  return value;
}

/** 严格编码：未知键、非法值或敏感内容一律拒绝（在任何人看到事件之前）。 */
export function encodeSkillStepUpdatedEvent(
  event: SkillStepUpdatedEvent
): { ok: true; payload: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const payload: Record<string, unknown> = {
    type: event.type,
    canvasId: event.canvasId,
    nodeId: event.nodeId,
    skillRunId: event.skillRunId,
    stepId: event.stepId,
    attempt: event.attempt,
    promptRevision: event.promptRevision,
    state: event.state,
    current: event.current,
    superseded: event.superseded,
    at: event.at
  };
  for (const key of ["runId", "jobId", "supersededByRunId", "latestSuccessfulRunId"] as const) {
    if (event[key] !== undefined) payload[key] = event[key];
  }
  if (event.supersededByAttempt !== undefined) payload.supersededByAttempt = event.supersededByAttempt;
  if (event.progress !== undefined) payload.progress = event.progress;
  if (event.error !== undefined) payload.error = event.error;
  const decoded = decodeSkillStepUpdatedEvent(payload);
  return decoded.ok ? { ok: true, payload } : decoded;
}

/** 严格解码：旧 payload 不含新字段时按缺省解码；敏感/未知字段拒绝。 */
export function decodeSkillStepUpdatedEvent(
  raw: unknown
): { ok: true; value: SkillStepUpdatedEvent } | { ok: false; code: string; message: string } {
  if (!isJsonObject(raw)) return fail("malformed-event", "skill-step-updated 必须是对象");
  const unknown = Object.keys(raw).find((key) => !(EVENT_KEYS as readonly string[]).includes(key));
  if (unknown) return fail("malformed-event", `事件包含未知字段 ${unknown}`);
  if (raw.type !== SKILL_STEP_EVENT_TYPE) return fail("malformed-event", "事件类型不匹配");
  for (const key of ["canvasId", "nodeId", "skillRunId", "stepId"] as const) {
    if (!isBoundedId(raw[key])) return fail("malformed-event", `${key} 必须是非空字符串`);
  }
  if (!isBoundedId(raw.at, 64)) return fail("malformed-event", "at 必须是非空字符串");
  if (!Number.isInteger(raw.attempt) || (raw.attempt as number) < 1) return fail("malformed-event", "attempt 必须是正整数");
  if (!Number.isInteger(raw.promptRevision) || (raw.promptRevision as number) < 1) {
    return fail("malformed-event", "promptRevision 必须是正整数");
  }
  if (!isSkillMediaState(raw.state)) return fail("malformed-event", "state 非法");
  if (typeof raw.current !== "boolean") return fail("malformed-event", "current 必须是布尔值");
  if (typeof raw.superseded !== "boolean") return fail("malformed-event", "superseded 必须是布尔值");
  const runId = readOptionalBoundedId(raw, "runId");
  if (runId === null) return fail("malformed-event", "runId 非法");
  const jobId = readOptionalBoundedId(raw, "jobId");
  if (jobId === null) return fail("malformed-event", "jobId 非法");
  const supersededByRunId = readOptionalBoundedId(raw, "supersededByRunId");
  if (supersededByRunId === null) return fail("malformed-event", "supersededByRunId 非法");
  const latestSuccessfulRunId = readOptionalBoundedId(raw, "latestSuccessfulRunId");
  if (latestSuccessfulRunId === null) return fail("malformed-event", "latestSuccessfulRunId 非法");
  const error = readOptionalSafeText(raw, "error");
  if (error === null) return fail("malformed-event", "error 必须是安全的有界文本");
  if (raw.supersededByAttempt !== undefined && (!Number.isInteger(raw.supersededByAttempt) || (raw.supersededByAttempt as number) < 1)) {
    return fail("malformed-event", "supersededByAttempt 必须是正整数");
  }
  if (raw.progress !== undefined && (!isFiniteNumber(raw.progress) || raw.progress < 0 || raw.progress > 100)) {
    return fail("malformed-event", "progress 必须在 0–100 之间");
  }
  const value: SkillStepUpdatedEvent = {
    type: SKILL_STEP_EVENT_TYPE,
    canvasId: raw.canvasId as string,
    nodeId: raw.nodeId as string,
    skillRunId: raw.skillRunId as string,
    stepId: raw.stepId as string,
    attempt: raw.attempt as number,
    promptRevision: raw.promptRevision as number,
    state: raw.state,
    current: raw.current,
    superseded: raw.superseded,
    at: raw.at as string,
    ...(runId !== undefined ? { runId } : {}),
    ...(jobId !== undefined ? { jobId } : {}),
    ...(supersededByRunId !== undefined ? { supersededByRunId } : {}),
    ...(latestSuccessfulRunId !== undefined ? { latestSuccessfulRunId } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(raw.supersededByAttempt !== undefined ? { supersededByAttempt: raw.supersededByAttempt as number } : {}),
    ...(raw.progress !== undefined ? { progress: raw.progress as number } : {})
  };
  return { ok: true, value };
}

/** 最新媒体查询原因：有界、稳定，不暴露提供商临时状态。 */
export const SKILL_STEP_OUTPUT_REASONS = [
  "running",
  "cancelled",
  "failed",
  "superseded",
  "no-output",
  "output-unavailable"
] as const;
export type SkillStepOutputReason = (typeof SKILL_STEP_OUTPUT_REASONS)[number];

/**
 * 最新成功媒体视图。
 *
 * `fallback` 只在调用方显式请求回退且当前尝试失败/取消时出现；它明确标注旧版本，
 * 不能冒充当前尝试成功。
 */
export type SkillStepOutputView =
  | {
      available: true;
      current: true;
      skillRunId: string;
      stepId: string;
      attempt: number;
      promptRevision: number;
      runId: string;
      output: AgentNodeOutput;
    }
  | {
      available: true;
      current: false;
      /** 旧成功版本（显式回退）。 */
      fallback: { attempt: number; promptRevision: number; runId: string; output: AgentNodeOutput };
      skillRunId: string;
      stepId: string;
      attempt: number;
      promptRevision: number;
      runId: string;
      reason: SkillStepOutputReason;
      message: string;
    }
  | {
      available: false;
      skillRunId: string;
      stepId: string;
      attempt: number;
      promptRevision: number;
      runId?: string;
      reason: SkillStepOutputReason;
      message: string;
      /** 是否存在可显式请求的旧成功版本。 */
      fallbackAvailable: boolean;
    };

export type SkillStepWaitPhase = "succeeded" | "failed" | "cancelled" | "superseded" | "timeout" | "running";

/** 有界等待结果：只表达等待/跟随事实，不隐式提交生成。 */
export type SkillStepWaitView = {
  skillRunId: string;
  stepId: string;
  phase: SkillStepWaitPhase;
  attempt: number;
  promptRevision: number;
  runId?: string;
  /** 等待期间是否因替代关系切换到更新的尝试。 */
  followed: boolean;
  /** 被跟随跳过（已替代）的 run 身份。 */
  replacedRunIds: readonly string[];
  step: SkillMediaStepView;
  outputView?: SkillStepOutputView;
  /** 等待被调用方取消或信号中止（不取消媒体生成）。 */
  cancelled?: boolean;
};

/** 事件重放页；无法证明连续性时 `resetRequired`，调用方必须重读步骤快照。 */
export type SkillStepEventPage = {
  events: readonly (SkillStepUpdatedEvent & { sequence: number })[];
  cursor: number;
  resetRequired: boolean;
};

/**
 * Skill 续接公共错误分类（任务 1.3）。
 *
 * 与既有 Agent 协议错误一样按字符串判定；调用方不得依赖 message 文本。
 */
export const SKILL_MEDIA_ERROR_CODES = [
  /** 步骤/尝试不存在，或不属于调用方 owner/canvas 作用域。 */
  "skill-step-not-found",
  /** 同一 requestId 携带了不同规范化输入。 */
  "request-id-reused",
  /** attempt 已被更新尝试替代，不能继续作为当前尝试。 */
  "skill-attempt-superseded",
  /** 组作用域/epoch 已失效。 */
  "group-scope-revoked",
  /** 步骤身份属于其它 owner 或组。 */
  "forbidden",
  /** 宿主步骤 ledger 暂时不可用。 */
  "unavailable",
  /** 请求结构非法。 */
  "malformed-request"
] as const;
export type SkillMediaErrorCode = (typeof SKILL_MEDIA_ERROR_CODES)[number];

export function isSkillMediaErrorCode(value: unknown): value is SkillMediaErrorCode {
  return typeof value === "string" && (SKILL_MEDIA_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 外部 Agent 可见的步骤视图：去掉每个尝试的原始提示词。
 *
 * owner UI 的历史核对仍可读完整快照；MCP 工具输出只返回身份、状态与安全摘要。
 */
export type SkillMediaStepAgentView = Omit<SkillMediaStepView, "attempts"> & {
  attempts: ReadonlyArray<Omit<SkillMediaAttemptView, "prompt">>;
};

export function redactSkillStepForAgent(step: SkillMediaStepView): SkillMediaStepAgentView {
  const attempts = step.attempts.map(({ prompt: _prompt, ...attempt }) => attempt);
  return { ...step, attempts };
}

/** 步骤续接工具名（能力发现与授权白名单共用同一事实源）。 */
export const SKILL_CONTINUATION_TOOLS = ["wait_for_skill_step", "get_latest_skill_step_output"] as const;
export type SkillContinuationTool = (typeof SKILL_CONTINUATION_TOOLS)[number];
