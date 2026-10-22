/**
 * Task Service 认证内部 v1 API（change: split-web-runtime-services，任务 4.3 / 4.4）。
 *
 * ```
 * PUT  /internal/v1/tasks/:workerTaskKey         幂等 submit（durable accepted 后返回）
 * POST /internal/v1/tasks/:workerTaskKey/cancel  幂等 cancel
 * GET  /internal/v1/tasks/:workerTaskKey         单条 status
 * GET  /internal/v1/task-history?after=&limit=   持久化 history（Canvas 恢复事实源）
 * GET  /internal/v1/task-events?after=           已持久化事实的事件流（仅降延迟）
 * ```
 *
 * submit 只接受受信任服务身份；浏览器直连被拒绝。相同 key + 相同 payload 复用既有任务，
 * 相同 key + 不同 payload 返回 `key-reused`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkProtocolVersion,
  decodeTaskSubmitRequest,
  decodeCanvasTaskActivityQuery,
  hashStorageKeyForLog,
  checkModelCapability,
  containsWoohaa3CanvasMentionToken,
  validateAgainstSchema,
  sameModelInteraction,
  WOOHAA3_PROTOCOL_VERSION,
  type CanvasTaskCatalog,
  type CanvasTaskActivityEventBatch,
  type CanvasTaskActivitySnapshot,
  type ProtocolErrorCode,
  type TaskExecutionDetail,
  type TaskSubmitRequest,
  type TaskSubmitResponse } from "@woohaa3/contracts";
import type { TaskExecutionState } from "@woohaa3/contracts";
import type { SqliteTaskHistoryRepository } from "../repository/history-repository.js";
import type { MediaClient } from "../clients/media-client.js";
import { buildProviderInput, normalizeProviderResult, isProviderResultError } from "../worker/normalize.js";
import { safeProviderMessage } from "../worker/normalize.js";

export const DEFAULT_TASK_INTERNAL_BASE_PATH = "/internal/v1";

export type TaskApiDependencies = {
  /** 当前目录（可用性判定与能力校验）。 */
  resolveCatalog: () => Promise<CanvasTaskCatalog>;
  history: SqliteTaskHistoryRepository;
  /** durable 提交 + 调度入口（worker server）。 */
  submit: (input: TaskSubmitRequest) => Promise<{
    reused: boolean;
    state: TaskExecutionState;
    conflict?: boolean;
    /** 参考输入签名失败（在 provider 调用前失败）。 */
    mediaError?: string;
  }>;
  cancel: (workerTaskKey: string) => Promise<TaskExecutionState | null>;
  status: (workerTaskKey: string) => Promise<TaskExecutionDetail | undefined>;
  listHistory: (query: { after?: number; limit?: number }) => { items: TaskExecutionDetail[]; cursor: number };
  /** Canvas-scoped 安全活动快照（ACL 由 Canvas Service 前置校验；这里只按 canvasId 投影）。 */
  listCanvasActivity: (canvasId: string, query: { cursor?: string; limit?: number }) => CanvasTaskActivitySnapshot;
  /** 自 cursor 起的画布活动变更（可恢复事件流与断线补偿）。 */
  listCanvasActivitySince: (canvasId: string, after: number, limit?: number) => CanvasTaskActivityEventBatch;
  /** Media client：输入签名与输出转存（可选；缺少时需要媒体的任务失败）。 */
  mediaClient?: MediaClient;
  serviceToken?: string;
  basePath?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export type TaskApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const INTERNAL_BASE = "/internal/v1";

export function createTaskApiHandler(deps: TaskApiDependencies): TaskApiHandler {
  const basePath = (deps.basePath ?? DEFAULT_TASK_INTERNAL_BASE_PATH).replace(/\/$/, "");
  const log = deps.logger ?? (() => undefined);

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendError(res, 400, "malformed-request", "请求 URL 非法");
      return true;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;

    const versionHeader = headerValue(req.headers["x-woohaa3-protocol-version"]);
    const versionCheck = checkProtocolVersion(versionHeader === undefined ? undefined : Number(versionHeader));
    if (!versionCheck.ok) {
      sendError(res, 409, "protocol-incompatible", versionCheck.message);
      return true;
    }

    const token = headerValue(req.headers["x-woohaa3-service-token"]);
    if (!deps.serviceToken || token !== deps.serviceToken) {
      log({ event: "task-internal-unauthorized", status: 401, code: "unauthorized" });
      sendError(res, 401, "unauthorized", "缺少或无效的服务身份");
      return true;
    }

    const suffix = pathname.slice(basePath.length + 1);
    // task-history / task-events 是固定子路径。
    if (suffix === "task-history" && req.method === "GET") return handleHistory(req, res, deps, log);
    if (suffix === "task-events" && req.method === "GET") return handleEvents(req, res, deps, log);
    // canvas task activity（change: 2026-09-29-add-canvas-task-activity-feed；
    // change: unify-canvas-session-websocket 增加有限 `/changes` 补偿面）：
    // `/internal/v1/canvases/:canvasId/task-activity[/events|/changes]`。ACL 由 Canvas 前置校验。
    const activityMatch = /^canvases\/([^/]+)\/task-activity(\/events|\/changes)?$/.exec(suffix);
    if (activityMatch && req.method === "GET") {
      return handleCanvasActivity(req, res, deps, log, decodeURIComponent(activityMatch[1]), activityMatch[2]);
    }

    const match = /^tasks\/([^/]+)(\/cancel)?$/.exec(suffix);
    if (!match) {
      sendError(res, 404, "unsupported", "未知的内部任务路由");
      return true;
    }
    const workerTaskKey = decodeURIComponent(match[1]);
    const isCancel = match[2] === "/cancel";

    if (isCancel && req.method === "POST") return handleCancel(res, workerTaskKey, deps, log);
    if (!isCancel && req.method === "PUT") return handleSubmit(req, res, workerTaskKey, deps, log);
    if (!isCancel && req.method === "GET") return handleStatus(res, workerTaskKey, deps, log);
    sendError(res, 405, "unsupported", "方法不允许");
    return true;
  };
}

async function handleSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  workerTaskKey: string,
  deps: TaskApiDependencies,
  log: NonNullable<TaskApiDependencies["logger"]>
): Promise<boolean> {
  const body = await readJson(req);
  if (body === null) {
    sendError(res, 400, "malformed-request", "请求体不是合法 JSON");
    return true;
  }
  // path 参数是权威 key：body 里的同名字段必须一致，避免路径/载荷不一致。
  const withKey = { ...(body as Record<string, unknown>), workerTaskKey };
  const decoded = decodeTaskSubmitRequest(withKey);
  if (!decoded.ok) {
    sendError(res, 400, "malformed-request", decoded.message);
    return true;
  }
  const request = decoded.value;

  const catalog = await deps.resolveCatalog();
  if (!catalog.available) {
    sendError(res, 503, "unavailable", catalog.reason ?? "任务目录不可用");
    return true;
  }
  const model = catalog.models.find(
    (entry) => entry.modelKey === request.modelKey && entry.modelType === request.modelType
  );
  if (!model) {
    sendError(res, 400, "unsupported", `模型 ${request.modelKey} 不在启用集合内`);
    return true;
  }
  // interaction identity 必须与当前 catalog 一致（change: add-pluggable-model-interactions，D8）：
  // Canvas 编译请求时读取的 descriptor 若已变化，以 catalog-changed 失败并要求重新选择。
  if (request.interaction && !sameModelInteraction(request.interaction, model.interaction)) {
    log({ event: "task-submit", status: 409, code: "catalog-changed", taskKey: request.workerTaskKey });
    sendError(res, 409, "catalog-changed", "模型交互配置已变化，请刷新后重新提交");
    return true;
  }
  const capability = checkModelCapability(request, model);
  if (!capability.ok) {
    // 失败码原样转发："参考输入超过上限" 不能被降级成笼统的 "unsupported"。
    sendError(res, 400, capability.code, capability.message);
    return true;
  }

  // 受限参数 schema 校验（change: 2026-10-04-...，任务 3.4 / design D4）：
  // 按 catalog 声明的 inputSchema 校验参数；prompt 是独立请求字段，校验时并入。
  const schemaCheck = validateAgainstSchema({ prompt: request.prompt, ...request.parameters }, model.inputSchema);
  if (!schemaCheck.ok) {
    const first = schemaCheck.errors[0];
    log({ event: "task-submit", status: 400, code: "config-invalid", taskKey: request.workerTaskKey });
    sendError(res, 400, "malformed-request", `参数不符合模型 schema：${first ? `${first.path} ${first.message}` : "非法参数"}`);
    return true;
  }

  // 模型级 prompt 要求（任务 3.4 / design D4）：required 必须非空；optional/none 允许纯素材。
  const promptRequirement = model.promptRequirement ?? "required";
  if (promptRequirement === "required" && request.prompt.trim() === "") {
    sendError(res, 400, "malformed-request", "该模型要求非空提示词");
    return true;
  }

  // 内部 mention token 防线（change: add-reference-inputs-and-mentions，任务 6.3）：
  // Task Service 只接收已编译的 Provider prompt；含 `{{input_*:...}}` 视为协议错误。
  if (containsWoohaa3CanvasMentionToken(request.prompt)) {
    log({ event: "task-submit", status: 400, code: "uncompiled-mention-token", taskKey: request.workerTaskKey });
    sendError(res, 400, "malformed-request", "任务 prompt 含未编译的内部 mention token");
    return true;
  }

  // 参考对象必须存在且 metadata 一致（经 Media Service，不直接读 COS）。
  if (request.inputs.length > 0) {
    if (!deps.mediaClient) {
      sendError(res, 503, "unavailable", "任务需要媒体校验能力，但 Media Service 未配置");
      return true;
    }
    for (const input of request.inputs) {
      let verified;
      try {
        // 参考对象要按**本次任务的画布作用域**核验：远端画布的资产可能只在托管存储里
        // （别人生成的图、本机远端生成的结果），不带作用域会退化成只查主存储，把存在的
        // 参考对象报成「不存在」，让图生图/视频生视频在协作画布上永远失败。
        verified = await deps.mediaClient.verify(input.storageKey, undefined, { canvasId: request.canvasId });
      } catch (error) {
        log({ event: "task-submit", status: 502, code: "media-unavailable", storageKeyHash: hashStorageKeyForLog(input.storageKey) });
        sendError(res, 502, "unavailable", safeProviderMessage(error));
        return true;
      }
      if (!verified.exists) {
        sendError(res, 400, "media-not-found", `参考对象不存在：${input.assetId}`);
        return true;
      }
    }
  }

  let outcome;
  try {
    outcome = await deps.submit(request);
  } catch (error) {
    log({ event: "task-submit", status: 500, code: "submit-failed", taskKey: request.workerTaskKey });
    sendError(res, 500, "storage-failed", safeProviderMessage(error));
    return true;
  }

  if (outcome.conflict) {
    log({ event: "task-submit", status: 409, code: "key-reused", taskKey: request.workerTaskKey });
    sendError(res, 409, "key-reused", "相同 workerTaskKey 使用了不同 payload");
    return true;
  }

  // 参考输入签名失败：在调用 provider 之前失败，不产生执行（spec「签名 URL 生成失败」）。
  if (outcome.mediaError) {
    log({ event: "task-submit", status: 502, code: "media-signing-failed", taskKey: request.workerTaskKey });
    sendError(res, 502, "unavailable", outcome.mediaError);
    return true;
  }

  const response: TaskSubmitResponse = {
    workerTaskKey: request.workerTaskKey,
    state: outcome.state,
    reused: outcome.reused,
    canvasId: request.canvasId,
    nodeId: request.nodeId,
    runId: request.runId
  };
  log({ event: "task-submit", status: 202, taskKey: request.workerTaskKey });
  sendJson(res, 202, response);
  return true;
}

async function handleCancel(
  res: ServerResponse,
  workerTaskKey: string,
  deps: TaskApiDependencies,
  log: NonNullable<TaskApiDependencies["logger"]>
): Promise<boolean> {
  const state = await deps.cancel(workerTaskKey);
  if (!state) {
    sendError(res, 404, "task-not-found", "任务不存在");
    return true;
  }
  log({ event: "task-cancel", status: 200, taskKey: workerTaskKey });
  sendJson(res, 200, { workerTaskKey, state });
  return true;
}

async function handleStatus(
  res: ServerResponse,
  workerTaskKey: string,
  deps: TaskApiDependencies,
  log: NonNullable<TaskApiDependencies["logger"]>
): Promise<boolean> {
  const detail = await deps.status(workerTaskKey);
  if (!detail) {
    sendError(res, 404, "task-not-found", "任务不存在");
    return true;
  }
  log({ event: "task-status", status: 200, taskKey: workerTaskKey });
  sendJson(res, 200, detail);
  return true;
}

function handleHistory(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TaskApiDependencies,
  log: NonNullable<TaskApiDependencies["logger"]>
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const after = Number(url.searchParams.get("after") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "200");
  const result = deps.listHistory({
    after: Number.isFinite(after) && after >= 0 ? after : 0,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 200
  });
  log({ event: "task-history", status: 200 });
  sendJson(res, 200, { items: result.items, cursor: result.cursor });
  return true;
}

/**
 * 事件流：首版用 NDJSON 轮询推送（durable 记录 + cursor）。
 *
 * 事件只是**降低延迟**的通道；断线后调用方必须用 `after=<cursor>` 从 history 补齐
 * （design D4 / spec「事件不是唯一事实源」）。这里实现为有限次推送后结束，客户端重连。
 */
async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TaskApiDependencies,
  log: NonNullable<TaskApiDependencies["logger"]>
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const after = Number(url.searchParams.get("after") ?? "0");
  const from = Number.isFinite(after) && after >= 0 ? after : 0;
  const records = deps.listHistory({ after: from, limit: 200 });
  log({ event: "task-events", status: 200 });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const lines = records.items.map((item) => JSON.stringify({ record: item, cursor: records.cursor }));
  res.end(lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return true;
}

/**
 * Canvas-scoped 任务活动（change: 2026-09-29-add-canvas-task-activity-feed，任务 1.3 / design D3）。
 *
 * 只服务受信任的 Canvas Service（内部令牌已在入口校验）。ACL 由 Canvas 在调用前完成，
 * 这里只按 canvasId 严格过滤并返回安全卡片字段，绝不返回请求摘要/事件/provider 身份。
 */
function handleCanvasActivity(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TaskApiDependencies,
  log: NonNullable<TaskApiDependencies["logger"]>,
  canvasId: string,
  variant: string | undefined
): boolean {
  if (!canvasId) {
    sendError(res, 400, "malformed-request", "缺少 canvasId");
    return true;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (variant === "/events" || variant === "/changes") {
    const after = Number(url.searchParams.get("after") ?? "0");
    const from = Number.isFinite(after) && after >= 0 ? after : 0;
    const batch = deps.listCanvasActivitySince(canvasId, from, 200);
    log({ event: variant === "/changes" ? "task-canvas-activity-changes" : "task-canvas-activity-events", status: 200 });
    sendJson(res, 200, batch);
    return true;
  }
  const query = decodeCanvasTaskActivityQuery(Object.fromEntries(url.searchParams.entries()));
  const snapshot = deps.listCanvasActivity(canvasId, query);
  log({ event: "task-canvas-activity", status: 200 });
  sendJson(res, 200, snapshot);
  return true;
}

function headerValue(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function sendError(res: ServerResponse, status: number, code: ProtocolErrorCode, message: string): void {
  sendJson(res, status, { code, message, protocolVersion: WOOHAA3_PROTOCOL_VERSION });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

async function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error("payload-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

export { buildProviderInput, normalizeProviderResult, isProviderResultError, INTERNAL_BASE };
