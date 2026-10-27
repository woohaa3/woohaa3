/**
 * Agent Canvas 内部协议 v2 HTTP 面
 * （change: add-agent-canvas-authoring-mcp，任务 1.5 / 2.2 / 3.5）。
 *
 * 供独立运行单元 `mcp-service` 调用的受认证内部能力面：canvas list、published graph、
 * 有界增量与计划提交。安全边界：
 * - 必须携带受支持的内部协议版本头（v2），否则副作用前返回 protocol-incompatible；
 * - 必须通过服务身份令牌（未配置令牌时只允许 loopback）；
 * - delegated principal 只从**受信任请求头**（ingress 注入）或 loopback 开发默认读取，
 *   **绝不**从请求体读取（design D11）。
 *
 * 路径位于 `/internal/v2/*`，公网 ingress 一律拒绝。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeAgentApplyRequest,
  decodeAgentChangesRequest,
  decodeAgentGraphRequest,
  decodeAgentListRequest,
  decodeAgentRunRequest,
  decodeAgentRunStatusRequest,
  decodeAgentRunCancelRequest,
  decodeAgentOutputRequest,
  AGENT_INTERNAL_BASE_PATH,
  AGENT_INTERNAL_PATHS,
  AGENT_INTERNAL_PROTOCOL_HEADER,
  AGENT_INTERNAL_PROTOCOL_VERSION,
  MCP_INTERNAL_MAX_BODY_BYTES
} from "@woohaa3/contracts";
import type { AgentCanvasInternalService } from "./internal-service.js";
import type { AgentRunAdapter } from "./run-adapter.js";

/** ingress/认证中间件注入 delegated principal 的受信任请求头。 */
export const AGENT_PRINCIPAL_HEADER = "x-woohaa3-agent-principal" as const;

export type AgentInternalHandlerOptions = {
  service?: AgentCanvasInternalService;
  /** Agent run 能力面；省略时 run 路由返回 503。 */
  runAdapter?: AgentRunAdapter;
  /** 服务身份令牌；未配置时只允许 loopback。 */
  serviceToken?: string;
  /** loopback 开发模式使用的显式 principal；未配置时匿名请求拒绝。 */
  developmentPrincipalId?: string;
  maxBodyBytes?: number;
  logger?: (event: { event: string; status: number; code?: string }) => void;
};

export type AgentInternalHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createAgentInternalHandler(options: AgentInternalHandlerOptions): AgentInternalHandler {
  const maxBodyBytes = options.maxBodyBytes ?? MCP_INTERNAL_MAX_BODY_BYTES;
  const log = options.logger ?? (() => undefined);

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith(`${AGENT_INTERNAL_BASE_PATH}/`) && pathname !== AGENT_INTERNAL_BASE_PATH) return false;
    if (
      pathname !== AGENT_INTERNAL_PATHS.list
      && pathname !== AGENT_INTERNAL_PATHS.graph
      && pathname !== AGENT_INTERNAL_PATHS.changes
      && pathname !== AGENT_INTERNAL_PATHS.apply
      && pathname !== AGENT_INTERNAL_PATHS.run
      && pathname !== AGENT_INTERNAL_PATHS.runStatus
      && pathname !== AGENT_INTERNAL_PATHS.runCancel
      && pathname !== AGENT_INTERNAL_PATHS.output
    ) {
      sendJson(res, 404, { error: "not-found" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }

    const tokenError = checkServiceToken(req, options.serviceToken);
    if (tokenError) {
      log({ event: "agent-internal-token-rejected", status: 401 });
      sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
      return true;
    }
    const declared = readHeader(req, AGENT_INTERNAL_PROTOCOL_HEADER);
    if (Number(declared) !== AGENT_INTERNAL_PROTOCOL_VERSION) {
      log({ event: "agent-internal-protocol-rejected", status: 409 });
      sendJson(res, 409, {
        error: "protocol-incompatible",
        code: "protocol-incompatible",
        protocolVersion: AGENT_INTERNAL_PROTOCOL_VERSION
      });
      return true;
    }

    // delegated principal 由受信任上下文产生：优先认证头，其次 loopback 开发默认。
    const principalId = resolvePrincipal(req, options.developmentPrincipalId, options.serviceToken !== undefined);
    if (!principalId) {
      log({ event: "agent-internal-principal-missing", status: 401 });
      sendJson(res, 401, { error: "缺少已认证 principal", code: "unauthorized" });
      return true;
    }

    const body = await readJson(req, maxBodyBytes).catch(() => null);
    if (body === null) {
      sendJson(res, 400, { error: "malformed-request", code: "malformed-request" });
      return true;
    }

    if (!options.service) {
      sendJson(res, 503, { error: "Agent 画布能力当前不可用", code: "unavailable" });
      return true;
    }

    if (pathname === AGENT_INTERNAL_PATHS.list) {
      const decoded = decodeAgentListRequest(body, principalId);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      const page = await options.service.listCanvases({
        principalId,
        ...(decoded.value.cursor !== undefined ? { cursor: decoded.value.cursor } : {}),
        ...(decoded.value.limit !== undefined ? { limit: decoded.value.limit } : {})
      });
      sendJson(res, 200, { ok: true, protocolVersion: AGENT_INTERNAL_PROTOCOL_VERSION, ...page });
      return true;
    }

    if (pathname === AGENT_INTERNAL_PATHS.graph) {
      const decoded = decodeAgentGraphRequest(body, principalId);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      const outcome = await options.service.readGraph(decoded.value);
      if (outcome.ok) {
        sendJson(res, 200, { ...outcome.graph, ok: true, protocolVersion: AGENT_INTERNAL_PROTOCOL_VERSION });
        return true;
      }
      return sendOutcome(res, outcome, log);
    }

    if (pathname === AGENT_INTERNAL_PATHS.changes) {
      const decoded = decodeAgentChangesRequest(body, principalId);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      const outcome = await options.service.readChanges(decoded.value);
      if (outcome.ok) {
        sendJson(res, 200, { ...outcome.delta, ok: true, protocolVersion: AGENT_INTERNAL_PROTOCOL_VERSION });
        return true;
      }
      return sendOutcome(res, outcome, log);
    }

    // apply
    if (pathname === AGENT_INTERNAL_PATHS.apply) {
      const decoded = decodeAgentApplyRequest(body, principalId);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      const outcome = await options.service.apply(decoded.value);
      return sendOutcome(res, outcome, log);
    }

    // run / status / cancel / output（任务 6.1–6.5）
    if (!options.runAdapter) {
      sendJson(res, 503, { error: "节点执行当前不可用", code: "run-unavailable" });
      return true;
    }

    if (pathname === AGENT_INTERNAL_PATHS.run) {
      const decoded = decodeAgentRunRequest(body, principalId);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      const authorized = await authorizeRun(options.service, principalId, decoded.value.canvasId, "write");
      if (!authorized.ok) return sendOutcome(res, authorized, log);
      const outcome = await options.runAdapter.run({ ...decoded.value, canvasId: authorized.canvasId, owner: principalId });
      return sendOutcome(res, outcome, log);
    }

    if (pathname === AGENT_INTERNAL_PATHS.runStatus) {
      const decoded = decodeAgentRunStatusRequest(body, principalId);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      const authorized = await authorizeRun(options.service, principalId, decoded.value.canvasId, "read");
      if (!authorized.ok) return sendOutcome(res, authorized, log);
      const outcome = await options.runAdapter.status({ ...decoded.value, canvasId: authorized.canvasId, owner: principalId });
      return sendOutcome(res, outcome, log);
    }

    if (pathname === AGENT_INTERNAL_PATHS.runCancel) {
      const decoded = decodeAgentRunCancelRequest(body, principalId);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      const authorized = await authorizeRun(options.service, principalId, decoded.value.canvasId, "write");
      if (!authorized.ok) return sendOutcome(res, authorized, log);
      const outcome = await options.runAdapter.cancel({ ...decoded.value, canvasId: authorized.canvasId, owner: principalId });
      return sendOutcome(res, outcome, log);
    }

    // output
    const decodedOutput = decodeAgentOutputRequest(body, principalId);
    if (!decodedOutput.ok) return badRequest(res, decodedOutput.code, decodedOutput.message);
    const authorizedOutput = await authorizeRun(options.service, principalId, decodedOutput.value.canvasId, "read");
    if (!authorizedOutput.ok) return sendOutcome(res, authorizedOutput, log);
    const outputOutcome = await options.runAdapter.output({ ...decodedOutput.value, canvasId: authorizedOutput.canvasId });
    return sendOutcome(res, outputOutcome, log);
  };
}

/**
 * run 系列路由的授权与 canvasId 解析复用 AgentCanvasInternalService 的同一判定。
 * 返回解析后的 canvasId（默认画布回退由 service 决定）。
 */
async function authorizeRun(
  service: AgentCanvasInternalService | undefined,
  principalId: string,
  canvasId: string | undefined,
  permission: "read" | "write"
): Promise<{ ok: true; canvasId: string } | { ok: false; code: string; message: string }> {
  if (!service) return { ok: false, code: "unavailable", message: "Agent 画布能力当前不可用" };
  return service.authorizeCanvas({ principalId, canvasId, permission });
}

function resolvePrincipal(
  req: IncomingMessage,
  developmentPrincipalId: string | undefined,
  tokenConfigured: boolean
): string | null {
  const header = readHeader(req, AGENT_PRINCIPAL_HEADER);
  if (header && header.trim() !== "") return header.trim();
  // 未配置令牌（loopback 开发）时允许显式 development principal；生产必须由 ingress 注入。
  if (!tokenConfigured && developmentPrincipalId) return developmentPrincipalId;
  return null;
}

function sendOutcome(
  res: ServerResponse,
  outcome: { ok: boolean } & Record<string, unknown>,
  log: (event: { event: string; status: number; code?: string }) => void
): true {
  if (outcome.ok) {
    sendJson(res, 200, { protocolVersion: AGENT_INTERNAL_PROTOCOL_VERSION, ...outcome });
    return true;
  }
  const code = typeof outcome.code === "string" ? outcome.code : "unavailable";
  const status = statusForCode(code);
  log({ event: "agent-internal-rejected", status, code });
  sendJson(res, status, { protocolVersion: AGENT_INTERNAL_PROTOCOL_VERSION, ...outcome });
  return true;
}

function statusForCode(code: string): number {
  switch (code) {
    case "forbidden":
      return 403;
    case "unauthorized":
      return 401;
    case "canvas-not-found":
    case "unknown-node":
      return 404;
    case "snapshot-stale":
    case "precondition-failed":
    case "request-id-reused":
    case "storage-seq-conflict":
      return 409;
    case "canvas-unavailable":
    case "storage-failed":
      return 503;
    default:
      return 400;
  }
}

function badRequest(res: ServerResponse, code: string, message: string): true {
  sendJson(res, 400, { error: message, code });
  return true;
}

function checkServiceToken(req: IncomingMessage, expected: string | undefined): string | null {
  if (!expected) {
    return isLoopbackRequest(req) ? null : "缺少服务令牌且请求不是本机";
  }
  return readHeader(req, "x-woohaa3-service-token") === expected ? null : "缺少或无效的服务令牌";
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers[name];
  return Array.isArray(header) ? header[0] : header;
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? "";
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("请求体超过上限");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(Buffer.byteLength(payload)));
  res.end(payload);
}
