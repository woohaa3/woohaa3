/**
 * 回显 Provider fixture（change: 2026-10-21-isolate-extension-host-process，任务 10.1）。
 *
 * 真实走 pptask 执行面，用来端到端验证 Extension Host 子进程的 Provider 远程桩：
 * - `echo-text`（language，同步）：`doGenerate` 回显 prompt，带 `greeting` 前缀；
 * - `echo-image`（image，异步）：`doStart` 返回 operation，`doStatus` 轮询 `delayMs` 后完成，产出 1×1 PNG；
 *   Task worker 经 `provider.jobs.start` / `handle.wait` 驱动，覆盖 jobs 路径。
 * - 模型刷新路由 `POST /api/extensions/fixture-echo-provider/refresh`（扩展前缀下）。
 *
 * 只依赖 `@sdppp/pptask`（打包时内联）与 `@woohaa3/contracts`；不出网（permissions.network 为空）。
 * 每次生成把子进程 pid 写进 providerMetadata，端到端用它证明执行发生在子进程。
 */
import { createPptaskProvider } from "@sdppp/pptask";
import { defineConfigSchema, type GenerationProvider, type ExtensionPlugin } from "@woohaa3/contracts";
import {
  FIXTURE_ECHO_IMAGE_MODEL,
  FIXTURE_ECHO_PLUGIN_ID,
  FIXTURE_ECHO_PROVIDER_ID,
  FIXTURE_ECHO_REFRESH_PATH,
  FIXTURE_ECHO_TEXT_MODEL
} from "./shared.js";

export const FIXTURE_ECHO_CONFIG = defineConfigSchema({
  greeting: { kind: "string", default: "echo", reload: "hot", label: "回显前缀", description: "文本模型回显时加的前缀" },
  delayMs: { kind: "integer", default: 200, min: 0, max: 60000, reload: "hot", label: "图片任务时长", description: "异步图片任务从开始到完成的毫秒数" }
});

/** 1×1 透明 PNG。 */
const PNG_1X1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

function promptOf(options: { prompt?: unknown }): string {
  const prompt = options.prompt;
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    // LanguageModelV4 prompt：[{ role, content: [{ type: "text", text }] }]
    return prompt
      .flatMap((message: { content?: unknown }) => (Array.isArray(message?.content) ? message.content : []))
      .map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text ?? "" : ""))
      .join("");
  }
  return "";
}

export function createFixtureEchoProvider(config: { greeting: string; delayMs: number }) {
  const operations = new Map<string, number>();
  return createPptaskProvider({
    providerId: FIXTURE_ECHO_PROVIDER_ID,
    pollIntervalMs: 50,
    languageModel: () => ({
      supportedUrls: {},
      async doGenerate(options: { prompt?: unknown }) {
        const text = `${config.greeting}: ${promptOf(options)}`;
        return {
          content: [{ type: "text", text }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 0 }, outputTokens: { total: text.length } },
          warnings: [],
          providerMetadata: { [FIXTURE_ECHO_PROVIDER_ID]: { pid: process.pid } }
        };
      }
    }) as never,
    imageModel: () => ({
      maxImagesPerCall: 1,
      async doStart() {
        const id = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        operations.set(id, Date.now() + config.delayMs);
        return { operation: { id } };
      },
      async doStatus({ operation }: { operation: { id: string } }) {
        const doneAt = operations.get(operation.id);
        if (doneAt === undefined) return { status: "error", error: `未知任务 ${operation.id}` };
        if (Date.now() < doneAt) return { status: "pending", phase: "running" };
        operations.delete(operation.id);
        return {
          status: "completed",
          images: [PNG_1X1],
          warnings: [],
          response: { timestamp: new Date(), modelId: FIXTURE_ECHO_IMAGE_MODEL, headers: {} },
          providerMetadata: { [FIXTURE_ECHO_PROVIDER_ID]: { pid: process.pid, images: [{}] } }
        };
      },
      async doCancel({ operation }: { operation: { id: string } }) {
        operations.delete(operation.id);
      }
    }) as never
  });
}

export function createFixtureEchoProviderPlugin(): ExtensionPlugin<typeof FIXTURE_ECHO_CONFIG.fields> {
  return {
    name: FIXTURE_ECHO_PLUGIN_ID,
    label: "市场测试 Provider",
    configPrefix: "providers.fixture-echo",
    modelRefresh: { path: FIXTURE_ECHO_REFRESH_PATH, hint: "回显 fixture：模型表固定，刷新只返回当前数量。" },
    inject: ["log", "generation", "gateway"],
    Config: FIXTURE_ECHO_CONFIG,
    apply(ctx, config) {
      const log = ctx.log.scope(FIXTURE_ECHO_PLUGIN_ID);
      const provider = createFixtureEchoProvider({ greeting: config.greeting, delayMs: config.delayMs });
      const registration: GenerationProvider = {
        extensionId: FIXTURE_ECHO_PLUGIN_ID,
        providerId: FIXTURE_ECHO_PROVIDER_ID,
        available: true,
        models: [
          { providerId: FIXTURE_ECHO_PROVIDER_ID, providerModelId: FIXTURE_ECHO_TEXT_MODEL, modelType: "language", title: "回显文本", promptRequirement: "required" },
          { providerId: FIXTURE_ECHO_PROVIDER_ID, providerModelId: FIXTURE_ECHO_IMAGE_MODEL, modelType: "image", title: "回显图片", promptRequirement: "optional" }
        ],
        provider
      } as GenerationProvider;
      ctx.effect(() => ctx.generation.register(registration));
      const gateway = (ctx as unknown as { gateway?: { route(order: number, handler: (req: { method?: string; url?: string }, res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }) => boolean | Promise<boolean>): () => void } }).gateway;
      if (gateway) {
        ctx.effect(() =>
          gateway.route(900, (req, res) => {
            if (req.method !== "POST" || !(req.url ?? "").startsWith(FIXTURE_ECHO_REFRESH_PATH)) return false;
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, modelCount: registration.models.length, pid: process.pid }));
            return true;
          })
        );
      }
      log({ event: "fixture-echo-provider-activated", pid: process.pid, greeting: config.greeting });
    }
  };
}
