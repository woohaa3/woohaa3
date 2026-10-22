/**
 * 模型 MCP HTTP 面（change: integrate-origin-master-after-web-split）。
 *
 * 迁自远端 `web/apps/site/server/model-mcp-http.ts`，但**owner 改为 Canvas Service**：
 * 浏览器同步面使用同源 `/api/model-mcp/*`；外部 MCP 客户端使用 `/mcp/model-canvas`。
 *
 * 路由：
 * ```
 * POST /api/model-mcp/scripts                 提交脚本（权威写入 room；仅接受版本化 JavaScript）
 * POST /api/model-mcp/scripts/report          Frontend 上报运行时应用结果（权威写失败态）
 * ```
 *
 * change: replace-model-mcp-board-with-canvas-subscription —— 移除浏览器登记端点
 * （`/requests`、`GET /scripts`）；模型节点列表由 MCP 的 `list_model_requests` 从权威画布派生。
 *
 * change: 2026-10-07-remove-legacy-node-type-compat —— 移除旧 GDScript 转译
 * （`/scripts/transpile`）与批量迁移（`/scripts/migrate`）端点。
 *
 * change: 2026-10-07-remove-residual-compatibility —— 取消默认画布回退：`canvasId` 必填。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SubmitScriptInput, SubmitScriptOutcome, ReportScriptOutcome } from "./service.js";

export const MODEL_MCP_BASE_PATH = "/api/model-mcp";

/** handler 只依赖这一份能力；`ModelMcpService` 结构上满足它。 */
export type ModelScriptSubmitter = {
  submitScript: (input: SubmitScriptInput) => Promise<SubmitScriptOutcome>;
  /** 上报脚本应用结果；省略时 report 路由返回 503。 */
  reportScript?: (input: {
    canvasId: string;
    nodeId: string;
    status: "ok" | "failed";
    message?: string;
  }) => Promise<ReportScriptOutcome>;
};

/** 请求体上限（脚本可到 200k 字符，留出 JSON 包装余量）。 */
export const MODEL_MCP_MAX_BODY_BYTES = 4 * 1024 * 1024;

export type ModelMcpRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type ModelMcpHandlerOptions = {
  /** 权威脚本提交服务；省略时脚本提交返回 503（请求登记仍可用）。 */
  service?: ModelScriptSubmitter;
  basePath?: string;
  maxBodyBytes?: number;
  logger?: (event: { event: string; status: number; code?: string }) => void;
};

export function createModelMcpHandler(options: ModelMcpHandlerOptions): ModelMcpRequestHandler {
  const basePath = (options.basePath ?? MODEL_MCP_BASE_PATH).replace(/\/$/, "");
  const maxBodyBytes = options.maxBodyBytes ?? MODEL_MCP_MAX_BODY_BYTES;
  const log = options.logger ?? (() => undefined);

  return async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return false;
    }
    if (!url.pathname.startsWith(basePath)) return false;

    const canvasIdFromQuery = url.searchParams.get("canvasId") ?? undefined;

    if (req.method === "POST" && url.pathname === `${basePath}/scripts`) {
      const body = await readJson(req, maxBodyBytes).catch(() => null);
      if (body === null) {
        sendJson(res, 400, { error: "请求体不是合法 JSON" });
        return true;
      }
      const nodeId = readString(body, "nodeId");
      const source = readString(body, "source");
      if (!nodeId || source === undefined) {
        sendJson(res, 400, { error: "需要 nodeId 和 source" });
        return true;
      }
      const canvasId = readString(body, "canvasId") ?? canvasIdFromQuery;
      if (!canvasId) {
        sendJson(res, 400, { error: "需要 canvasId" });
        return true;
      }
      if (!options.service) {
        log({ event: "model-mcp-script-unavailable", status: 503, code: "unavailable" });
        sendJson(res, 503, { error: "model-mcp-unavailable", code: "unavailable" });
        return true;
      }
      const version = readString(body, "version");
      const requestId = readString(body, "requestId") ?? "";
      const expectedModelContentHash = readString(body, "expectedModelContentHash");
      const outcome = await options.service.submitScript({
        canvasId,
        nodeId,
        source,
        requestId,
        ...(version ? { version: version as never } : {}),
        ...(expectedModelContentHash ? { expectedModelContentHash } : {})
      });
      if (!outcome.ok) {
        const status = outcome.code === "canvas-not-found" || outcome.code === "unknown-node" ? 404 : 400;
        log({ event: "model-mcp-script-rejected", status, code: outcome.code });
        sendJson(res, status, { error: outcome.message, code: outcome.code });
        return true;
      }
      sendJson(res, 200, {
        script: {
          canvasId: outcome.canvasId,
          nodeId: outcome.nodeId,
          commandId: outcome.commandId,
          idempotent: outcome.idempotent
        }
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === `${basePath}/scripts/report`) {
      const body = await readJson(req, maxBodyBytes).catch(() => null);
      if (body === null) {
        sendJson(res, 400, { error: "请求体不是合法 JSON" });
        return true;
      }
      const nodeId = readString(body, "nodeId");
      if (!nodeId) {
        sendJson(res, 400, { error: "nodeId 不能为空" });
        return true;
      }
      const canvasId = readString(body, "canvasId") ?? canvasIdFromQuery;
      if (!canvasId) {
        sendJson(res, 400, { error: "需要 canvasId" });
        return true;
      }
      if (!options.service?.reportScript) {
        sendJson(res, 503, { error: "model-mcp-unavailable", code: "unavailable" });
        return true;
      }
      const status = readString(body, "status") === "ok" ? "ok" : "failed";
      const outcome = await options.service.reportScript({
        canvasId,
        nodeId,
        status,
        message: readString(body, "message")
      });
      if (!outcome.ok) {
        const httpStatus = outcome.code === "canvas-not-found" || outcome.code === "unknown-node" ? 404 : 400;
        sendJson(res, httpStatus, { error: outcome.message, code: outcome.code });
        return true;
      }
      sendJson(res, 200, { report: { canvasId: outcome.canvasId, nodeId: outcome.nodeId, commandId: outcome.commandId } });
      return true;
    }

    sendJson(res, 404, { error: "not-found" });
    return true;
  };
}

function readString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
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
  return JSON.parse(text);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(Buffer.byteLength(payload)));
  res.end(payload);
}
