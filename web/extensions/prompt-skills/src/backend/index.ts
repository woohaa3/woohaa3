/**
 * prompt-skills 后端入口（站点插件）。
 *
 * 两件事：解码前端的 JSON 请求，用宿主注入的 Task facade 提交一次语言模型任务；以及给
 * 插件设置页读写改写模型。扩展不接触 Provider 凭据、模型白名单或画布 run；模型是否可用由
 * Task 目录校验。
 *
 * 路由（见 extension.json 的 publicRoutes，落到相对 route）：
 * - `POST /api/prompt-skills/rewrite`：改写一次草稿；
 * - `GET  /api/prompt-skills/config`：读回设置页的模型与 revision；
 * - `POST /api/prompt-skills/config`：带 CAS 保存模型。
 *
 * **改写模型属于扩展配置**（owner-scoped `documents` 的 `config` 文档），由插件设置页写入；
 * 执行面板不传模型，也不渲染模型选择器。站点插件的后端定义没有 `ctx.settings` 注册面，
 * 因此不走 `woohaa.config.yml` 的 `extensions.*` 值（未注册的键不会出现在 `host.config.values()`）。
 *
 * 认证：本地单实例（`accessControl === false`）直接可用；启用企业访问控制后要求已登录主体。
 */
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationExtensionHttpRequest,
  ApplicationExtensionHttpResponse
} from "@woohaa3/contracts";
import {
  decodePromptSkillRewriteRequest,
  PROMPT_SKILLS_PLUGIN_ID,
  type PromptSkillConfigResponse,
  type PromptSkillRewriteResponse
} from "../shared.js";
import { readPromptSkillsConfig, writePromptSkillsConfig } from "./config-store.js";
import { rewritePromptWithTask } from "./rewrite.js";

export type PromptSkillsExtensionOptions = {
  /** 覆盖等待上限（测试/自定义部署用）。 */
  timeoutMs?: number;
  pollIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** 一次请求体的字节上限：远大于 6000 字草稿，同时挡住畸形大包。 */
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * 写回 JSON 响应。
 *
 * 不要用 `res.writableEnded` 做闸门：公开 HTTP 分派的 facade 把「请求 close 信号」也算进该
 * getter，长任务返回时信号可能已经 abort，提前 return 会让客户端永远等不到响应（实测：
 * 改写成功、任务落库，但 HTTP 0 字节）。真正已结束的连接由 facade 的 `end` 自行兜底。
 */
function sendJson(res: ApplicationExtensionHttpResponse, status: number, body: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  try {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-length", String(bytes.byteLength));
    res.writeHead(status);
    res.end(bytes);
  } catch {
    // 客户端已断开：没有可写回的响应，不改写结论。
  }
}

async function readJsonBody(req: ApplicationExtensionHttpRequest): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await req.readBody(MAX_REQUEST_BYTES)));
}

export function createPromptSkillsExtension(
  options: PromptSkillsExtensionOptions = {}
): ApplicationBackendExtensionDefinition {
  return {
    extensionId: PROMPT_SKILLS_PLUGIN_ID,
    activate(host) {
      if (!host.registerHttpHandler) {
        // 纯本地最小宿主没有 HTTP 寄存器：不假装可用，前端会沿用「未接入」提示。
        host.logger({ event: "prompt-skills-disabled", reason: "宿主未提供 registerHttpHandler" });
        return;
      }
      const documents = host.services.documents;

      host.registerHttpHandler({
        route: "config",
        method: "GET",
        auth: "public",
        purpose: "read",
        handle: async (req: ApplicationExtensionHttpRequest, res: ApplicationExtensionHttpResponse) => {
          if (req.accessControl === true && !req.principal) {
            sendJson(res, 401, { ok: false, error: "需要登录后读取快捷改写配置" } satisfies PromptSkillConfigResponse);
            return;
          }
          const result = await readPromptSkillsConfig(documents);
          if (!result.ok) {
            sendJson(res, 503, { ok: false, error: result.message } satisfies PromptSkillConfigResponse);
            return;
          }
          sendJson(res, 200, { ok: true, model: result.config.model, revision: result.config.revision } satisfies PromptSkillConfigResponse);
        }
      });

      host.registerHttpHandler({
        route: "config",
        method: "POST",
        auth: "public",
        purpose: "new-work",
        handle: async (req: ApplicationExtensionHttpRequest, res: ApplicationExtensionHttpResponse) => {
          if (req.accessControl === true && !req.principal) {
            sendJson(res, 401, { ok: false, error: "需要登录后修改快捷改写配置" } satisfies PromptSkillConfigResponse);
            return;
          }
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" } satisfies PromptSkillConfigResponse);
            return;
          }
          const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          const result = await writePromptSkillsConfig(documents, {
            model: input.model,
            expectedRevision: input.expectedRevision
          });
          if (!result.ok) {
            sendJson(res, result.code === "conflict" ? 409 : result.code === "unavailable" ? 503 : 400, {
              ok: false,
              error: result.message
            } satisfies PromptSkillConfigResponse);
            return;
          }
          sendJson(res, 200, { ok: true, model: typeof input.model === "string" ? input.model.trim() : "", revision: result.revision } satisfies PromptSkillConfigResponse);
        }
      });

      host.registerHttpHandler({
        route: "rewrite",
        method: "POST",
        auth: "public",
        purpose: "new-work",
        handle: async (req: ApplicationExtensionHttpRequest, res: ApplicationExtensionHttpResponse) => {
          try {
            if (req.accessControl === true && !req.principal) {
              sendJson(res, 401, { ok: false, error: "需要登录后使用快捷改写" });
              return;
            }
            let body: unknown;
            try {
              body = await readJsonBody(req);
            } catch {
              sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
              return;
            }
            const decoded = decodePromptSkillRewriteRequest(body);
            if (!decoded.ok) {
              sendJson(res, 400, { ok: false, error: decoded.error });
              return;
            }
            const config = await readPromptSkillsConfig(documents);
            if (!config.ok) {
              sendJson(res, 503, { ok: false, error: config.message });
              return;
            }
            if (config.config.model === "") {
              sendJson(res, 400, { ok: false, error: "请先在插件设置中选择快捷改写模型" });
              return;
            }
            const timeoutMs = options.timeoutMs;
            const result = await rewritePromptWithTask(
              { ...decoded.value, modelKey: config.config.model },
              {
                tasks: host.services.tasks,
                logger: host.logger,
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
                ...(options.wait ? { wait: options.wait } : {}),
                ...(options.now ? { now: options.now } : {})
              }
            );
            if (!result.ok) {
              sendJson(res, result.status, { ok: false, error: result.error } satisfies PromptSkillRewriteResponse);
              return;
            }
            sendJson(res, 200, { ok: true, prompt: result.prompt } satisfies PromptSkillRewriteResponse);
          } catch (error) {
            host.logger({
              event: "prompt-skills-rewrite-failed",
              message: error instanceof Error ? error.message : String(error)
            });
            sendJson(res, 500, { ok: false, error: "改写请求处理失败" });
          }
        }
      });

      host.logger({ event: "prompt-skills-activated" });
    }
  };
}
