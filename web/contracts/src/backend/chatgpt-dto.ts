/**
 * ChatGPT 个人授权与 3D 生成协议 DTO
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.1 / design D2/D3/D4/D5）。
 *
 * 同源路径 `/api/oauth-agent/*`：浏览器只读写**授权状态快照**、个人模型目录、生成请求与同源
 * 进度事件。access/refresh/ID token 绝不进入这些 DTO，也绝不进入浏览器存储：它们由后端按
 * owner 加密持久化。owner 由后端可信认证（`principal.subject`）或本地 HttpOnly 会话 cookie
 * 决定，客户端自报 userId / localStorage ID / 代理头 / 管理员令牌都不能选择 owner。
 *
 * 本模块只含稳定 DTO、路径常量、状态枚举与无副作用 decoder；不含 OAuth、SDK、加密或
 * HTTP handler 实现（那些由 `@woohaa3/extension-oauth-agent` 提供）。
 */
import { isJsonObject } from "../validation.js";

export const DEFAULT_CHATGPT_BASE_PATH = "/api/oauth-agent";

/**
 * 个人授权状态机（design D3）。
 *
 * - `disconnected`：没有凭据；
 * - `authorizing`：存在未完成事务；
 * - `connected-without-plan`：身份已登录但缺少订阅使用 scope，生成不可用；
 * - `ready`：有效 access token 且含订阅 scope，可生成；
 * - `reauthorization-required`：续期失败/权限缺失/主体变化，需重新授权。
 */
export const CHATGPT_AUTH_STATES = [
  "disconnected",
  "authorizing",
  "connected-without-plan",
  "ready",
  "reauthorization-required"
] as const;
export type ChatGptAuthState = (typeof CHATGPT_AUTH_STATES)[number];

export function isChatGptAuthState(value: unknown): value is ChatGptAuthState {
  return typeof value === "string" && (CHATGPT_AUTH_STATES as readonly string[]).includes(value);
}

/** 生成目标模式（片场已下线；`camera` 指模型自身的镜头预设子资源）。 */
export const CHATGPT_GENERATION_MODES = ["model3d", "camera"] as const;
export type ChatGptGenerationMode = (typeof CHATGPT_GENERATION_MODES)[number];

export function isChatGptGenerationMode(value: unknown): value is ChatGptGenerationMode {
  return typeof value === "string" && (CHATGPT_GENERATION_MODES as readonly string[]).includes(value);
}

/** 应用支持的思考强度；省略参数时沿用模型默认配置。 */
export const CHATGPT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ChatGptReasoningEffort = (typeof CHATGPT_REASONING_EFFORTS)[number];

export function isChatGptReasoningEffort(value: unknown): value is ChatGptReasoningEffort {
  return typeof value === "string" && (CHATGPT_REASONING_EFFORTS as readonly string[]).includes(value);
}

/** 展示用账户信息：绝不包含 token。 */
export type ChatGptAccountView = {
  email?: string;
  /** 经过验证的 ChatGPT subject；仅用于展示/核验，不用于选择 owner。 */
  subject?: string;
  connectedAt?: string;
};

/** 授权状态快照（公开面：绝不含 token）。 */
export type ChatGptAuthSnapshot = {
  state: ChatGptAuthState;
  planEnabled: boolean;
  account?: ChatGptAccountView;
  /** 本地开发会话模式（无应用登录）；用于文案提示，不改变 owner 选择规则。 */
  localSession: boolean;
  /** 当前生效的授权场景：应用用户或本地会话。 */
  ownerKind: "principal" | "local-session";
  /** 可读的最近错误（不含 token）。 */
  message?: string;
};

/** 个人账户模型目录项（使用账户实际返回的 slug/displayName）。 */
export type ChatGptModelView = {
  id: string;
  label: string;
};

export type ChatGptModelsSnapshot = {
  models: ChatGptModelView[];
  /** 目录读取失败时的可读原因（不掩盖实际调用失败）。 */
  error?: string;
};

export type ChatGptAuthorizeStartResponse = {
  /** 服务端构造的授权 URL；前端只负责同源弹窗打开。 */
  url: string;
  /** 事务有效期（毫秒）。 */
  expiresAt: number;
};

/** 授权回执：只含可刷新状态的结果，绝不携带 token。 */
export type ChatGptAuthorizeCompleteResponse = ChatGptAuthSnapshot;

/** 生成请求：稳定 requestId 关联推理与权威提交（design D4/D5）。 */
export type ChatGptGenerateRequest = {
  requestId: string;
  canvasId: string;
  nodeId: string;
  mode: ChatGptGenerationMode;
  model: string;
  prompt: string;
  /** 不提供时使用模型默认思考强度。 */
  reasoningEffort?: ChatGptReasoningEffort;
  /** 目标并发 precondition：模型内容哈希 / 完整动画 snapshotHash（按模式）。 */
  expectedContentHash?: string;
  /** 提交时选中的稳定镜头 id（仅 camera 模式）。 */
  selectedCameraId?: string;
  clipId?: string; itemId?: string;
};

export type ChatGptGenerateAccepted = {
  requestId: string;
  /** 已受理（推理进行中）；真实成功以权威提交回执为准。 */
  accepted: true;
};

/** requestId 查询回执：重连/重试使用同一结果，不重复推理计费。 */
export type ChatGptGenerationReceipt = { llmOutput?: string; clipId?: string } & (
  | { status: "running"; requestId: string; stage: string }
  | { status: "succeeded"; requestId: string; mode: ChatGptGenerationMode; canvasId: string; nodeId: string; commandId: string; revision?: number }
  /**
   * 部分成功：一次生成同时请求多个语义（如模型 + 镜头）时，主改动已提交、附加改动失败。
   * 设计上**不原子**（用户确认）：已成功部分保留，失败部分在回执中说明，不整体回滚。
   */
  | {
      status: "partial";
      requestId: string;
      mode: ChatGptGenerationMode;
      canvasId: string;
      nodeId: string;
      applied: string[];
      failed: Array<{ part: string; code: string; message: string }>;
    }
  | { status: "failed"; requestId: string; mode: ChatGptGenerationMode; code: string; message: string }
  | { status: "cancelled"; requestId: string; mode: ChatGptGenerationMode }
  | { status: "unknown"; requestId: string });

/** 同源进度事件（SSE `event: progress` / `event: result`）。 */
export type ChatGptProgressEvent = {
  requestId: string;
  stage: string;
  detail?: string;
};

/** 同源路由后缀（相对 base path）。 */
export const CHATGPT_ROUTES = {
  status: "status",
  authorizeStart: "authorize/start",
  authorizeCancel: "authorize/cancel",
  authorizeComplete: "authorize/complete",
  disconnect: "disconnect",
  models: "models",
  generate: "generate",
  cancel: "cancel",
  events: "events"
} as const;

type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function fail(code: string, message: string): DecodeResult<never> {
  return { ok: false, code, message };
}

function readId(value: unknown, key: string): string | { error: string } {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    return { error: `${key} 必须是非空字符串` };
  }
  return value;
}

/** 解码生成请求（结构校验；字段级语义在服务端校验）。 */
export function decodeChatGptGenerateRequest(body: unknown): DecodeResult<ChatGptGenerateRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const requestId = readId(body.requestId, "requestId");
  if (typeof requestId === "object") return fail("malformed-request", requestId.error);
  const canvasId = readId(body.canvasId, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  const nodeId = readId(body.nodeId, "nodeId");
  if (typeof nodeId === "object") return fail("malformed-request", nodeId.error);
  const mode = body.mode;
  if (!isChatGptGenerationMode(mode)) return fail("malformed-request", "mode 必须是 model3d / camera");
  const model = readId(body.model, "model");
  if (typeof model === "object") return fail("malformed-request", model.error);
  if (body.reasoningEffort !== undefined && !isChatGptReasoningEffort(body.reasoningEffort)) {
    return fail("malformed-request", "reasoningEffort 必须是 low / medium / high / xhigh / max / ultra");
  }
  if (typeof body.prompt !== "string" || body.prompt.trim() === "" || body.prompt.length > 20_000) {
    return fail("malformed-request", "prompt 必须是 1-20000 字符");
  }
  if (body.expectedContentHash !== undefined && typeof body.expectedContentHash !== "string") {
    return fail("malformed-request", "expectedContentHash 必须是字符串");
  }
  if (body.itemId !== undefined && (typeof body.itemId !== "string" || !body.itemId.trim() || body.itemId.length > 256)) return fail("malformed-request", "itemId 非法");
  if (body.clipId !== undefined && (typeof body.clipId !== "string" || !body.clipId.trim() || body.clipId.length > 256)) return fail("malformed-request", "clipId 非法");
  if (body.selectedCameraId !== undefined && typeof body.selectedCameraId !== "string") {
    return fail("malformed-request", "selectedCameraId 必须是字符串");
  }
  return {
    ok: true,
    value: {
      requestId,
      canvasId,
      nodeId,
      mode,
      model,
      prompt: body.prompt,
      ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort as ChatGptReasoningEffort }),
      ...(body.expectedContentHash === undefined ? {} : { expectedContentHash: body.expectedContentHash }),
      ...(body.clipId === undefined ? {} : { clipId: body.clipId as string }),
      ...(body.itemId === undefined ? {} : { itemId: body.itemId as string }),
      ...(body.selectedCameraId === undefined ? {} : { selectedCameraId: body.selectedCameraId })
    }
  };
}

/** 解码 requestId 查询参数（回执恢复）。 */
export function decodeChatGptRequestIdQuery(value: string | null | undefined): DecodeResult<{ requestId: string }> {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    return fail("malformed-request", "requestId 必须是非空字符串");
  }
  return { ok: true, value: { requestId: value } };
}
