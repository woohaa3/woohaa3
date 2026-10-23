/**
 * 适配器共享运行支持
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 5.2/5.3/6.4/7.3 / design D6；
 *  change: 2026-10-22-remove-agent-execution-limits，任务 2.2 / design D1）。
 *
 * 两个扩展的适配器共用同一套宿主边界，避免各写一套领域执行器：
 * - **回合观察**：只记录工具次数与公开输出量用于诊断；**不**按次数、轮数、时长或输出量拒绝
 *   或终止回合。停止只来自用户取消、原生引擎真实结束/失败、断连恢复失败与权限/目标失效；
 * - **工具范围校验**：每次工具调用都经宿主 `ApplicationToolDelegationFacade.authorize`
 *   重新校验**同一冻结范围**（并行调用也逐次校验），越权即 `capability-unsupported`；
 * - **取消登记**：按 requestId 登记 `AbortController`，取消先撤销 grant 再中断上游；
 * - **能力预检**：图片/工具/结构化结果在**发送前**按连接能力拒绝，不把附件 URL 当已成功送入；
 * - **原生会话索引**：按连接 + epoch 归属；epoch 变化不复用。
 */
import type { AgentConnectionCapabilities, AgentConnectionModel, AgentCredentialPurpose } from "@woohaa3/contracts";
import type { ApplicationToolDelegationFacade } from "@woohaa3/contracts";

/** 回合观察量（仅供诊断与进度展示，不参与任何额度判定）。 */
export type TurnObservation = {
  /** 已观察到的工具事件数（含并行/重复事件；不是授权计数）。 */
  readonly toolCalls: number;
  /** 已观察到的公开输出字节数。 */
  readonly outputBytes: number;
  /** 回合已运行毫秒数（只读诊断；不用于终止）。 */
  readonly elapsedMs: number;
};

export type TurnObserver = {
  /** 记录一次工具事件（观察；永不影响执行）。 */
  noteToolCall(): void;
  /** 记录助手公开输出字节（观察；永不影响执行）。 */
  addOutput(bytes: number): void;
  /** 当前观察量快照。 */
  observe(now?: number): TurnObservation;
};

/**
 * 创建回合观察器。
 *
 * change: 2026-10-22-remove-agent-execution-limits —— 这里原本是 `createTurnBudget`，会在
 * 循环次数、工具次数、时长与输出字节超限时返回 `budget-exceeded`。这些应用侧额度已删除：
 * 合法工作持续到引擎正常结束、用户停止、权限/目标失效或真实故障。
 */
export function createTurnObserver(now: () => number = Date.now): TurnObserver {
  const started = now();
  let toolCalls = 0;
  let outputBytes = 0;
  return {
    noteToolCall() {
      toolCalls += 1;
    },
    addOutput(bytes) {
      outputBytes += bytes;
    },
    observe(nowMs = now()) {
      return { toolCalls, outputBytes, elapsedMs: Math.max(0, nowMs - started) };
    }
  };
}

export type TurnRegistry = {
  /** 登记在途回合；同一 requestId 重复登记返回既有控制器。 */
  register(requestId: string): AbortController;
  /** 移除登记（不影响已建立的 signal）。 */
  release(requestId: string): void;
  /** 取在途控制器（无则 null）。 */
  get(requestId: string): AbortController | undefined;
  /** 在途 requestId 集合（诊断/对账）。 */
  active(): string[];
};

export function createTurnRegistry(): TurnRegistry {
  const controllers = new Map<string, AbortController>();
  return {
    register(requestId) {
      const existing = controllers.get(requestId);
      if (existing) return existing;
      const controller = new AbortController();
      controllers.set(requestId, controller);
      return controller;
    },
    release(requestId) {
      controllers.delete(requestId);
    },
    get(requestId) {
      return controllers.get(requestId);
    },
    active() {
      return [...controllers.keys()];
    }
  };
}

/** 工具范围校验结果。 */
export type ToolAuthorizeResult = { ok: true } | { ok: false; code: "capability-unsupported"; message: string };
/**
 * 用宿主 grant facade 校验一次工具调用（同一冻结范围；并行逐次校验）。
 *
 * 未提供 facade（宿主未配置工具委托）时按能力拒绝，不静默放行。
 */
export function authorizeToolCall(
  facade: ApplicationToolDelegationFacade | undefined,
  input: { token: string; tool: string; canvasId?: string; nodeId?: string; clipId?: string; itemId?: string }
): ToolAuthorizeResult {
  if (!facade) return { ok: false, code: "capability-unsupported", message: "宿主未配置工具委托，禁止工具调用" };
  const result = facade.authorize(input);
  if (result.ok) return { ok: true };
  return { ok: false, code: "capability-unsupported", message: result.reason };
}

/** 发送前输入预检：按连接/模型能力拒绝不支持的目标输入。 */
export type PreflightResult = { ok: true } | { ok: false; code: "capability-unsupported"; message: string };
export function preflightInput(input: {
  capabilities: AgentConnectionCapabilities;
  model?: AgentConnectionModel;
  wantTools: boolean;
  imageCount: number;
  wantStructuredResult: boolean;
}): PreflightResult {
  const capabilities = input.capabilities;
  if (input.wantTools && !capabilities.tools) {
    return { ok: false, code: "capability-unsupported", message: "该连接未声明工具能力，不能执行目标动作" };
  }
  if (input.imageCount > 0) {
    const modelImage = input.model?.capabilities?.imageInput;
    const allowed = modelImage ?? capabilities.imageInput;
    if (!allowed) return { ok: false, code: "capability-unsupported", message: "该模型/连接不支持图片输入，已在发送前拒绝" };
  }
  if (input.wantStructuredResult) {
    const modelStructured = input.model?.capabilities?.structuredResult;
    const allowed = modelStructured ?? capabilities.structuredResult;
    if (!allowed) return { ok: false, code: "capability-unsupported", message: "该模型/连接不支持结构化结果" };
  }
  return { ok: true };
}

/** 原生会话/线程绑定的记忆化索引（按 connectionId + credentialEpoch 归属）。 */
export type NativeSessionIndex = {  /** 读取仍有效的原生 id；epoch 不匹配返回 null。 */
  get(connectionId: string, credentialEpoch: number): string | null;
  /** 记录原生 id 与当前 epoch。 */
  set(connectionId: string, credentialEpoch: number, nativeId: string): void;
  /** 清空某连接（换连接/清除凭据）。 */
  clear(connectionId: string): void;
};

export function createNativeSessionIndex(): NativeSessionIndex {
  const entries = new Map<string, { credentialEpoch: number; nativeId: string }>();
  return {
    get(connectionId, credentialEpoch) {
      const entry = entries.get(connectionId);
      if (!entry || entry.credentialEpoch !== credentialEpoch) return null;
      return entry.nativeId;
    },
    set(connectionId, credentialEpoch, nativeId) {
      entries.set(connectionId, { credentialEpoch, nativeId });
    },
    clear(connectionId) {
      entries.delete(connectionId);
    }
  };
}

/** 连接声明的默认能力（各适配器按实测覆盖；缺省全 false，不冒称）。 */
export function connectionCapabilities(input: Partial<AgentConnectionCapabilities>): AgentConnectionCapabilities {
  return {
    discussion: input.discussion ?? false,
    imageInput: input.imageInput ?? false,
    tools: input.tools ?? false,
    structuredResult: input.structuredResult ?? false,
    cancel: input.cancel ?? false,
    resume: input.resume ?? false
  };
}

export type { AgentCredentialPurpose };

/**
 * 回合终态日志（按 requestId）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 4.3/5.4 / design D6）。
 *
 * 宿主重启后 `query` 核对不应**重跑**推理：扩展内存里保留本进程内已落定的终态即可回答
 * `query`；进程重启后无记录则返回 null（宿主保留既有回执为 `unknown`，不重推理）。
 * 这只缓存**宿主事件语义**的终态，不含隐式推理或凭据。
 */
export type TurnOutcomeJournal = {
  /** 记录终态（重复覆盖以最后落定为准）。 */
  set(requestId: string, outcome: { status: "succeeded" | "partial" | "failed" | "cancelled" | "unknown"; assistantText?: string; runId?: string; taskId?: string; receipt?: unknown; error?: { code: string; message: string } }): void;
  /** 读取已落定终态；无记录返回 null（宿主不重推理）。 */
  get(requestId: string): { status: "succeeded" | "partial" | "failed" | "cancelled" | "unknown"; assistantText?: string; runId?: string; taskId?: string; receipt?: unknown; error?: { code: string; message: string } } | null;
  /** 结束（重试/清理）后移除。 */
  release(requestId: string): void;
  /** 已落定 requestId（诊断/对账）。 */
  settled(): string[];
};

export function createTurnOutcomeJournal(): TurnOutcomeJournal {
  const entries = new Map<string, NonNullable<ReturnType<TurnOutcomeJournal["get"]>>>();
  return {
    set(requestId, outcome) {
      entries.set(requestId, outcome);
    },
    get(requestId) {
      return entries.get(requestId) ?? null;
    },
    release(requestId) {
      entries.delete(requestId);
    },
    settled() {
      return [...entries.keys()];
    }
  };
}
