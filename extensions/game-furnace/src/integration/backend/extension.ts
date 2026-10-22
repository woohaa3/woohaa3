/**
 * 游戏炼丹炉后端插件定义
 * （change: 2026-10-10-add-game-furnace-extension，任务 6–8；按 integration 新架构重实现）。
 *
 * 把 `createGameFurnaceBackend` 控制器接到统一后端的进程内 facade（owner-scoped Task/Media），
 * 并用受控 handler 暴露：项目保存/打开、生成、收尾、预览申请/组装，以及直接打开预览入口的
 * 原始 HTTP 入口（带响应级 CSP sandbox）。
 *
 * 新架构差异（见 notes/port-plan.md 阶段 5）：扩展后端无画布容器 facade；项目状态经本插件
 * 自己的 handler + Media 内容寻址持久化，前端持有稳定 storageKey 关联。生成结果从不进入
 * 普通节点结果 projector（本插件只提交非画布 language Task 并自持完整结果）。
 */
import { GAME_FURNACE_MCP_TOOLS, registerGameFurnaceMcp } from "./mcp.js";
import type { ApplicationBackendExtensionDefinition, ApplicationExtensionRequestContext } from "@woohaa3/contracts";
import { addAppBasePath } from "@woohaa3/contracts";
import { GAME_FURNACE_PLUGIN_ID, GAME_FURNACE_SCHEMA_VERSION, type GameFurnaceState } from "../../state/shared/index.js";
import { createGameFurnaceBackend, type GameFurnaceBackendServices } from "./controller.js";
import { isGameFurnaceNodeData, GAME_FURNACE_NODE_TYPE } from "../../preview/shared/geometry.js";
import { isSelfOrAncestorDrop, planGameFurnaceDrop } from "../../authoring/shared/collection.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type GameFurnaceBackendDefinitionOptions = {
  /** 测试/嵌入时可注入控制器（缺省自建）。 */
  controller?: ReturnType<typeof createGameFurnaceBackend>;
};

/** 授权拒绝的受控响应（任务 6.2）。 */
type AuthorizationDenial = { status: number; body: { ok: false; code: string; message: string } };

/**
 * 构造游戏炼丹炉后端插件定义（构建时可信清单静态登记）。
 *
 * `activate` 内装配控制器、注册受控 handler 与原始预览入口；`dispose` 释放预览会话。
 */
export function createGameFurnaceBackendDefinition(
  options: GameFurnaceBackendDefinitionOptions = {}
): ApplicationBackendExtensionDefinition {
  return {
    extensionId: GAME_FURNACE_PLUGIN_ID,
    mcpTools: GAME_FURNACE_MCP_TOOLS,
    capabilities: [
      { id: `${GAME_FURNACE_PLUGIN_ID}.generate`, kind: "capability", description: "使用本站文本模型生成可试玩 HTML 游戏" }
    ],
    activate(host) {
      const controller = options.controller ?? createGameFurnaceBackend();
      controller.install({
        services: {
          tasks: host.services.tasks,
          media: host.services.media
        } satisfies GameFurnaceBackendServices,
        work: () => {
          const admission = host.work.admit();
          return admission.ok
            ? { ok: true, workId: admission.workId, configVersion: admission.configVersion }
            : { ok: false, reason: admission.reason };
        },
        logger: (event) => host.logger({ module: "game-furnace", ...event }),
        settleWork: (workId, state) => host.work.resume(workId)?.settle(state),
        // 只读部署上下文：入口 URL 与 CSP 作用域都在其上派生（design D6）。
        deploymentBasePath: host.deployment?.basePath ?? "/"
      });

      /**
       * 任务 6.2：受控 handler 的权威项目读写授权。
       *
       * 只凭浏览器自报的 canvasId/nodeId 放行是不安全的：任何已认证主体都能读写任意项目。这里
       * 用宿主注入的可信 principal.subject 经 `services.canvasAccess` 判定画布读/写权限。宿主未
       * 配置授权能力时 **fail closed**（503），绝不退回“知道 id 即可写”。
       */
      const authorizeProject = async (
        context: ApplicationExtensionRequestContext | undefined,
        canvasId: string,
        permission: "read" | "write"
      ): Promise<AuthorizationDenial | null> => {
        const subject = context?.principal?.subject;
        if (typeof subject !== "string" || subject.trim() === "") {
          return { status: 401, body: { ok: false, code: "unauthorized", message: "缺少已认证主体" } };
        }
        const access = host.services.canvasAccess;
        if (!access) {
          host.logger({ module: "game-furnace", event: "authorize-unavailable", canvasId, permission });
          return { status: 503, body: { ok: false, code: "unavailable", message: "宿主未提供项目授权能力" } };
        }
        const decision = await access.authorize({ subject, canvasId, permission });
        if (!decision.ok) {
          return {
            status: decision.code === "unauthorized" ? 401 : decision.code === "unavailable" ? 503 : 403,
            body: { ok: false, code: decision.code, message: decision.message }
          };
        }
        return null;
      };

      registerGameFurnaceMcp(host, controller);

      host.registerHandler({
        route: "game-furnace/project-save",
        auth: "authenticated",
        purpose: "work-control",
        async handle({ body, context }) {
          const input = body as { canvasId?: unknown; nodeId?: unknown; state?: unknown };
          if (typeof input?.canvasId !== "string" || typeof input?.nodeId !== "string" || typeof input.state !== "object" || input.state === null) {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          }
          const denial = await authorizeProject(context, input.canvasId, "write");
          if (denial) return denial;
          const result = await controller.saveProject({ canvasId: input.canvasId, nodeId: input.nodeId, state: input.state as GameFurnaceState });
          return { status: result.ok === true ? 200 : 400, body: result };
        }
      });

      host.registerHandler({
        route: "game-furnace/project-open",
        auth: "authenticated",
        purpose: "read",
        async handle({ body, context }) {
          const input = body as { canvasId?: unknown; nodeId?: unknown; projectStorageKey?: unknown };
          if (typeof input?.canvasId !== "string" || typeof input?.nodeId !== "string" || typeof input?.projectStorageKey !== "string") {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          }
          const denial = await authorizeProject(context, input.canvasId, "read");
          if (denial) return denial;
          const result = await controller.openProject({ canvasId: input.canvasId, nodeId: input.nodeId, projectStorageKey: input.projectStorageKey });
          return { status: result.ok === true ? 200 : 404, body: result };
        }
      });

      // 画布拖入收集：前端规划 `resources.add` 操作，服务端施加到当前项目并写新 envelope。
      host.registerHandler({
        route: "game-furnace/project-collect",
        auth: "authenticated",
        purpose: "work-control",
        async handle({ body, context }) {
          const input = body as { canvasId?: unknown; nodeId?: unknown; operations?: unknown; collectionId?: unknown; expectedProjectStorageKey?: unknown; sourceSnapshots?: unknown };
          if (typeof input?.canvasId !== "string" || typeof input?.nodeId !== "string" || !Array.isArray(input.operations) || input.operations.length === 0) {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          }
          const denial = await authorizeProject(context, input.canvasId, "write");
          if (denial) return denial;
          if (input.collectionId !== undefined && (typeof input.collectionId !== "string" || !input.collectionId || input.collectionId.length > 128)) {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "投放身份非法" } };
          }
          const operations = input.operations as import("@woohaa3/contracts").Woohaa3CanvasJsonObject[];
          const hasCanvasSources = operations.some((operation) => {
            const candidate = operation as { type?: unknown; resources?: unknown };
            return candidate.type === "resources.add" && Array.isArray(candidate.resources)
              && candidate.resources.some((resource) => !!resource && typeof resource === "object" && "source" in resource);
          });
          if (hasCanvasSources) {
            const subject = context?.principal?.subject;
            const snapshots = input.sourceSnapshots;
            if (typeof subject !== "string" || !Array.isArray(snapshots) || snapshots.length === 0
              || snapshots.some((source) => !source || typeof source !== "object"
                || typeof (source as { nodeId?: unknown }).nodeId !== "string"
                || !("data" in source))) {
              return { status: 400, body: { ok: false, code: "malformed-request", message: "来源快照缺失或非法" } };
            }
            const extensionNodes = host.services.extensionNodes;
            if (!extensionNodes) {
              return { status: 503, body: { ok: false, code: "unavailable", message: "宿主未提供画布权威读取能力" } };
            }
            try {
              const authoritative = await extensionNodes.read({ subject, canvasId: input.canvasId, permission: "write" });
              if (!authoritative.document.nodes.some((node) => node.id === input.nodeId
                && node.type === GAME_FURNACE_NODE_TYPE && isGameFurnaceNodeData(authoritative.nodeData[node.id]))) {
                return { status: 409, body: { ok: false, code: "unsupported-node", message: "目标不是炼丹炉节点" } };
              }
              if (input.expectedProjectStorageKey !== undefined
                && input.expectedProjectStorageKey !== authoritative.nodeData[input.nodeId]?.projectStorageKey) {
                return { status: 409, body: { ok: false, code: "content-conflict", message: "目标项目关联已变化，请重新拖入" } };
              }
              const sourceIds = snapshots.map((source) => (source as { nodeId: string }).nodeId);
              const plan = planGameFurnaceDrop(authoritative, sourceIds, input.collectionId as string | undefined);
              const matchesSnapshot = plan && stableJson(plan.sourceSnapshots) === stableJson(snapshots);
              const matchesOperations = plan && stableJson(plan.operations) === stableJson(operations);
              if (!plan || !matchesSnapshot || !matchesOperations
                || isSelfOrAncestorDrop(authoritative, input.nodeId, sourceIds)) {
                return { status: 409, body: { ok: false, code: "content-conflict", message: "来源素材或目标画布已变化，请重新拖入" } };
              }
            } catch (error) {
              host.logger({ module: "game-furnace", event: "collect-source-read-failed", canvasId: input.canvasId, message: error instanceof Error ? error.message : "unknown" });
              return { status: 503, body: { ok: false, code: "unavailable", message: "无法重新验证画布来源" } };
            }
          }
          const result = await controller.collectResources({
            canvasId: input.canvasId,
            nodeId: input.nodeId,
            operations,
            ...(typeof input.expectedProjectStorageKey === "string" ? { expectedProjectStorageKey: input.expectedProjectStorageKey } : {})
          });
          return { status: result.ok === true ? 200 : 409, body: result };
        }
      });

      host.registerHandler({
        route: "game-furnace/generate",
        auth: "authenticated",
        purpose: "new-work",
        async handle({ body, context }) {
          const input = body as { canvasId?: unknown; nodeId?: unknown; expectedInputHash?: unknown; supportedInputs?: unknown };
          if (typeof input?.canvasId !== "string" || typeof input?.nodeId !== "string" || typeof input?.expectedInputHash !== "string") {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          }
          const denial = await authorizeProject(context, input.canvasId, "write");
          if (denial) return denial;
          // 任务 6.6：只接受形如 { mediaKinds: string[], mediaTypes: string[] } 的能力声明；其余忽略。
          const supportedInputs = Array.isArray(input.supportedInputs)
            ? input.supportedInputs
                .filter((entry): entry is { mediaKinds: string[]; mediaTypes: string[] } => {
                  const record = entry as { mediaKinds?: unknown; mediaTypes?: unknown };
                  return !!record && Array.isArray(record.mediaKinds) && Array.isArray(record.mediaTypes)
                    && record.mediaKinds.every((kind) => typeof kind === "string") && record.mediaTypes.every((type) => typeof type === "string");
                })
                .map((entry) => ({ mediaKinds: entry.mediaKinds as readonly string[], mediaTypes: entry.mediaTypes as readonly string[] }))
            : [];
          const result = await controller.generate({ canvasId: input.canvasId, nodeId: input.nodeId, expectedInputHash: input.expectedInputHash, supportedInputs });
          return { status: result.ok === true ? 202 : 409, body: result };
        }
      });

      host.registerHandler({
        route: "game-furnace/finalize",
        auth: "authenticated",
        purpose: "work-control",
        async handle({ body, context }) {
          const input = body as { canvasId?: unknown; nodeId?: unknown; generationId?: unknown };
          if (typeof input?.canvasId !== "string" || typeof input?.nodeId !== "string" || typeof input?.generationId !== "string") {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          }
          const denial = await authorizeProject(context, input.canvasId, "write");
          if (denial) return denial;
          return { status: 200, body: await controller.finalize({ canvasId: input.canvasId, nodeId: input.nodeId, generationId: input.generationId }) };
        }
      });

      // 工作区预览：按当前授权项目与固定 buildId 申请短期只读会话，返回入口 HTML 与授权资源。
      host.registerHandler({
        route: "game-furnace/cancel", auth: "authenticated", purpose: "work-control",
        async handle({ body, context }) {
          const input = body as { canvasId?: unknown; nodeId?: unknown; generationId?: unknown };
          if (typeof input?.canvasId !== "string" || typeof input?.nodeId !== "string" || typeof input?.generationId !== "string") {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          }
          const denial = await authorizeProject(context, input.canvasId, "write");
          if (denial) return denial;
          const result = await controller.cancel({ canvasId: input.canvasId, nodeId: input.nodeId, generationId: input.generationId });
          return { status: result.ok === true ? 200 : 409, body: result };
        }
      });

      // 目标删除的取消/脱离（任务 6.10）：删除炼丹炉节点时按权限取消在途站点任务并脱离内存项目。
      host.registerHandler({
        route: "game-furnace/target-detach", auth: "authenticated", purpose: "work-control",
        async handle({ body, context }) {
          const input = body as { canvasId?: unknown; nodeId?: unknown };
          if (typeof input?.canvasId !== "string" || typeof input?.nodeId !== "string") {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          }
          const denial = await authorizeProject(context, input.canvasId, "write");
          if (denial) return denial;
          const result = await controller.detachTarget({ canvasId: input.canvasId, nodeId: input.nodeId });
          return { status: 200, body: result };
        }
      });

      // 显式采用候选/历史构建为活动版本；只改规范项目的 activeBuildId，不新增生成。
      host.registerHandler({
        route: "game-furnace/activate-build", auth: "authenticated", purpose: "work-control",
        async handle({ body, context }) {
          const input = body as { canvasId?: unknown; nodeId?: unknown; buildId?: unknown };
          if (typeof input?.canvasId !== "string" || typeof input?.nodeId !== "string" || typeof input?.buildId !== "string") {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          }
          const denial = await authorizeProject(context, input.canvasId, "write");
          if (denial) return denial;
          const result = await controller.activateBuild({ canvasId: input.canvasId, nodeId: input.nodeId, buildId: input.buildId });
          return { status: result.ok === true ? 200 : 404, body: result };
        }
      });

      host.registerHandler({
        route: "game-furnace/preview-open",
        auth: "authenticated",
        purpose: "read",
        async handle({ body, context }) {
          const input = body as { canvasId?: unknown; nodeId?: unknown; buildId?: unknown };
          if (typeof input?.canvasId !== "string" || typeof input?.nodeId !== "string" || typeof input?.buildId !== "string") {
            return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          }
          const denial = await authorizeProject(context, input.canvasId, "read");
          if (denial) return denial;
          const result = await controller.openPreview({ canvasId: input.canvasId, nodeId: input.nodeId, buildId: input.buildId });
          return { status: result.ok === true ? 200 : 404, body: result };
        }
      });

      // 工作区预览组装：返回入口 HTML 与授权资源（data URL）；会话 token 只在运行态。
      host.registerHandler({
        route: "game-furnace/preview-describe",
        auth: "authenticated",
        purpose: "read",
        async handle({ body }) {
          const input = body as { sessionId?: unknown };
          if (typeof input?.sessionId !== "string") return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          const described = controller.previewDescribe(input.sessionId);
          if (!described) return { status: 404, body: { ok: false, code: "preview-expired", message: "预览会话无效或已过期" } };
          return { status: 200, body: { ok: true, ...described } };
        }
      });

      // 释放短期只读预览会话（任务 8.7）：退出/停止/切换版本/作用域释放时回收固定资源与入口。
      host.registerHandler({
        route: "game-furnace/preview-close",
        auth: "authenticated",
        purpose: "work-control",
        async handle({ body }) {
          const input = body as { sessionId?: unknown };
          if (typeof input?.sessionId !== "string") return { status: 400, body: { ok: false, code: "malformed-request", message: "请求非法" } };
          controller.previewClose(input.sessionId);
          return { status: 200, body: { ok: true } };
        }
      });

      // 直接打开预览入口：只按 manifest 解析，响应带 CSP sandbox/nosniff/no-store。
      // 静态站点 URL 持有随机短期只读 capability，入口及相对资源均按固定会话文件表供应。
      host.registerRawHttpHandler?.({ route: "game-furnace/site/*", method: "GET", auth: "public", purpose: "read",
        async handle(req, res) {
          const url = new URL(req.url ?? "/", "http://local");
          const match = /\/site\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
          let filePath = "";
          try { filePath = match ? decodeURIComponent(match[2]!) : ""; } catch { /* 拒绝非法编码 */ }
          const file = match ? controller.previewFetch(match[1]!, filePath) : null;
          if (!file) { res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("游戏文件不存在或试玩会话已过期"); return; }
          const headers: Record<string, string> = { ...file.headers, "Accept-Ranges": "bytes" };
          // opaque iframe 的模块脚本经 CORS 加载；网络能力仅限本次固定构建路径。
          const authority = req.headers["x-forwarded-host"] ?? req.headers.host;
          if (filePath === "index.html" && typeof authority === "string" && /^[A-Za-z0-9.:[\]-]+$/.test(authority)) {
            const scope = `${authority}${addAppBasePath(host.deployment?.basePath ?? "/", `/api/extensions/game-furnace/site/${match![1]}/`)}`;
            headers["Content-Security-Policy"] = file.headers["Content-Security-Policy"]!.replaceAll("'self'", scope).replace("connect-src 'none'", `connect-src ${scope}`);
          }
          const range = req.headers.range;
          if (typeof range === "string") {
            const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
            const start = parsed?.[1] ? Number(parsed[1]) : Math.max(0, file.bytes.length - Number(parsed?.[2]));
            const end = parsed?.[1] ? (parsed[2] ? Math.min(Number(parsed[2]), file.bytes.length - 1) : file.bytes.length - 1) : file.bytes.length - 1;
            if (!parsed || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.bytes.length) { res.writeHead(416, { "Content-Range": `bytes */${file.bytes.length}` }); res.end(); return; }
            const bytes = file.bytes.subarray(start, end + 1);
            res.writeHead(206, { ...headers, "Content-Length": String(bytes.length), "Content-Range": `bytes ${start}-${end}/${file.bytes.length}` }); res.end(bytes); return;
          }
          res.writeHead(200, { ...headers, "Content-Length": String(file.bytes.length) }); res.end(file.bytes);
        }
      });
      // 用原始 HTTP handler：需要自定义响应头与二进制正文（通用 DTO handler 不承载 headers）。
      host.registerRawHttpHandler?.({
        route: "game-furnace/preview",
        method: "GET",
        auth: "authenticated",
        purpose: "read",
        handle: async (req, res) => {
          const url = new URL(req.url ?? "/", "http://local");
          const sessionId = url.searchParams.get("sessionId") ?? "";
          const path = url.searchParams.get("path") ?? "index.html";
          const file = sessionId ? controller.previewFetch(sessionId, path) : null;
          if (!file) {
            res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, code: "preview-expired", message: "预览会话无效或资源不在 manifest 内" }));
            return;
          }
          const headers: Record<string, string> = { ...file.headers };
          res.writeHead(200, headers);
          res.end(file.bytes);
        }
      });

      return { dispose: () => controller.dispose() };
    }
  };
}

/** schema 版本导出（供清单/诊断与前端共享 identity 对齐）。 */
export { GAME_FURNACE_SCHEMA_VERSION };
