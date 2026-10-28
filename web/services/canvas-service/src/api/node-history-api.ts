/**
 * 节点生成历史 HTTP API
 * （change: add-canvas-node-generation-history，任务 1.3 / 1.4 / design D3）。
 *
 * 画布授权的版本化历史面：
 * ```
 * GET  /api/canvas-node-history/:canvasId/:nodeId            列表（cursor 分页）
 * POST /api/canvas-node-history/:canvasId/:nodeId/clear      清空该节点历史（显式写操作）
 * POST /api/canvas-node-history/:canvasId/:targetNodeId/merge  同类型节点合并（来源并入目标）
 * GET  /api/canvas-node-history/:canvasId/:nodeId/:entryId   详情（完整正文/脚本）
 * POST /api/canvas-node-history/:canvasId/:nodeId/:entryId/apply   原子恢复
 * GET  /api/canvas-node-history/:canvasId/:nodeId/:entryId/preview  受控媒体预览（同源重定向）
 * GET  /api/canvas-node-history/:canvasId/:nodeId/:entryId/poster   视频海报预览
 * GET  /api/canvas-node-history/:canvasId/:nodeId/:entryId/thumbnail 模型缩略图（受控派生 PNG）
 * ```
 *
 * 授权：所有路由在读取 repository **之前**校验调用方对目标画布的访问资格（服务令牌或
 * 本机），再校验 canvas/node/entry 归属；越权枚举返回稳定 not-found，绝不泄露种类、
 * 时间、source hash、storageKey 或正文。列表只返回安全 metadata 与受控预览引用。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeHistoryApplicationService } from "../storage/core/node-history-service.js";
import { CanvasStorageError, canvasStorageErrorCode, isCanvasStorageError } from "../storage/core/errors.js";
import { isNodeGenerationKind, type NodeHistoryMediaPayload } from "@woohaa3/contracts";

export const DEFAULT_NODE_HISTORY_API_BASE_PATH = "/api/canvas-node-history";

/** 合并请求体上限（只含节点 id 与期望身份，无正文）。 */
const MAX_MERGE_BODY_BYTES = 16 * 1024;

/**
 * 清空某节点历史的动作段。
 *
 * `POST /api/canvas-node-history/:canvasId/:nodeId/clear`。只有三个路径段，不会与
 * `:entryId` 详情路由（两段/四段）冲突，也不需要额外的占位 entry。
 */
export const CLEAR_ACTION = "clear";

/**
 * 同类型节点合并的动作段
 * （change: 2026-10-27-merge-same-type-node-history，任务 3.4）。
 *
 * `POST /api/canvas-node-history/:canvasId/:targetNodeId/merge`，body 携带来源节点与
 * 操作身份。与 `clear` 一样是**写操作**，先过 `authorizeWrite` 再读取任何状态。
 */
export const MERGE_ACTION = "merge";

/** 同源受控媒体路径前缀（由 ingress 路由到 Media Service）。 */
export const CANVAS_NODE_HISTORY_MEDIA_BASE = "/api/media";

/** 预览 302 从 `.../:canvas/:node/:entry/:action` 上跳四级到挂载的 `/api/`。 */
const NODE_HISTORY_PREVIEW_UP_TO_API = "../../../../";

export type NodeHistoryThumbnailPort = {
  /** 为历史模型条目生成/复用缓存缩略图 PNG；失败返回稳定 code。 */
  render(input: { canvasId: string; nodeId: string; entryId: string }): Promise<
    { ok: true; png: Buffer; cached: boolean } | { ok: false; code: string; message: string }
  >;
};

export type NodeHistoryRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type NodeHistoryRequestHandlerOptions = {
  service: NodeHistoryApplicationService;
  /** 受信任代理服务令牌；未配置时只允许本机访问。 */
  serviceToken?: string;
  basePath?: string;
  /** 目标画布是否可读（存在性 + ACL 钩子）。缺省认为存在。 */
  canvasExists?: (canvasId: string, req?: IncomingMessage) => Promise<boolean>;
  /**
   * 写操作（清空历史）的额外授权。注入后按可信 principal 判定 write；缺省沿用
   * 服务令牌/本机访问（独立单元历史行为）。
   */
  authorizeWrite?: (input: { canvasId: string; req: IncomingMessage }) => Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }>;
  /** 模型缩略图作业；缺省时缩略图路由返回 renderer-unavailable。 */
  thumbnail?: NodeHistoryThumbnailPort | null;
  logger?: (event: { event: string; status: number; code?: string }) => void;
};

export function createNodeHistoryRequestHandler(options: NodeHistoryRequestHandlerOptions): NodeHistoryRequestHandler {
  const basePath = (options.basePath ?? DEFAULT_NODE_HISTORY_API_BASE_PATH).replace(/\/$/, "");
  const log: NonNullable<NodeHistoryRequestHandlerOptions["logger"]> = options.logger ?? (() => undefined);

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendError(res, 400, "NODE_HISTORY_INVALID", "请求 URL 非法");
      return true;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;

    if (!authorize(req, options.serviceToken)) {
      log({ event: "node-history-unauthorized", status: 401 });
      sendError(res, 401, "NODE_HISTORY_NOT_FOUND", "需要受信任身份或本机访问");
      return true;
    }

    const suffix = pathname === basePath ? "" : pathname.slice(basePath.length + 1);
    const segments = suffix === "" ? [] : suffix.split("/").map(decodeSegment);

    try {
      if (segments.length < 1) {
        sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "未知的节点历史路由");
        return true;
      }

      // 画布级历史（change: add-canvas-generation-history-dialog）：单段 canvasId。
      if (segments.length === 1) {
        const canvasId = segments[0];
        if (!canvasId) {
          sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "未知的节点历史路由");
          return true;
        }
        if (req.method !== "GET") {
          sendError(res, 405, "NODE_HISTORY_INVALID", "方法不允许");
          return true;
        }
        // 归属校验前置：画布不存在或无权读取时立即返回稳定 not-found。
        if (options.canvasExists && !(await options.canvasExists(canvasId, req))) {
          sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "历史条目不存在");
          return true;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const limit = readInt(url.searchParams.get("limit"));
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const kindRaw = url.searchParams.get("kind");
        const kind = isNodeGenerationKind(kindRaw) ? kindRaw : undefined;
        const page = await options.service.listCanvas({
          canvasId,
          summary: url.searchParams.get("summary") === "true",
          summaryNodeId: url.searchParams.get("summaryNodeId") ?? undefined,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          ...(kind ? { kind } : {})
        });
        sendJson(res, 200, page);
        return true;
      }

      const [canvasId, nodeId, entryId, action] = segments;
      if (!canvasId || !nodeId) {
        sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "未知的节点历史路由");
        return true;
      }

      // 清空某节点历史（写操作）：入口在最前，避免与 entry 路由歧义。
      if (segments.length === 3 && entryId === CLEAR_ACTION) {
        if (req.method !== "POST" && req.method !== "DELETE") {
          sendError(res, 405, "NODE_HISTORY_INVALID", "方法不允许");
          return true;
        }
        if (options.authorizeWrite) {
          const decision = await options.authorizeWrite({ canvasId, req });
          if (!decision.ok) {
            log({ event: "node-history-clear-denied", status: decision.status, code: decision.code });
            sendError(res, decision.status, decision.code, decision.message);
            return true;
          }
        }
        if (options.canvasExists && !(await options.canvasExists(canvasId, req))) {
          sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "历史条目不存在");
          return true;
        }
        const cleared = await options.service.clearNodeHistory({ canvasId, nodeId });
        if (!cleared.ok) {
          const status = cleared.code === "conflict" ? 409
            : cleared.code === "malformed-request" ? 400
            : cleared.code === "invalid-node-type" ? 400
            : cleared.code === "unknown-node" || cleared.code === "canvas-not-found" ? 404
            : 503;
          sendError(res, status, clearErrorCode(cleared.code), cleared.message);
          return true;
        }
        sendJson(res, 200, { ok: true, removed: cleared.removed });
        return true;
      }

      // 同类型节点合并（写操作）：与 clear 同一动作段位，先过写权限再读任何状态。
      if (segments.length === 3 && entryId === MERGE_ACTION) {
        if (req.method !== "POST") {
          sendError(res, 405, "NODE_HISTORY_INVALID", "方法不允许");
          return true;
        }
        if (options.authorizeWrite) {
          const decision = await options.authorizeWrite({ canvasId, req });
          if (!decision.ok) {
            log({ event: "node-history-merge-denied", status: decision.status, code: decision.code });
            sendError(res, decision.status, decision.code, decision.message);
            return true;
          }
        }
        if (options.canvasExists && !(await options.canvasExists(canvasId, req))) {
          sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "历史条目不存在");
          return true;
        }
        return await handleMerge(res, options, canvasId, nodeId, req);
      }

      // 归属校验前置：画布不存在或无权读取时立即返回稳定 not-found。
      if (options.canvasExists && !(await options.canvasExists(canvasId, req))) {
        sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "历史条目不存在");
        return true;
      }

      if (segments.length === 2) {
        if (req.method !== "GET") {
          sendError(res, 405, "NODE_HISTORY_INVALID", "方法不允许");
          return true;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const limit = readInt(url.searchParams.get("limit"));
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const page = await options.service.list({
          canvasId,
          nodeId,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {})
        });
        sendJson(res, 200, page);
        return true;
      }

      if (!entryId) {
        sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "未知的节点历史路由");
        return true;
      }

      if (segments.length === 3) {
        if (req.method !== "GET") {
          sendError(res, 405, "NODE_HISTORY_INVALID", "方法不允许");
          return true;
        }
        const detail = await options.service.getDetail({ canvasId, nodeId, entryId });
        sendJson(res, 200, { entry: detail });
        return true;
      }

      if (segments.length === 4) {
        switch (action) {
          case "apply":
            if (req.method !== "POST") {
              sendError(res, 405, "NODE_HISTORY_INVALID", "方法不允许");
              return true;
            }
            return await handleApply(res, options, canvasId, nodeId, entryId);
          case "preview":
          case "poster":
            return await handleMediaPreview(res, options, canvasId, nodeId, entryId, action);
          case "thumbnail":
            return await handleThumbnail(res, options, canvasId, nodeId, entryId);
          default:
            sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "未知的节点历史路由");
            return true;
        }
      }

      sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "未知的节点历史路由");
      return true;
    } catch (error) {
      respondError(res, error, log);
      return true;
    }
  };
}

/**
 * 合并请求处理：严格校验 body 形状，再交给应用服务。
 *
 * body 只允许 `sourceNodeId` / `operationId` / 可选期望身份；缺字段或非对象返回 400，
 * 不执行任何历史或画布写入。
 */
async function handleMerge(
  res: ServerResponse,
  options: NodeHistoryRequestHandlerOptions,
  canvasId: string,
  targetNodeId: string,
  req: IncomingMessage
): Promise<boolean> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    sendError(res, 400, "NODE_HISTORY_INVALID", error instanceof Error ? error.message : "请求体非法");
    return true;
  }
  const input = decodeMergeBody(body);
  if (!input.ok) {
    sendError(res, 400, "NODE_HISTORY_INVALID", input.message);
    return true;
  }
  const outcome = await options.service.mergeNodeHistory({
    canvasId,
    targetNodeId,
    sourceNodeId: input.value.sourceNodeId,
    operationId: input.value.operationId,
    ...(input.value.expectedSourceCurrentIdentity !== undefined
      ? { expectedSourceCurrentIdentity: input.value.expectedSourceCurrentIdentity }
      : {}),
    ...(input.value.expectedTargetCurrentIdentity !== undefined
      ? { expectedTargetCurrentIdentity: input.value.expectedTargetCurrentIdentity }
      : {})
  });
  if (!outcome.ok) {
    const mapped = mergeErrorResponse(outcome.code);
    sendError(res, mapped.status, mapped.code, outcome.message);
    return true;
  }
  sendJson(res, 200, {
    ok: true,
    targetNodeId: outcome.targetNodeId,
    sourceNodeId: outcome.sourceNodeId,
    revision: outcome.revision,
    copied: outcome.copied,
    duplicates: outcome.duplicates,
    evicted: outcome.evicted,
    alreadyMerged: outcome.alreadyMerged
  });
  return true;
}

function decodeMergeBody(body: unknown):
  | { ok: true; value: { sourceNodeId: string; operationId: string; expectedSourceCurrentIdentity?: string; expectedTargetCurrentIdentity?: string } }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "请求体必须是对象" };
  }
  const record = body as Record<string, unknown>;
  const sourceNodeId = typeof record.sourceNodeId === "string" ? record.sourceNodeId.trim() : "";
  const operationId = typeof record.operationId === "string" ? record.operationId.trim() : "";
  if (sourceNodeId === "") return { ok: false, message: "sourceNodeId 不能为空" };
  if (operationId === "") return { ok: false, message: "operationId 不能为空" };
  const expectedSourceCurrentIdentity = optionalString(record.expectedSourceCurrentIdentity);
  const expectedTargetCurrentIdentity = optionalString(record.expectedTargetCurrentIdentity);
  if (expectedSourceCurrentIdentity === false || expectedTargetCurrentIdentity === false) {
    return { ok: false, message: "expectedCurrentIdentity 必须是非空字符串" };
  }
  return {
    ok: true,
    value: {
      sourceNodeId,
      operationId,
      ...(expectedSourceCurrentIdentity !== undefined ? { expectedSourceCurrentIdentity } : {}),
      ...(expectedTargetCurrentIdentity !== undefined ? { expectedTargetCurrentIdentity } : {})
    }
  };
}

/** `undefined` 表示未提供；`false` 表示提供了非法值。 */
function optionalString(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") return false;
  return value.trim();
}

/** 合并领域 code → 稳定 HTTP 状态与错误码（design D8）。 */
function mergeErrorResponse(code: string): { status: number; code: string } {
  switch (code) {
    case "unknown-node":
    case "canvas-not-found":
      return { status: 404, code: "NODE_HISTORY_NOT_FOUND" };
    case "invalid-node-type":
    case "malformed-request":
      return { status: 400, code: "NODE_HISTORY_INVALID" };
    case "conflict":
      return { status: 409, code: "NODE_HISTORY_CONFLICT" };
    case "unrecoverable":
    case "no-current-version":
      return { status: 409, code: "NODE_HISTORY_UNRECOVERABLE" };
    default:
      return { status: 503, code: "NODE_HISTORY_MERGE_FAILED" };
  }
}

async function handleApply(
  res: ServerResponse,
  options: NodeHistoryRequestHandlerOptions,
  canvasId: string,
  nodeId: string,
  entryId: string
): Promise<boolean> {
  const outcome = await options.service.restore({ canvasId, nodeId, entryId });
  if (!outcome.ok) {
    const status = outcome.code === "not-found" ? 404
      : outcome.code === "canvas-not-found" ? 404
      : outcome.code === "conflict" ? 409
      : outcome.code === "unrecoverable" ? 409
      : outcome.code === "invalid-node-type" ? 400
      : 503;
    sendError(res, status, outcome.code, outcome.message);
    return true;
  }
  sendJson(res, 200, { ok: true, entryId: outcome.entryId, revision: outcome.revision, alreadyCurrent: outcome.alreadyCurrent });
  return true;
}

/** 受控媒体预览：校验归属后重定向到同源受控媒体路径（不暴露签名 URL）。 */
async function handleMediaPreview(
  res: ServerResponse,
  options: NodeHistoryRequestHandlerOptions,
  canvasId: string,
  nodeId: string,
  entryId: string,
  action: "preview" | "poster"
): Promise<boolean> {
  const entry = await options.service.getEntry({ canvasId, nodeId, entryId });
  if (entry.kind !== "image" && entry.kind !== "video" && entry.kind !== "audio") {
    sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "历史条目不存在");
    return true;
  }
  const payload = entry.payload as NodeHistoryMediaPayload;
  const storageKey = action === "poster" ? payload.poster?.storageKey : payload.storageKey;
  if (!storageKey) {
    sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "历史条目不存在");
    return true;
  }
  res.statusCode = 302;
  // 必须用**相对** Location：本服务只看到逻辑路径，公开挂载前缀（例如 `/dev/<token>/`）
  // 已在后端挂载边界剥离，写成 `/api/media/...` 会让浏览器跳到根路径并 404。
  // 当前路由固定为 `.../<canvas>/<node>/<entry>/preview|poster`，上跳四级即回到挂载的
  // `/api/`，再拼 `media/<key>` 自动保留任意前缀（根挂载时结果仍是 `/api/media/<key>`）。
  const mediaPath = storageKey.split("/").map(encodeURIComponent).join("/");
  // 带上画布提示：媒体读取要按画布路由（同步到远端的画布，字节在服务端托管存储里）。
  // 只在 Location 上追加 query；302 的相对路径语义不变（浏览器解析时会保留 query）。
  const canvasHint = `?canvas=${encodeURIComponent(canvasId)}`;
  res.setHeader("Location", `${NODE_HISTORY_PREVIEW_UP_TO_API}${CANVAS_NODE_HISTORY_MEDIA_BASE.replace(/^\/api\//, "")}/${mediaPath}${canvasHint}`);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.end();
  return true;
}

async function handleThumbnail(
  res: ServerResponse,
  options: NodeHistoryRequestHandlerOptions,
  canvasId: string,
  nodeId: string,
  entryId: string
): Promise<boolean> {
  const entry = await options.service.getEntry({ canvasId, nodeId, entryId });
  if (entry.kind !== "model") {
    sendError(res, 404, "NODE_HISTORY_NOT_FOUND", "历史条目不存在");
    return true;
  }
  if (!options.thumbnail) {
    sendError(res, 503, "renderer-unavailable", "未配置模型缩略图作业");
    return true;
  }
  const rendered = await options.thumbnail.render({ canvasId, nodeId, entryId });
  if (!rendered.ok) {
    sendError(res, ["renderer-unavailable", "renderer-start-failed", "composite-history-unavailable"].includes(rendered.code) ? 503 : 422, rendered.code, rendered.message);
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", String(rendered.png.byteLength));
  res.setHeader("Cache-Control", "private, max-age=300");
  res.end(rendered.png);
  return true;
}

function authorize(req: IncomingMessage, serviceToken: string | undefined): boolean {
  if (serviceToken) {
    const header = req.headers["x-woohaa3-service-token"];
    const value = Array.isArray(header) ? header[0] : header;
    return value === serviceToken;
  }
  return isLoopbackRequest(req);
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? "";
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

function respondError(res: ServerResponse, error: unknown, log: NonNullable<NodeHistoryRequestHandlerOptions["logger"]>): void {
  const code = canvasStorageErrorCode(error);
  if (code) {
    const status = statusForCode(code);
    log({ event: "node-history-error", status, code });
    sendError(res, status, code, isCanvasStorageError(error) ? error.message : "请求失败");
    return;
  }
  log({ event: "node-history-error", status: 500, code: "REPOSITORY_FAILURE" });
  sendError(res, 500, "REPOSITORY_FAILURE", "服务内部错误");
}

function statusForCode(code: string): number {
  switch (code) {
    case "NODE_HISTORY_NOT_FOUND":
      return 404;
    case "NODE_HISTORY_CONFLICT":
    case "NODE_HISTORY_UNRECOVERABLE":
      return 409;
    case "NODE_HISTORY_LIMIT_EXCEEDED":
      return 413;
    case "NODE_HISTORY_INVALID":
    case "LIMIT_EXCEEDED":
      return 400;
    case "NODE_HISTORY_MERGE_FAILED":
    case "NOT_READY":
    case "SCHEMA_VERSION_UNSUPPORTED":
      return 503;
    default:
      return 500;
  }
}

/** 清空失败的领域 code → 稳定 HTTP 错误码（不泄露内部仓储细节）。 */
function clearErrorCode(code: string): string {
  switch (code) {
    case "conflict": return "NODE_HISTORY_CONFLICT";
    case "unknown-node":
    case "canvas-not-found": return "NODE_HISTORY_NOT_FOUND";
    case "invalid-node-type":
    case "malformed-request": return "NODE_HISTORY_INVALID";
    default: return "NODE_HISTORY_INVALID";
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_MERGE_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function readInt(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { code, message });
}

export { CanvasStorageError };
