/**
 * Skill 媒体续接应用服务端口
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 2.2–2.4）。
 *
 * Application Service 拥有步骤/尝试 ledger；Canvas 的 run/cancel/status/output 仍由 Canvas
 * Run Service 实现。这里只声明受控端口，不 import canvas-service 实现。
 */
import type {
  AgentNodeOutputView,
  AgentRunView,
  SkillMediaRunRef,
  SkillStepUpdatedEvent
} from "@woohaa3/contracts";

export type SkillMediaRunInput = {
  owner: string;
  canvasId: string;
  nodeId: string;
  requestId: string;
  runId: string;
  skill: SkillMediaRunRef;
  modelKey?: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
};

export type SkillMediaRunResult =
  | { ok: true; canvasId: string; nodeId: string; runId: string; jobId: string; state: "accepted" }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type SkillMediaCancelResult =
  | { ok: true; canvasId: string; nodeId: string; runId: string; state: "cancel-requested" | "already-terminal" | "stale-run" }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type SkillMediaCanvasPort = {
  run(input: SkillMediaRunInput): Promise<SkillMediaRunResult>;
  cancel(input: { owner: string; canvasId: string; nodeId: string; runId: string }): Promise<SkillMediaCancelResult>;
  status(input: { owner: string; canvasId: string; nodeId: string; runId: string; waitMs?: number; skill?: SkillMediaRunRef }): Promise<
    { ok: true; view: AgentRunView } | { ok: false; code: string; message: string; retryable?: boolean }
  >;
  output(input: { owner: string; canvasId: string; nodeId: string; runId: string }): Promise<
    { ok: true; nodeId: string; runId: string; view: AgentNodeOutputView } | { ok: false; code: string; message: string }
  >;
};

export type SkillMediaAuthorizeInput = {
  owner: string;
  canvasId: string;
  permission: "read" | "write";
  rootGroupId?: string;
  scopeEpoch?: number;
  nodeId?: string;
};

/** 授权端口；缺失时仍按 owner+canvas 作用域拒绝跨 owner 读取（fail closed）。 */
export type SkillMediaAuthorizer = (
  input: SkillMediaAuthorizeInput
) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;

export type SkillMediaEventMirror = (input: {
  owner: string;
  canvasId: string;
  nodeId: string;
  event: SkillStepUpdatedEvent;
  createdAt: string;
}) => void;

export type SkillMediaServiceOptions = {
  store: import("./store.js").SqliteSkillMediaStore;
  canvas: SkillMediaCanvasPort;
  /**
   * 确定性 runId 派生（与 Canvas Run Service 同一规则）。
   *
   * UI 的“重新生成”只需要 requestId；缺少派生器时必须显式提供 runId。
   */
  deriveRunId?: (input: { canvasId: string; nodeId: string; requestId: string }) => string;
  authorize?: SkillMediaAuthorizer;
  mirrorEvent?: SkillMediaEventMirror;
  now?: () => string;
  /** 等待轮询间隔；测试可缩短。 */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** trusted settlement 记录：只由 Canvas/Task 投影回调提供，不接受外部自报。 */
export type SkillMediaSettlement = {
  canvasId: string;
  nodeId: string;
  runId: string;
  jobId?: string;
  state: "succeeded" | "failed" | "cancelled";
  mediaKind?: "text" | "image" | "video" | "audio";
  error?: string;
  terminalAt?: string;
};
