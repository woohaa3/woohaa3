/**
 * 宿主 Agent 会话 durable 记录类型与行映射
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.4/1.8 / design D1/D2/D7）。
 *
 * 从 `agent-conversation-repository.ts` 拆出（业务源码规模门禁）：公开记录形状、SQLite 行类型与
 * 纯映射/终态判定集中于此；存储实现（建表、原子写、有界读）仍由 repository 持有。
 */
export type ConversationAdapterBinding = {
  contextKey?: string | null;
  conversationId: string;
  owner: string;
  canvasId: string;
  adapterId: string;
  /**
   * 当前会话冻结的来源连接 id（change: 2026-10-16-...，任务 2.2 / design D7）。
   *
   * 旧数据为 null；读取时由服务层映射为该 owner 的兼容默认连接（既有 ChatGPT），不改写原行。
   */
  connectionId: string | null;
  title: string;
  status: string;
  latestRequestId: string | null;
  /**
   * 关联的生成目标节点（一个节点复用一条会话；design D8）。
   *
   * 为空表示未绑定目标（如仅讨论建立的会话）或已被「清空上下文」归档（归档后不再被按节点查找）。
   */
  nodeId: string | null;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationTurnRecord = {
  turnId: string;
  conversationId: string;
  owner: string;
  canvasId: string;
  requestId: string;
  action: string;
  status: string;
  stage: string;
  /** 规范化输入 hash（requestId 去重依据）。 */
  inputHash: string;
  targetJson: string;
  /** 完整 entry intent JSON（含 prompt/references；dispatch 与恢复用）。 */
  intentJson: string;
  /**
   * 该回合冻结的连接身份（change: 2026-10-16-...，任务 2.2 / design D7）。
   *
   * 与 requestId/inputHash 一起构成幂等身份：同 requestId 换连接/配置/epoch MUST 拒绝。
   * 旧数据为 null（映射兼容默认连接，不改写原行）。
   */
  connectionId: string | null;
  connectionAdapterId: string | null;
  connectionConfigRevision: number | null;
  connectionCredentialEpoch: number | null;
  /** 受理时冻结的模型 reasoning 能力修订号（旧数据 null）。 */
  connectionCapabilityRevision?: string | null;
  /**
   * 受理时冻结的历史基准（消息 sequence 上界；change: 2026-10-22-remove-agent-execution-limits，
   * 任务 3.1 / design D3）。
   *
   * 每个回合只读取受理前已完成的合法前缀，不纳入其他并发回合尚在生成中的半条输出。
   * 旧数据为 null（按当前全部历史读取）。
   */
  historySequence: number | null;
  /**
   * 受理时冻结的角色身份与准备内容（change: 2026-11-07-add-pluggable-agent-roles）。
   *
   * 旧数据为 null：按 legacy 事实读取，不补造角色指纹、不重新准备。
   */
  roleRefJson: string | null;
  preparedJson: string | null;
  roleInputDigest: string | null;
  /**
   * 执行器 journal 已消费的事件 cursor（change: 2026-11-10-split-agent-runtime-lifecycle）。
   * 旧回合为 null：接管时从当前 journal 头开始，跳过历史重放。
   */
  executorCursor: number | null;
  /** 接管者实例 id 与租约截止（epoch ms）；CAS 保证同一回合只有一个接管者。 */
  adoptionOwner: string | null;
  adoptionLeaseUntil: number | null;
  assistantText: string | null;
  runId: string | null;
  taskId: string | null;
  receiptJson: string | null;
  /** 请求/应用结果（不保存隐藏推理内容）。旧数据缺省。 */
  reasoningJson?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConversationMessageRecord = {
  messageId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  role: string;
  content: string;
  truncated: number;
  sequence: number;
  createdAt: string;
};

export type ConversationEventRecord = {
  sequence: number;
  conversationId: string;
  turnId: string;
  requestId: string;
  type: string;
  payloadJson: string;
  createdAt: string;
};

export type ConversationToolRecord = {
  toolId: string;
  conversationId: string;
  turnId: string;
  tool: string;
  status: string;
  summary: string | null;
  sequence: number;
  createdAt: string;
};

export type OwnerCanvasScope = { owner: string; canvasId: string };

export type ConversationRow = {
  context_key?: string | null;
  conversation_id: string;
  owner: string;
  canvas_id: string;
  adapter_id: string;
  connection_id: string | null;
  title: string;
  status: string;
  latest_request_id: string | null;
  node_id: string | null;
  turn_count: number;
  created_at: string;
  updated_at: string;
};

export type TurnRow = {
  turn_id: string;
  conversation_id: string;
  owner: string;
  canvas_id: string;
  request_id: string;
  action: string;
  status: string;
  stage: string;
  input_hash: string;
  target_json: string;
  intent_json: string;
  connection_id: string | null;
  connection_adapter_id: string | null;
  connection_config_revision: number | null;
  connection_credential_epoch: number | null;
  connection_capability_revision?: string | null;
  /** 受理时冻结的历史基准（change: 2026-10-22-remove-agent-execution-limits，任务 3.1）。 */
  history_sequence: number | null;
  role_ref_json?: string | null;
  prepared_json?: string | null;
  role_input_digest?: string | null;
  executor_cursor?: number | null;
  adoption_owner?: string | null;
  adoption_lease_until?: number | null;
  assistant_text: string | null;
  run_id: string | null;
  task_id: string | null;
  receipt_json: string | null;
  reasoning_json?: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageRow = {
  message_id: string;
  conversation_id: string;
  turn_id: string;
  request_id: string;
  role: string;
  content: string;
  truncated: number;
  sequence: number;
  created_at: string;
};

export type EventRow = {
  sequence: number;
  conversation_id: string;
  turn_id: string;
  request_id: string;
  type: string;
  payload_json: string;
  created_at: string;
};

export type ToolRow = {
  tool_id: string;
  conversation_id: string;
  turn_id: string;
  tool: string;
  status: string;
  summary: string | null;
  sequence: number;
  created_at: string;
};

// 旧版本可能遗留 `unknown`；读取期按终态处理（等价 failed），避免它继续当活动回合。
const TERMINAL_TURN_STATES = new Set(["succeeded", "partial", "failed", "cancelled", "unknown"]);

export function isTerminalTurnStatus(status: string): boolean {
  return TERMINAL_TURN_STATES.has(status);
}

export function conversationFromRow(row: ConversationRow): ConversationAdapterBinding {
  return {
    conversationId: row.conversation_id,
    owner: row.owner,
    canvasId: row.canvas_id,
    adapterId: row.adapter_id,
    connectionId: row.connection_id ?? null,
    contextKey: row.context_key ?? null,
    title: row.title,
    status: row.status,
    latestRequestId: row.latest_request_id,
    nodeId: row.node_id,
    turnCount: row.turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function turnFromRow(row: TurnRow): ConversationTurnRecord {
  return {
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    owner: row.owner,
    canvasId: row.canvas_id,
    requestId: row.request_id,
    action: row.action,
    status: row.status,
    stage: row.stage,
    inputHash: row.input_hash,
    targetJson: row.target_json,
    intentJson: row.intent_json,
    connectionId: row.connection_id ?? null,
    connectionAdapterId: row.connection_adapter_id ?? null,
    connectionConfigRevision: row.connection_config_revision ?? null,
    connectionCredentialEpoch: row.connection_credential_epoch ?? null,
    connectionCapabilityRevision: row.connection_capability_revision ?? null,
    historySequence: row.history_sequence ?? null,
    roleRefJson: row.role_ref_json ?? null,
    preparedJson: row.prepared_json ?? null,
    roleInputDigest: row.role_input_digest ?? null,
    executorCursor: row.executor_cursor ?? null,
    adoptionOwner: row.adoption_owner ?? null,
    adoptionLeaseUntil: row.adoption_lease_until ?? null,
    assistantText: row.assistant_text,
    runId: row.run_id,
    taskId: row.task_id,
    receiptJson: row.receipt_json,
    reasoningJson: row.reasoning_json ?? null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function messageFromRow(row: MessageRow): ConversationMessageRecord {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    requestId: row.request_id,
    role: row.role,
    content: row.content,
    truncated: row.truncated,
    sequence: row.sequence,
    createdAt: row.created_at
  };
}

export function eventFromRow(row: EventRow): ConversationEventRecord {
  return {
    sequence: row.sequence,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    requestId: row.request_id,
    type: row.type,
    payloadJson: row.payload_json,
    createdAt: row.created_at
  };
}

export function toolFromRow(row: ToolRow): ConversationToolRecord {
  return {
    toolId: row.tool_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    tool: row.tool,
    status: row.status,
    summary: row.summary,
    sequence: row.sequence,
    createdAt: row.created_at
  };
}

/**
 * 回合授权（change: 2026-11-10-split-agent-runtime-lifecycle，任务 2.1 / design D2）。
 *
 * 把「宿主进程内存闭包 + 内存 lease」换成可按回合身份跨宿主读取的持久权威：
 * 冻结 owner/画布/会话/连接版本/目标/准备摘要、允许的 host-call 方法与工具范围，
 * 以及过期/撤销状态。新宿主只按这份记录授权，不扩大原回合权限。
 */
export type TurnAuthorityRecord = {
  turnId: string;
  requestId: string;
  conversationId: string;
  owner: string;
  canvasId: string;
  action: string;
  adapterId: string;
  /** 该通道使用的 daemon executor id；非执行器通道为 null。 */
  executor: string | null;
  connectionId: string | null;
  configRevision: number | null;
  credentialEpoch: number | null;
  targetJson: string;
  preparedHash: string | null;
  /** 本回合可调用的宿主方法（`extension.call` 的 method 白名单）。 */
  hostMethods: readonly string[];
  /** 冻结的工具范围（与 grant 的 tools 交集），不接受接管时扩宽。 */
  toolScope: readonly string[];
  createdAt: string;
  expiresAt: number | null;
  revokedAt: string | null;
};

export type TurnAuthorityRow = {
  turn_id: string;
  request_id: string;
  conversation_id: string;
  owner: string;
  canvas_id: string;
  action: string;
  adapter_id: string;
  executor: string | null;
  connection_id: string | null;
  config_revision: number | null;
  credential_epoch: number | null;
  target_json: string;
  prepared_hash: string | null;
  host_methods_json: string;
  tool_scope_json: string;
  created_at: string;
  expires_at: number | null;
  revoked_at: string | null;
};

const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`turn authority ${field} 必须是字符串数组`);
  }
  return value as string[];
};

/** 严格解码：缺字段、类型错误或非法数组都拒绝，不猜默认值。 */
export function decodeTurnAuthority(row: TurnAuthorityRow): TurnAuthorityRecord {
  for (const field of ["turn_id", "request_id", "conversation_id", "owner", "canvas_id", "action", "adapter_id", "target_json", "created_at"] as const) {
    if (typeof row[field] !== "string" || row[field] === "") throw new Error(`turn authority 缺少 ${field}`);
  }
  for (const field of ["config_revision", "credential_epoch", "expires_at"] as const) {
    const value = row[field];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`turn authority ${field} 类型错误`);
  }
  let hostMethods: string[];
  let toolScope: string[];
  try {
    hostMethods = stringArray(JSON.parse(row.host_methods_json) as unknown, "hostMethods");
    toolScope = stringArray(JSON.parse(row.tool_scope_json) as unknown, "toolScope");
  } catch (error) {
    throw new Error(`turn authority 解码失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    turnId: row.turn_id,
    requestId: row.request_id,
    conversationId: row.conversation_id,
    owner: row.owner,
    canvasId: row.canvas_id,
    action: row.action,
    adapterId: row.adapter_id,
    executor: row.executor ?? null,
    connectionId: row.connection_id ?? null,
    configRevision: row.config_revision ?? null,
    credentialEpoch: row.credential_epoch ?? null,
    targetJson: row.target_json,
    preparedHash: row.prepared_hash ?? null,
    hostMethods,
    toolScope,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null
  };
}
