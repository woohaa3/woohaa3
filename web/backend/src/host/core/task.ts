/**
 * 核心层 · task：生成任务的 catalog、worker 与历史。
 *
 * Provider 从 `ctx.generation` 懒读取；参考输入的对外地址由 task 先问 Provider（`uploadReference`），
 * 不行才经 Media 走存储 expose。字节读取直接接 `ctx.storage` 的 media namespace。
 * 启动恢复要等插件树全部装载（Provider 已注册）后才开始，所以 `task.start()` 挂在 `host/ready` 上。
 *
 * 任务终态写进本机遥测（change: 2026-10-20-add-local-client-telemetry，tasks 4.4）：接缝是历史
 * 仓库现成的 `subscribe`，宿主直接 `ctx.telemetry.emit`，不经 HTTP。
 */
import fs from "node:fs";
import { createServiceConnectionFetch } from "./service-connection-fetch.js";
import { createTaskInspectionApi } from "../../api/task-inspection-api.js";
import { locateArtifact } from "./artifact-location.js";
import {
  TASKS_INSPECT_ACTION,
  type StorageScope,
  type TaskExecutionState,
  type TelemetryResult
} from "@woohaa3/contracts";
import path from "node:path";
import { resolveGenerationModels } from "@woohaa3/application-service";
import { createTaskService, parseModelsConfig, type ModelsConfig } from "@woohaa3/task-service";
import type { HostPlugin } from "../context.js";
import { READINESS_ORDER, ROUTE_ORDER } from "../order.js";
import { mediaPortToTaskMediaClient } from "../../ports/adapters.js";
import { MEDIA_STORAGE_NAMESPACE } from "../../ports/media-storage.js";

/**
 * 终态任务在去重表里的上限：只防同一 taskKey 因终态后迟到写入被重复计数，不是保留策略。
 * 用插入序（Set 迭代顺序）淘汰最旧，内存有界，不需要引入定时清理。
 */
const TASK_TERMINAL_DEDUPE_LIMIT = 4096;

/** `TaskExecutionState` → 遥测结果；非终态返回 `undefined`（调用点据此跳过）。 */
function taskResultOf(state: TaskExecutionState): TelemetryResult | undefined {
  switch (state) {
    case "succeeded":
      return "success";
    case "failed":
      return "failure";
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

/**
 * 错误码：只取错误类名并归一成 `[a-z0-9][a-z0-9_.:-]{0,63}`，绝不带 `message`
 * （错误消息可能含用户内容，见 design D3 的禁止项）。无法归一即不填该字段。
 */
function taskErrorCodeOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const code = name
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return code === "" ? undefined : code;
}

function readModelsConfig(env: Record<string, string | undefined>, explicit?: ModelsConfig): ModelsConfig {
  if (explicit) return explicit;
  const candidate = env.WOOHAA3_MODELS_CONFIG_PATH
    ? path.resolve(env.WOOHAA3_MODELS_CONFIG_PATH)
    : path.resolve(process.cwd(), "web/services/task-service/pptask.models.json");
  if (!fs.existsSync(candidate)) return { version: 1, models: [] };
  const parsed = parseModelsConfig(JSON.parse(fs.readFileSync(candidate, "utf8")), candidate);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.config;
}

export const taskPlugin: HostPlugin<{ env: Record<string, string | undefined>; modelsConfig?: ModelsConfig }> = {
  name: "task",
  inject: ["log", "gateway", "media", "storage", "generation", "access"],
  apply(ctx, { env, modelsConfig }) {
    const task = createTaskService({
      env,
      accessRuntime: ctx.access.runtime,
      modelsConfig: readModelsConfig(env, modelsConfig),
      serviceToken: "", // 进程内调用不再使用服务令牌；保留空串以兼容历史配置校验。
      mediaClient: mediaPortToTaskMediaClient(ctx.media.port()),
      // Provider 自带上传用：参考字节直接读 media namespace，不经 HTTP。
      // Task 从提交请求传入画布作用域；扩展独立任务无作用域，仍使用主存储。
      readReferenceObject: (storageKey, scope?: StorageScope) =>
        ctx.storage.bucket(MEDIA_STORAGE_NAMESPACE, scope).get(storageKey),
      generationProviders: () => ctx.generation.list(),
      serviceConnections: {
        freeze: async (providerId, modelId, modelType, selected) => {
          const registry = ctx.get("application")?.service.serviceConnections();
          if (!registry) { if (selected) throw new Error("来源注册表未装配"); return null; }
          const actor = { owner: selected?.owner ?? "@site-task", administrator: !selected, canUseSite: true };
          const source = selected ? await registry.get(actor, selected.serviceConnectionId) : (await registry.list(actor)).find(source => source.scope === "site" && source.bindings.some(binding => binding.consumer === "provider" && binding.consumerId === providerId));
          if (selected && (!source || !ctx.generation.resolve(providerId)?.serviceConnectionFactory)) throw new Error("此 Provider 未适配所选个人来源");
          if (!source) return null; // Non-credential Providers (e.g. remote delegation) keep their original authority.
          if (!source.enabled) throw new Error("站点来源不可用");
          const binding = source.bindings.find(binding => binding.consumer === "provider" && binding.consumerId === providerId);
          if (!binding) throw new Error("来源未绑定此 Provider");
          const purpose = modelType === "language" ? "text" : modelType as "image" | "video" | "audio";
          const protocols = selected ? ctx.generation.resolve(providerId)?.serviceConnectionFactory?.protocols ?? [] : [`provider:${providerId}`];
          const endpoint = source.endpoints.find(endpoint => protocols.includes(endpoint.protocol));
          // Providers without a configurable endpoint keep their opaque original execution handle.
          if (!endpoint && selected) throw new Error("来源协议不受此 Provider 支持");
          if (!endpoint) return null;
          return { ...(selected ? { owner: selected.owner } : {}), serviceConnectionId: source.serviceConnectionId, configRevision: source.configRevision, credentialEpoch: source.credentialEpoch,
            bindingId: binding.bindingId, purpose, protocol: endpoint.protocol, modelId, endpoint: endpoint.baseUrl };
        },
        resolve: async (reference, providerId) => {
          const registry = ctx.get("application")?.service.serviceConnections();
          const provider = ctx.generation.resolve(providerId);
          const actor = { owner: reference.owner ?? "@site-task", administrator: !reference.owner, canUseSite: true };
          const validate = async () => {
            const source = await registry?.get(actor, reference.serviceConnectionId);
            if (ctx.generation.resolve(providerId) !== provider || !provider?.available) throw Object.assign(new Error("Provider 已停用或重新配置"), { sourceStale: true });
            if (!source || !source.enabled || source.removed || source.configRevision !== reference.configRevision || source.credentialEpoch !== reference.credentialEpoch) throw Object.assign(new Error("服务来源已失效，不能改用新凭据"), { sourceStale: true });
          };
          await validate();
          if (!registry || !provider) throw Object.assign(new Error("来源适配器不可用"), { sourceStale: true });
          if (!provider.serviceConnectionFactory) return provider.provider;
          try {
            const material = await registry.resolve(actor, provider.extensionId, reference);
            return provider.serviceConnectionFactory.create({ ...material, validate, fetch: createServiceConnectionFetch({ endpoint: material.endpoint, validate, allowHttp: env.WOOHAA3_SDK_AGENT_ALLOW_HTTP === "1" }) });
          } catch { throw Object.assign(new Error("服务来源执行材料已失效"), { sourceStale: true }); }
        },
      },
      resolveModelSelection: (registry) => {
        // Provider 的模型启用权威来源：`server` 的模型由 Provider 自己的目录决定，
        // 不参与本机运营策略过滤（远端托管生成的新模型不应要求本地再启用一次）。
        const providerAuthority: Record<string, "local" | "server"> = {};
        for (const provider of ctx.generation.list()) {
          providerAuthority[provider.providerId] = provider.selectionAuthority ?? "local";
        }
        const result = resolveGenerationModels({
          registered: registry,
          policy: ctx.generation.policy.snapshot(),
          providerAuthority
        });
        if (!result.ok) return { ok: false, reason: result.reason };
        return {
          ok: true,
          models: result.models.map((model, index) => ({
            modelKey: model.modelKey,
            providerId: model.providerId,
            providerModelId: model.providerModelId,
            modelType: model.modelType as never,
            ...(model.title ? { title: model.title } : {}),
            order: model.order ?? index,
            isDefault: model.isDefault,
            ...(model.taskTimeoutMs !== undefined ? { taskTimeoutMs: model.taskTimeoutMs } : {}),
            ...(model.interaction ? { interaction: model.interaction } : {})
          })),
          defaults: result.defaults as never
        };
      },
      selectionStamp: () => String(ctx.generation.policy.snapshot().revision),
      logger: ctx.log.scope("task")
    });
    ctx.effect(() => () => task.close());
    ctx.provide("task", task);
    const inspectionApi = createTaskInspectionApi({
      accessRuntime: ctx.access.runtime,
      authenticator: ctx.access.authenticator,
      accessEnforcer: ctx.access.accessEnforcer,
      inspection: task.taskInspection((principal) => ctx.access.accessEnforcer.assertAction(principal, TASKS_INSPECT_ACTION)),
      // 产物位置是只读诊断：允许跨后端找（位置本来会随主存储 / 画布归属变化）。
      locate: ({ storageKey, canvasId }) =>
        locateArtifact({
          storage: ctx.storage,
          storageKey,
          ...(canvasId ? { scope: { canvasId } } : {}),
          logger: ctx.log.scope("task")
        })
    });
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.taskInspection, inspectionApi));
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.task, (req, res) => task.handle(req, res)));
    ctx.effect(() => ctx.gateway.readiness(READINESS_ORDER.task, () => task.readiness()));
    // 任务终态进本机遥测（change: 2026-10-20-add-local-client-telemetry，tasks 4.4）：历史仓库每次
    // 写入都会通知，这里只在**第一次**进入终态时 emit 一条；迟到写入不重复计数（`Set` 有界，见上）。
    // 用 `ctx.get` 而不是 `inject`：单独装载 taskPlugin（独立入口/测试）时没有遥测也必须能工作。
    const telemetry = ctx.get("telemetry");
    if (telemetry) {
      const emitted = new Set<string>();
      ctx.effect(() =>
        task.history().subscribe((record) => {
          const result = taskResultOf(record.state);
          if (!result || emitted.has(record.taskKey)) return;
          emitted.add(record.taskKey);
          if (emitted.size > TASK_TERMINAL_DEDUPE_LIMIT) {
            const oldest = emitted.values().next().value;
            if (oldest !== undefined) emitted.delete(oldest);
          }
          const errorCode = taskErrorCodeOf(record.error?.name);
          const occurredAt = Date.parse(record.finishedAt ?? record.updatedAt);
          const durationMs = Number.isFinite(record.durationMs) && record.durationMs >= 0 ? record.durationMs : undefined;
          telemetry.emit({
            name: "task.terminal",
            result,
            origin: "local-host",
            surface: "task",
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(errorCode !== undefined ? { errorCode } : {}),
            // 宿主时间是权威（`received_at` 才用于窗口与保留）；这里带事件的真实终态时刻仅供展示。
            ...(Number.isFinite(occurredAt) && occurredAt > 0 ? { occurredAt } : {}),
            attributes: { provider: record.providerId, ...(record.modelKey ? { model: record.modelKey } : {}) }
          });
        })
      );
    }
    ctx.on("host/ready", () => task.start());
  }
};
