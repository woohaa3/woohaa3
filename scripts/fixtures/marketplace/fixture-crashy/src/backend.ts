/**
 * 故障 fixture（change: 2026-10-21-isolate-extension-host-process，任务 10.1）。
 *
 * 用来证明受管扩展的进程级故障只终止它自己的 Extension Host 子进程：
 * - 路由 `POST /api/extensions/fixture-crashy/<mode>`，mode：
 *   - `exit`：`process.exit(42)`（主动退出）；
 *   - `throw`：下一轮事件循环抛未捕获异常；
 *   - `hang`：同步死循环（心跳超时后被宿主判死）；
 *   - `oom`：持续分配直到超过 `--max-old-space-size`；
 *   - `ping`：返回 pid，确认存活；
 * - 也注册一个 Provider：模型 `crash-exit` / `crash-hang` 在 doGenerate 时分别 exit / 死循环，
 *   用来验证在途生成任务以 `extension-crashed` 失败；`crash-ok` 正常回显。
 * - 配置 `crashOnActivate`（缺省 false）为 true 时在 apply 里直接退出：用于熔断（5 分钟 3 次）用例。
 */
import { createPptaskProvider } from "@sdppp/pptask";
import { defineConfigSchema, type GenerationProvider, type HostExtensionPlugin } from "@woohaa3/contracts";

const ID = "fixture-crashy";
const PROVIDER_ID = "fixture-crashy";
const PREFIX = `/api/extensions/${ID}/`;

export const FIXTURE_CRASHY_CONFIG = defineConfigSchema({
  crashOnActivate: { kind: "boolean", default: false, reload: "hot", label: "激活即崩溃", description: "测试熔断：激活时直接退出进程" }
});

type Mode = "exit" | "throw" | "hang" | "oom" | "ping";

export function misbehave(mode: Mode): unknown {
  switch (mode) {
    case "exit":
      process.exit(42);
      break;
    case "throw":
      setImmediate(() => {
        throw new Error("fixture-crashy: 未捕获异常");
      });
      return { scheduled: "throw" };
    case "hang":
      // eslint-disable-next-line no-constant-condition
      for (;;) {
        /* 同步死循环：阻塞事件循环，心跳无法回应 */
      }
    case "oom": {
      const hold: unknown[] = [];
      for (;;) hold.push(new Array(1_000_000).fill(Math.random()));
    }
    case "ping":
      return { ok: true, pid: process.pid };
  }
  return null;
}

function createCrashyProvider() {
  return createPptaskProvider({
    providerId: PROVIDER_ID,
    languageModel: (modelId: string) => ({
      supportedUrls: {},
      async doGenerate() {
        if (modelId === "crash-exit") misbehave("exit");
        if (modelId === "crash-hang") misbehave("hang");
        return {
          content: [{ type: "text", text: `ok from ${process.pid}` }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
          warnings: []
        };
      }
    }) as never
  });
}

export function createFixtureCrashyPlugin(): HostExtensionPlugin<typeof FIXTURE_CRASHY_CONFIG.fields> {
  return {
    name: ID,
    label: "市场测试：故障",
    configPrefix: "providers.fixture-crashy",
    inject: ["log", "generation", "gateway"],
    Config: FIXTURE_CRASHY_CONFIG,
    apply(ctx, config) {
      if (config.crashOnActivate) misbehave("exit");
      const registration = {
        extensionId: ID,
        providerId: PROVIDER_ID,
        available: true,
        models: ["crash-ok", "crash-exit", "crash-hang"].map((id) => ({ providerId: PROVIDER_ID, providerModelId: id, modelType: "language", title: id, promptRequirement: "optional" })),
        provider: createCrashyProvider()
      } as GenerationProvider;
      ctx.effect(() => ctx.generation.register(registration));
      const gateway = (ctx as unknown as { gateway?: { route(order: number, handler: (req: { method?: string; url?: string }, res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }) => boolean): () => void } }).gateway;
      if (gateway) {
        ctx.effect(() =>
          gateway.route(910, (req, res) => {
            const url = req.url ?? "";
            if (req.method !== "POST" || !url.startsWith(PREFIX)) return false;
            const mode = url.slice(PREFIX.length).split(/[/?]/)[0] as Mode;
            if (!["exit", "throw", "hang", "oom", "ping"].includes(mode)) return false;
            const body = misbehave(mode);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(body));
            return true;
          })
        );
      }
      ctx.log.scope(ID)({ event: "fixture-crashy-activated", pid: process.pid });
    }
  };
}
