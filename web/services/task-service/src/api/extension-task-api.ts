/**
 * Task Service 插件任务内部 API
 * （change: 2026-10-05-extract-application-plugin-host，任务 4.1 / design D4）。
 *
 * ```
 * PUT  /internal/v1/extensions/:extensionId/tasks/:workerTaskKey          插件非画布任务提交
 * GET  /internal/v1/extensions/:extensionId/tasks/:workerTaskKey          插件任务状态
 * POST /internal/v1/extensions/:extensionId/tasks/:workerTaskKey/cancel   插件任务取消
 * ```
 *
 * 授权：只接受受信任服务身份（Application）；请求体携带可信 extensionId/configVersion/
 * delegatedActor。Task 校验服务身份后，把插件关联（extensionId/configVersion）持久化到任务记录，
 * 只允许查询/取消**同一插件**的任务；MUST NOT 接受 Application 伪造画布节点关联，也 MUST NOT
 * 让插件绕过 Canvas 节点 run/cancel。
 *
 * 插件任务不携带画布 nodeId/runId（非画布任务）；如请求含画布关联字段则稳定拒绝。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  WOOHAA3_PROTOCOL_VERSION,
  checkProtocolVersion,
  decodeTaskSubmitRequest,
  inferMediaKindFromType,
  hashStorageKeyForLog,
  checkModelCapability,
  containsWoohaa3CanvasMentionToken,
  resolveModelParameters,
  type CanvasTaskCatalog,
  type ProtocolErrorCode,
  type TaskExecutionDetail,
  type TaskSubmitRequest,
  type TaskSubmitResponse
} from "@woohaa3/contracts";
import type { SqliteTaskHistoryRepository } from "../repository/history-repository.js";
import type { MediaClient } from "../clients/media-client.js";
import type { ExtensionTaskAssociationStore } from "../repository/extension-task-association-repository.js";
import { safeProviderMessage } from "../worker/normalize.js";

export const PLUGIN_TASK_INTERNAL_BASE_PATH = "/internal/v1/extensions" as const;

export type TaskExtensionSubmitRequest = {
  workerTaskKey: string;
  modelType: string;
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  inputs?: readonly { assetId: string; role: string; storageKey: string; mediaType: string; mediaKind?: string }[];
  extensionId: string;
  configVersion: number;
  delegatedActor?: string;
};

export type TaskExtensionTaskApiDependencies = {
  resolveCatalog: () => Promise<CanvasTaskCatalog>;
  history: SqliteTaskHistoryRepository;
  /** 插件任务关联 durable 仓库（恢复/查询依据）。 */
  associations: ExtensionTaskAssociationStore;
  /** 复用既有 submit 路径，但把插件关联作为 canonical 请求的一部分。 */
  submit: (request: TaskSubmitRequest, association: { extensionId: string; configVersion: number }) => Promise<{
    reused: boolean;
    state: string;
    conflict?: boolean;
    mediaError?: string;
    parameterError?: { code: "missing-parameter" | "invalid-parameter"; message: string };
  }>;
  cancel: (workerTaskKey: string) => Promise<string | null>;
  status: (workerTaskKey: string) => Promise<TaskExecutionDetail | undefined>;
  mediaClient?: MediaClient;
  serviceToken?: string;
  basePath?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export type TaskExtensionTaskApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createTaskExtensionTaskApiHandler(deps: TaskExtensionTaskApiDependencies): TaskExtensionTaskApiHandler {
  const basePath = (deps.basePath ?? PLUGIN_TASK_INTERNAL_BASE_PATH).replace(/\/$/, "");
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

    // 服务身份先于任何解析：浏览器/loopback 不授权。
    const versionHeader = headerValue(req.headers["x-woohaa3-protocol-version"]);
    const versionCheck = checkProtocolVersion(versionHeader === undefined ? undefined : Number(versionHeader));
    if (!versionCheck.ok) {
      sendError(res, 409, "protocol-incompatible", versionCheck.message);
      return true;
    }
    const token = headerValue(req.headers["x-woohaa3-service-token"]);
    if (!deps.serviceToken || token !== deps.serviceToken) {
      log({ event: "task-plugin-task-unauthorized", status: 401 });
      sendError(res, 401, "unauthorized", "缺少或无效的服务身份");
      return true;
    }

    const suffix = pathname.slice(basePath.length + 1);
    const match = /^([^/]+)\/tasks\/([^/]+)(\/(cancel|result))?$/.exec(suffix);
    if (!match) {
      sendError(res, 404, "unsupported", "未知的内部插件任务路由");
      return true;
    }
    const extensionId = decodeURIComponent(match[1]!);
    const workerTaskKey = decodeURIComponent(match[2]!);
    const isCancel = match[3] === "/cancel";
    if(match[3] === "/result" && req.method === "GET") {
      const association=deps.associations.find(workerTaskKey);
      if(!association || association.extensionId!==extensionId){sendError(res,404,"task-not-found","任务不属于该插件");return true;}
      const detail=deps.history.get(workerTaskKey,{fullText:true});
      if(!detail){sendError(res,404,"task-not-found","任务不存在");return true;}
      const result=detail.result ? {...detail.result,textTruncated:false} : undefined;
      sendJson(res,200,{workerTaskKey,state:detail.state,...(result?{result}: {}),...(detail.error?{error:detail.error}: {})});return true;
    }

    if (isCancel && req.method === "POST") return handleCancel(res, extensionId, workerTaskKey, deps, log);
    if (!isCancel && req.method === "PUT") return handleSubmit(req, res, extensionId, workerTaskKey, deps, log);
    if (!isCancel && req.method === "GET") return handleStatus(res, extensionId, workerTaskKey, deps, log);
    sendError(res, 405, "unsupported", "方法不允许");
    return true;
  };
}

async function handleSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  extensionId: string,
  workerTaskKey: string,
  deps: TaskExtensionTaskApiDependencies,
  log: NonNullable<TaskExtensionTaskApiDependencies["logger"]>
): Promise<boolean> {
  const body = await readJson(req);
  if (body === null) {
    sendError(res, 400, "malformed-request", "请求体不是合法 JSON");
    return true;
  }
  const record = body as Record<string, unknown>;
  // path extensionId 是权威：body 中同名 extensionId 必须一致。
  if (record.extensionId !== undefined && record.extensionId !== extensionId) {
    sendError(res, 400, "malformed-request", "extensionId 与路径不一致");
    return true;
  }
  if (typeof record.configVersion !== "number" || !Number.isInteger(record.configVersion) || record.configVersion < 0) {
    sendError(res, 400, "malformed-request", "configVersion 必须是非负整数");
    return true;
  }
  // 插件任务是非画布任务：拒绝任何画布节点关联字段（防止绕过 Canvas run/cancel）。
  if (record.canvasId !== undefined || record.nodeId !== undefined || record.runId !== undefined) {
    sendError(res, 400, "unsupported", "插件不能提交画布节点任务；请通过 Canvas 语义接口");
    return true;
  }

  const decoded = decodeTaskSubmitRequest({
    ...record,
    workerTaskKey,
    // 非画布插件任务使用合成的稳定关联；Task 不把它当画布权威。
    canvasId: "plugin",
    nodeId: extensionId,
    runId: workerTaskKey,
    jobId: workerTaskKey,
    nodeType: record.nodeType ?? defaultNodeTypeForModelType(record.modelType),
    parameters: record.parameters ?? {}
  });
  if (!decoded.ok) {
    sendError(res, 400, "malformed-request", decoded.message);
    return true;
  }
  let request = decoded.value;

  const catalog = await deps.resolveCatalog();
  if (!catalog.available) {
    sendError(res, 503, "unavailable", catalog.reason ?? "任务目录不可用");
    return true;
  }
  const model = catalog.models.find((entry) => entry.modelKey === request.modelKey && entry.modelType === request.modelType);
  if (!model) {
    sendError(res, 400, "unsupported", `模型 ${request.modelKey} 不在启用集合内`);
    return true;
  }
  const capability = checkModelCapability(request, model);
  if (!capability.ok) {
    sendError(res, 400, capability.code, capability.message);
    return true;
  }
  // 模型参数 schema 与默认值（change: 2026-11-06-guard-video-generation-inputs）。
  const guarded = resolveModelParameters(
    { modelType: model.modelType, inputSchema: model.inputSchema, defaultInput: model.defaultInput },
    request.parameters,
    { prompt: request.prompt }
  );
  if (guarded.issues.length > 0) {
    const issue = guarded.issues[0]!;
    sendError(res, 400, issue.kind === "missing" ? "missing-parameter" : "invalid-parameter", issue.message);
    return true;
  }
  request = { ...request, parameters: guarded.parameters };
  if (containsWoohaa3CanvasMentionToken(request.prompt)) {
    sendError(res, 400, "malformed-request", "任务 prompt 含未编译的内部 mention token");
    return true;
  }
  if (request.inputs.length > 0) {
    if (!deps.mediaClient) {
      sendError(res, 503, "unavailable", "任务需要媒体校验能力，但 Media Service 未配置");
      return true;
    }
    for (const input of request.inputs) {
      let verified;
      try {
        verified = await deps.mediaClient.verify(input.storageKey);
      } catch (error) {
        log({ event: "task-plugin-task", status: 502, code: "media-unavailable", storageKeyHash: hashStorageKeyForLog(input.storageKey) });
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
    outcome = await deps.submit(request, { extensionId, configVersion: record.configVersion });
  } catch {
    sendError(res, 500, "storage-failed", "插件任务提交失败");
    return true;
  }
  if (outcome.conflict) {
    sendError(res, 409, "key-reused", "相同 workerTaskKey 使用了不同 payload");
    return true;
  }
  if (outcome.parameterError) {
    sendError(res, 400, outcome.parameterError.code, outcome.parameterError.message);
    return true;
  }
  if (outcome.mediaError) {
    sendError(res, 502, "unavailable", outcome.mediaError);
    return true;
  }
  // 持久化插件关联（恢复/查询依据）。
  deps.associations.upsert({
    workerTaskKey,
    extensionId,
    configVersion: record.configVersion,
    modelType: request.modelType,
    canvasId: null,
    createdAt: new Date().toISOString()
  });
  const response: TaskSubmitResponse = {
    workerTaskKey,
    state: outcome.state as TaskSubmitResponse["state"],
    reused: outcome.reused,
    canvasId: request.canvasId,
    nodeId: request.nodeId,
    runId: request.runId
  };
  log({ event: "task-plugin-task-submit", status: 202, workerTaskKey });
  sendJson(res, 202, response);
  return true;
}

async function handleStatus(
  res: ServerResponse,
  extensionId: string,
  workerTaskKey: string,
  deps: TaskExtensionTaskApiDependencies,
  log: NonNullable<TaskExtensionTaskApiDependencies["logger"]>
): Promise<boolean> {
  const association = deps.associations.find(workerTaskKey);
  if (!association || association.extensionId !== extensionId) {
    sendError(res, 404, "task-not-found", "任务不存在或不属于该插件");
    return true;
  }
  const detail = await deps.status(workerTaskKey);
  if (!detail) {
    sendError(res, 404, "task-not-found", "任务不存在");
    return true;
  }
  log({ event: "task-plugin-task-status", status: 200, workerTaskKey });
  sendJson(res, 200, detail);
  return true;
}

async function handleCancel(
  res: ServerResponse,
  extensionId: string,
  workerTaskKey: string,
  deps: TaskExtensionTaskApiDependencies,
  log: NonNullable<TaskExtensionTaskApiDependencies["logger"]>
): Promise<boolean> {
  const association = deps.associations.find(workerTaskKey);
  if (!association || association.extensionId !== extensionId) {
    sendError(res, 404, "task-not-found", "任务不存在或不属于该插件");
    return true;
  }
  const state = await deps.cancel(workerTaskKey);
  if (state === null) {
    sendError(res, 404, "task-not-found", "任务不存在");
    return true;
  }
  log({ event: "task-plugin-task-cancel", status: 200, workerTaskKey });
  sendJson(res, 200, { workerTaskKey, state });
  return true;
}

/** 非画布插件任务的默认节点类型（必须与 modelType 匹配）。 */
function defaultNodeTypeForModelType(modelType: unknown): string {
  switch (modelType) {
    case "language":
      return "text";
    case "video":
      return "video";
    case "audio":
      return "audio";
    default:
      return "image";
  }
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
      if (text === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

export { inferMediaKindFromType };
