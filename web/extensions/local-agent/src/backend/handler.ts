/**
 * local-agent 受控 HTTP handler（连接设置 / 登录指引 / 探测）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.5/3.3 / design D4/D5）。
 *
 * 与 sdk-agent 同构：owner 只取 `context.principal.subject`。本机来源**没有 API Key 表单**：
 * - `GET  /api/local-agent/connections`：列出 owner 配置并只读发现本机安装与运行状态；
 * - `POST /api/local-agent/connections`：启用已发现工具（useDetected 幂等；兼容旧创建请求）；
 * - `POST /api/local-agent/connections/<id>/delete`：删除（保留历史）；
 * - `POST /api/local-agent/check`：运行依赖探测（缺 CLI/未登录准确报错）；
 * - 登录指引由前端渲染（官方登录流程；应用不复制认证文件）。
 */
import type {
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse,
  ApplicationExtensionRequestContext,
} from "@woohaa3/contracts";
import type { ConnectionService } from "@woohaa3/agent-connections";
import {
  LOCAL_AGENT_ADAPTERS,
  LOCAL_AGENT_LOCATION_NOTE,
  findLocalAgentAdapter,
} from "../shared.js";
import {
  createLocalAgentDiscovery,
  type LocalAgentDetection,
} from "./discovery.js";
import type { LocalAgentAdapterDescriptor } from "../shared.js";
import type { LocalAgentTransport } from "./transports/transport.js";
import type { ProcessManager } from "./process-manager.js";

export type LocalAgentHandlerOptions = {
  service: ConnectionService;
  executableFor: (adapterId: string) => string | null | Promise<string | null>;
  processManager: ProcessManager;
  transports?: Record<string, LocalAgentTransport>;
  argsFor?: (adapterId: string) => readonly string[];
  discover?: (
    adapter: LocalAgentAdapterDescriptor,
    managed: boolean,
  ) => Promise<LocalAgentDetection>;
};

const BASE_PATH = "/api/local-agent";

export function createLocalAgentHandler(options: LocalAgentHandlerOptions) {
  const { service } = options;
  const discover =
    options.discover ??
    createLocalAgentDiscovery({ executableFor: options.executableFor });
  const enabling = new Map<string, Promise<unknown>>();

  const sendJson = (
    res: ApplicationExtensionRawResponse,
    status: number,
    payload: unknown,
  ) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  };
  const readBody = async (
    req: ApplicationExtensionRawRequest,
  ): Promise<unknown> => {
    const chunks: Buffer[] = [];
    return await new Promise((resolve) => {
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.trim() === "") return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  };

  const handle = async (
    req: ApplicationExtensionRawRequest,
    res: ApplicationExtensionRawResponse,
    context: ApplicationExtensionRequestContext,
  ): Promise<void> => {
    const owner = context.principal?.subject;
    if (!owner)
      return sendJson(res, 401, {
        code: "unauthorized",
        message: "缺少可信身份",
      });
    const url = new URL(req.url ?? BASE_PATH, "http://localhost");
    const suffix = url.pathname.startsWith(BASE_PATH)
      ? url.pathname.slice(BASE_PATH.length).replace(/^\/+/, "")
      : "";
    const method = (req.method ?? "GET").toUpperCase();
    const segments = suffix.split("/").filter((part) => part !== "");

    if (
      segments.length === 1 &&
      segments[0] === "connections" &&
      method === "GET"
    ) {
      const records = await service.list(owner);
      const detectedAdapters = await Promise.all(
        LOCAL_AGENT_ADAPTERS.map(async (adapter) => ({
          ...adapter,
          ...(await discover(
            adapter,
            records.some(
              (record) =>
                record.adapterId === adapter.adapterId &&
                options.processManager.get({
                  adapterId: adapter.adapterId,
                  owner,
                  connectionId: record.connectionId,
                }) !== null,
            ),
          )),
        })),
      );
      const connections = records
        .filter((record) => findLocalAgentAdapter(record.adapterId))
        .map((record) => {
          const adapter = findLocalAgentAdapter(record.adapterId)!;
          return {
            connectionId: record.connectionId,
            adapterId: record.adapterId,
            name: record.name,
            label: adapter.label,
            runCategory: record.runCategory,
            authMode: record.authMode,
            configRevision: record.configRevision,
            requiresLocalLogin: adapter.requiresLocalLogin,
            // 安装/运行与登录状态分开：未安装时明确不可用。
            executableInstalled:
              detectedAdapters.find(
                (item) => item.adapterId === record.adapterId,
              )?.installed ?? false,
            running:
              options.processManager.get({
                adapterId: record.adapterId,
                owner,
                connectionId: record.connectionId,
              }) !== null,
            lastStatus: record.lastStatus,
          };
        });
      return sendJson(res, 200, {
        connections,
        adapters: detectedAdapters,
        locationNote: LOCAL_AGENT_LOCATION_NOTE,
      });
    }

    if (
      segments.length === 1 &&
      segments[0] === "connections" &&
      method === "POST"
    ) {
      const body = (await readBody(req)) as Record<string, unknown> | null;
      const adapterId =
        body && typeof body.adapterId === "string" ? body.adapterId : "";
      const adapter = findLocalAgentAdapter(adapterId);
      if (!adapter)
        return sendJson(res, 400, {
          code: "connection-unsupported",
          message: "未知本机接入方式",
        });
      if (body?.useDetected === true) {
        if (!(await options.executableFor(adapter.adapterId)))
          return sendJson(res, 400, {
            code: "runtime-missing",
            message: "未找到工具。请在后端机器安装后重新检测。",
          });
        const key = `${owner}:${adapter.adapterId}`;
        const useTool = async () => {
          const existing = (await service.list(owner)).find(
            (record) => record.adapterId === adapter.adapterId,
          );
          return existing
            ? { ok: true as const, value: existing }
            : service.create(owner, {
                adapterId: adapter.adapterId,
                name: adapter.label,
                runCategory: adapter.runCategory,
                authMode: adapter.authMode,
              });
        };
        const promise = enabling.get(key) ?? useTool();
        enabling.set(key, promise);
        try {
          const result = (await promise) as Awaited<ReturnType<typeof useTool>>;
          return result.ok
            ? sendJson(res, 200, { connectionId: result.value.connectionId })
            : sendJson(res, 500, result.error);
        } finally {
          if (enabling.get(key) === promise) enabling.delete(key);
        }
      }
      const models = Array.isArray(body?.models)
        ? (body!.models as unknown[]).filter(
            (entry): entry is string =>
              typeof entry === "string" && entry !== "",
          )
        : undefined;
      const created = await service.create(owner, {
        adapterId: adapter.adapterId,
        name:
          typeof body?.name === "string" && body.name.trim() !== ""
            ? body.name
            : adapter.label,
        runCategory: adapter.runCategory,
        authMode: adapter.authMode,
        ...(models && models.length > 0 ? { models } : {}),
      });
      if (!created.ok)
        return sendJson(
          res,
          created.error.code === "version-conflict" ? 409 : 500,
          created.error,
        );
      return sendJson(res, 200, { connectionId: created.value.connectionId });
    }

    if (segments.length >= 2 && segments[0] === "connections") {
      const connectionId = decodeURIComponent(segments[1]);
      const record = await service.get(owner, connectionId);
      if (!record)
        return sendJson(res, 404, {
          code: "not-found",
          message: "连接不存在或无权访问",
        });
      if (
        segments.length === 3 &&
        segments[2] === "delete" &&
        method === "POST"
      ) {
        const removed = await service.remove(owner, connectionId);
        return removed.ok
          ? sendJson(res, 200, { removed: true })
          : sendJson(res, 500, removed.error);
      }
    }

    if (segments.length === 1 && segments[0] === "check" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown> | null;
      const connectionId =
        body && typeof body.connectionId === "string" ? body.connectionId : "";
      const record = await service.get(owner, connectionId);
      if (!record)
        return sendJson(res, 404, {
          code: "not-found",
          message: "连接不存在或无权访问",
        });
      const probe = await options.processManager.probe(record.adapterId);
      const transport = options.transports?.[record.adapterId];
      if (probe.ok && transport?.check && options.argsFor) {
        try {
          const adapter = findLocalAgentAdapter(record.adapterId)!;
          const handle = await options.processManager.ensure({ owner, connectionId, adapterId: record.adapterId, args: options.argsFor(record.adapterId), kind: adapter.transport === "stdio-jsonrpc" ? "stdio" : "http" });
          const status = await transport.check({ configDir: handle.configDir, workDir: handle.workDir, loopbackUrl: handle.loopbackUrl, stdio: handle.stdio ?? null });
          await service.setStatus({ owner, connectionId, patch: status });
          return sendJson(res, 200, { transport: status.transport.state, credential: status.credential.state, modelAccess: status.modelAccess.state, tools: status.tools.state, note: status.credential.reason ?? status.transport.reason ?? "专用连接与账号检查完成；未调用模型，作品工具仍待实际验证" });
        } catch { return sendJson(res, 200, { transport: "unavailable", credential: "unknown", modelAccess: "unknown", tools: "unknown", note: "专用连接检查失败，请核对宿主工具和登录状态" }); }
      }
      // 只证明「可执行入口存在/缺失」，**不**据此把 transport 标 ready（存在 CLI ≠ 连接可用）。
      // 真实 transport/账号证据在显式执行（run）时由传输记录到 `record.lastStatus`。
      return sendJson(res, 200, {
        transport: probe.ok ? "unknown" : "unavailable",
        credential: record.lastStatus?.credential.state ?? "unknown",
        modelAccess: record.lastStatus?.modelAccess.state ?? "unknown",
        tools: record.lastStatus?.tools.state ?? "unknown",
        note: probe.ok
          ? "运行依赖探测：可执行入口存在；连接与登录状态在显式执行时核对"
          : probe.message,
      });
    }

    return sendJson(res, 404, { code: "not-found", message: "未知路径" });
  };

  return { handle };
}
