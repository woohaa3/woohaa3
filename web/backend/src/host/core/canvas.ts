import path from "node:path";
import {ScenePackageService} from "../../scene-package/service.js";
import {createScenePackageHandler} from "../../scene-package/http.js";
import {readStorePath} from "../../composition/config.js";
import { mergeCanvasContentRuntimes } from "../../extensions/canvas-content.js";
/**
 * 核心层 · canvas：画布、Yjs 同步与画布侧 MCP 服务。
 *
 * application 在 canvas 之后装载，而 canvas 要读它的来源注册表与「转为片场」转换能力，
 * 所以这两处在调用时经 `ctx.get("application")` 懒取，不进 `inject`。
 */
import type { CanvasContentRuntime, FilmSetConversionProvider } from "@woohaa3/contracts";
import { isFilmSetConversionCapabilityId, isFilmSetConversionProviderShape } from "@woohaa3/contracts";
import {
  isCanvasUpstreamCapabilityId,
  isCanvasUpstreamProviderShape,
  type CanvasUpstreamProvider
} from "@woohaa3/contracts";
import { createCanvasService } from "@woohaa3/canvas-service";
import type { CanvasMediaAssetSyncPort } from "@woohaa3/canvas-service";
import { currentCanvasGroupScope } from "@woohaa3/canvas-service";
import { createCanvasMediaBackfill } from "./canvas-media-backfill.js";
import { createCanvasStorageOwnership, resolveCanvasOwnershipPath } from "./canvas-storage-ownership.js";
import { createHostRecordingService } from "../../recording-executor/assembly.js";
import type { HostContext, HostPlugin } from "../context.js";
import type { LoadedExtensionHost } from "../../extensions/manifest.js";
import { READINESS_ORDER, ROUTE_ORDER } from "../order.js";
import { canvasStorageOptions } from "../../extensions/slot-contract.js";
import { parseAllowedOrigins } from "../../composition/config.js";
import { mediaPortToCanvasMediaClient, taskPortToCanvasTaskClient } from "../../ports/adapters.js";
import { createCanvasSourceBridge } from "../../ports/canvas-sources.js";
import { createCanvasSubjectResolver } from "../../ports/canvas-subject.js";
import { createAssistantDeliveryPort } from "../../ports/assistant-delivery.js";

/**
 * 「转为片场」转换提供方：扩展层经 `ctx.generation.registerConversion` 注册的，加上站点插件宿主上
 * 以 capability 声明的；同一 providerId 只取先出现的那个。宿主不按业务 ID 分支。
 */
function filmSetConversionProviders(ctx: HostContext): readonly FilmSetConversionProvider[] {
  const providers: FilmSetConversionProvider[] = [];
  const seen = new Set<string>();
  const add = (provider: FilmSetConversionProvider) => {
    if (seen.has(provider.providerId)) return;
    seen.add(provider.providerId);
    providers.push(provider);
  };
  for (const provider of ctx.generation.conversions()) add(provider);
  const host = ctx.get("application")?.service.host();
  if (host) {
    const capabilities = new Set<string>();
    for (const registration of host.snapshot()) {
      for (const id of registration.capabilities) {
        if (!isFilmSetConversionCapabilityId(id) || capabilities.has(id)) continue;
        capabilities.add(id);
        const value = host.resolveCapability(id);
        if (isFilmSetConversionProviderShape(value)) add(value);
      }
    }
  }
  return providers;
}

/**
 * 解析同步上游凭据提供者（`canvas-upstream:<id>` capability）。
 *
 * 按**声明**扫描，不认识具体扩展 id：任何扩展只要注册这个 capability 就能接管同步上游。
 * 多个提供者时取第一个可用者（顺序由 capability 快照给出）；没有则返回 null，画布保持
 * 纯本地——「没接远端」是正常形态，不是错误。静态 `canvas.syncUpstream.*` 配置已移除。
 *
 * **解析必须延迟到每次调用**：canvas 在 application 之前装载，apply 时 `ctx.get("application")`
 * 还不存在（Cordis 的 `get` 是即时查表），早解析会把「之后才激活/登录的远端」永久锁成 null。
 * 因此这里返回的来源每次 `resolve()` 都重新扫描 capability 快照；扩展登录/登出后经
 * `CanvasService.refreshUpstream()`（或启动完成的 `host/ready`）触发重新解析。
 */
function resolveUpstreamCredential(ctx: HostContext): import("@woohaa3/canvas-service").SyncUpstreamCredentialSource {
  const log = ctx.log.scope("canvas");
  const provider = (): CanvasUpstreamProvider | null => {
    const host = ctx.get("application")?.service.host();
    if (!host) {
      log({ event: "canvas-upstream-provider-missing", level: "warn", reason: "application 宿主不可用" });
      return null;
    }
    const seen = new Set<string>();
    // 命中失败必须留下证据：返回 null 的后果是「画布静默保持纯本地」，
    // 没有这两项计数就分不清「扩展没注册 capability」与「注册了但形状不合格」
    // （2026-10-26 现场：整条上传链路不存在，日志里一条线索都没有）。
    let registrations = 0;
    let capabilities = 0;
    for (const registration of host.snapshot()) {
      registrations += 1;
      for (const id of registration.capabilities) {
        if (!isCanvasUpstreamCapabilityId(id)) continue;
        capabilities += 1;
        if (seen.has(id)) continue;
        seen.add(id);
        const value = host.resolveCapability(id);
        if (isCanvasUpstreamProviderShape(value)) return value as CanvasUpstreamProvider;
        log({ event: "canvas-upstream-provider-invalid", level: "warn", code: id });
      }
    }
    // 纯本地部署是正常形态（没装接入扩展），因此用 debug：真正的告警在画布侧
    // （`sync-upstream-unresolved`：归属远端却拿不到链路）。
    log({
      event: "canvas-upstream-provider-missing",
      level: "debug",
      reason: `没有可用的 canvas-upstream 提供者（注册 ${registrations}，候选 ${capabilities}）`
    });
    return null;
  };
  return {
    async resolve(canvasId: string) {
      const current = provider();
      // 没有提供者 = 这次不接管，画布保持本地（不是失败）。
      // 有提供者时**按画布**问一次：远端只接管「已在远端」或「用户显式启用同步」的画布，
      // 其余本地画布保持纯本地（登录不等于上传）。
      return current ? current.resolve(canvasId) : null;
    },
    // 只给宿主日志/诊断用，不含令牌。
    describe: () => provider()?.describe?.() ?? "未接入远端"
  };
}

/**
 * 解析远端**目录**来源（与 `canvas-upstream` 同一组 capability）。
 *
 * provider 只提供内容同步时没有 `listCanvases`，此时目录里保持纯本地；提供时它成为
 * 追加来源，本机与远端取并集。每个 provider 对应一个来源，来源名用 `describe()`
 * （不含地址与令牌）。
 */
function resolveCatalogSources(
  ctx: HostContext
): readonly import("@woohaa3/canvas-service").CanvasCatalogRemoteSource[] {
  const sources: import("@woohaa3/canvas-service").CanvasCatalogRemoteSource[] = [];
  const host = ctx.get("application")?.service.host();
  if (!host) return sources;
  const seen = new Set<string>();
  for (const registration of host.snapshot()) {
    for (const id of registration.capabilities) {
      if (!isCanvasUpstreamCapabilityId(id) || seen.has(id)) continue;
      seen.add(id);
      const value = host.resolveCapability(id);
      if (!isCanvasUpstreamProviderShape(value)) continue;
      const provider = value as CanvasUpstreamProvider;
      if (typeof provider.listCanvases !== "function") continue;
      const list = provider.listCanvases.bind(provider);
      // 链接分享的入口：按 id 取一张不在目录里的画布摘要。provider 没有这个能力时
      // 只保留目录合并——来源仍然可用，只是打不开「链接里有、目录里没有」的画布。
      const get = typeof provider.getCanvas === "function" ? provider.getCanvas.bind(provider) : null;
      // 内容权限的入口：provider 没有这个能力时，画布打开时只能看到"未知"权限
      // （按可写处理），只读提示会退回链路状态那条路径。
      const access = typeof provider.access === "function" ? provider.access.bind(provider) : null;
      sources.push({
        id: `remote:${provider.providerId}`,
        label: provider.describe?.() ?? provider.providerId,
        list: () => list(),
        ...(get ? { get: (canvasId: string) => get(canvasId) } : {}),
        ...(access ? { access: (canvasId: string) => access(canvasId) } : {})
      });
    }
  }
  return sources;
}

/**
 * 解析远端**删除**端口（与 `canvas-upstream` 同一组 capability）。
 *
 * 删除顺序由画布服务决定（远端在前、本机在后）；这里只按声明找到第一个提供 `deleteCanvas`
 * 的 provider。没有提供者 / 没有注册时就返回 `skipped`，纯本地部署行为不变。
 *
 * **每次调用现查**：与目录来源同理，扩展可能在 canvas 装载之后才激活或登录。
 */
function resolveRemoteDelete(
  ctx: HostContext
): (canvasId: string) => Promise<import("@woohaa3/contracts").CanvasUpstreamDeleteResult> {
  const log = ctx.log.scope("canvas");
  return async (canvasId) => {
    const host = ctx.get("application")?.service.host();
    if (!host) return "skipped";
    const seen = new Set<string>();
    for (const registration of host.snapshot()) {
      for (const id of registration.capabilities) {
        if (!isCanvasUpstreamCapabilityId(id) || seen.has(id)) continue;
        seen.add(id);
        const value = host.resolveCapability(id);
        if (!isCanvasUpstreamProviderShape(value)) continue;
        const provider = value as CanvasUpstreamProvider;
        if (typeof provider.deleteCanvas !== "function") continue;
        try {
          return await provider.deleteCanvas(canvasId);
        } catch {
          // 契约要求不得抛错；真抛了也只当作「这次远端删不掉」，绝不越过它去删本机。
          log({ event: "canvas-remote-delete-threw", level: "warn", code: id });
          return "unavailable";
        }
      }
    }
    return "skipped";
  };
}

export const canvasPlugin: HostPlugin<{
  env: Record<string, string | undefined>;
  enableYjsSync?: boolean;
  /** 启动期扩展宿主：用于加载 `canvasContent` 声明的画布内容端口。 */
  extensionHost?: LoadedExtensionHost;
}> = {
  name: "canvas",
  inject: ["log", "gateway", "access", "config", "media", "task", "generation"],
  async apply(ctx, { env, enableYjsSync, extensionHost }) {
    // 画布内容聚合端口（预览/历史帧 + 转片场）：由扩展声明驱动，canvas-service 只认识契约接口。
    const contentRuntime: CanvasContentRuntime | undefined = extensionHost?.createCanvasContent
      ? mergeCanvasContentRuntimes(await extensionHost.createCanvasContent({}))
      : undefined;
    const mediaRead = ctx.media.port().resources?.read;
    // bootstrap `storage` 槽位（扩展目录的存储实现）已装配时，画布存储**只借**它持有的连接与
    // 已解析配置；未装配时传 undefined，画布服务按本进程环境变量自行解析（独立入口行为不变）。
    const foundationStorage = ctx.access.foundationStorage;
    // 资源授权运行时只在**访问控制已启用**且装配了 ResourceAccessPolicy 时接管入口：
    // 本地单实例（accessRuntime.enabled=false）保持历史 loopback 边界，不把「未配置 ACL」解释成 503。
    const accessBoundary = ctx.access.runtime.enabled && ctx.access.providers.resourceAccessPolicy() !== null;
    // 原生录制服务：无执行器通道或扩展未声明 recording 端口时为 null（路由给 503）。
    // 它需要 canvas-service 的权威房间，因此在 createCanvasService 之后装配。
    let recordingService: Awaited<ReturnType<typeof createHostRecordingService>> = null;
    // 「画布归属远端存储」的持久记录：存储路由在画布服务之外按它选后端，所以必须在这里
    // 落盘，进程重启后仍能回答「这张画布的字节在托管存储里」——否则重启到房间 attach 之间
    // 的读取会回落本地，把远端生成成功的产物固化成失败终态。
    const ownership = createCanvasStorageOwnership({
      filePath: resolveCanvasOwnershipPath(env),
      logger: ctx.log.scope("canvas-ownership")
    });
    ctx.effect(() => () => ownership.close());
    // 画布服务构造期还拿不到自身实例：补传端口先占位，实例就绪后接上。
    let assetSync: CanvasMediaAssetSyncPort | undefined;
    const mediaAssetSync: CanvasMediaAssetSyncPort = {
      run: (canvasId, runOptions) => assetSync?.run(canvasId, runOptions),
      stateOf: (canvasId) => assetSync?.stateOf(canvasId)
    };

    const canvas = await createCanvasService({
      // Skill 媒体续接（change: 2026-10-28-add-agent-skill-media-regeneration）：
      // begin 前用 Application ledger 复核当前 attempt；任务终态只回写该 attempt 的历史。
      // application 在本插件之后装载，因此两处都在调用时懒取。
      skillAttempts: () => {
        const media = ctx.get("application")?.service.skillMedia();
        if (!media) return undefined;
        return {
          assertCurrent: (input: {
            owner?: string;
            canvasId: string;
            nodeId: string;
            runId: string;
            skill: import("@woohaa3/contracts").SkillMediaRunRef;
          }) =>
            media.assertCurrent({
              owner: input.owner ?? currentCanvasGroupScope()?.owner ?? env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "",
              canvasId: input.canvasId,
              nodeId: input.nodeId,
              runId: input.runId,
              skill: input.skill
            })
        };
      },
      onRunSettled: (record: import("@woohaa3/canvas-service").PptaskExecutionRecord) => {
        const media = ctx.get("application")?.service.skillMedia();
        if (!media) return;
        media.settleFromRun({
          canvasId: record.canvasId,
          nodeId: record.nodeId,
          runId: record.runId,
          jobId: record.jobId,
          state: record.status,
          ...(record.output?.mediaKind ? { mediaKind: record.output.mediaKind } : {}),
          ...(record.error ? { error: record.error } : {}),
          terminalAt: record.terminalAt
        });
      },
      assistantTextRuns: {
        run: (input: Parameters<import("@woohaa3/contracts").AssistantTextRunGateway["run"]>[0]) => ctx.get("application")!.service.assistantTextRuns().run(input),
        status: (input: Parameters<import("@woohaa3/contracts").AssistantTextRunGateway["status"]>[0]) => ctx.get("application")!.service.assistantTextRuns().status(input),
        cancel: (input: Parameters<import("@woohaa3/contracts").AssistantTextRunGateway["cancel"]>[0]) => ctx.get("application")!.service.assistantTextRuns().cancel(input),
      },
      env,
      ...(foundationStorage ? canvasStorageOptions(foundationStorage) : {}),
      ...(accessBoundary
        ? {
            // 统一入口资源授权（change: 2026-10-13-...，任务 4.4/6.1/6.2/6.5）：HTTP native 与 WS 都用
            // 同一 identity provider + ResourceAccessPolicy 判定。`{ enabled: true }` 表示由可信
            // principal 接管，禁用历史「loopback 即信任」边界。
            accessRuntime: ctx.access.runtime,
            authenticate: ctx.access.authenticator,
            resourceAccessPolicy: () => ctx.access.providers.resourceAccessPolicy(),
            resourceLifecyclePolicy: () => ctx.access.providers.resourceLifecyclePolicy(),
            resourceDirectory: () => ctx.access.providers.resourceDirectory()
          }
        // 后台转换也必须知道本地模式显式关闭了 ACL；省略 runtime 会走默认拒绝。
        : ctx.access.runtime.enabled ? {} : { accessRuntime: ctx.access.runtime }),
      // WS Origin 门禁（任务 2.4）：允许列表与 HTTP 侧 `parseAllowedOrigins` 同一来源；
      // 空列表表示本机部署不校验跨源（与历史一致）。
      syncAllowedOrigins: parseAllowedOrigins(env),
      taskClient: taskPortToCanvasTaskClient(ctx.task.port()),
      mediaClient: mediaPortToCanvasMediaClient(ctx.media.port()),
      resolveCatalog: () => ctx.task.catalog(),
      canvasSources: createCanvasSourceBridge({
        registry: () => ctx.get("application")?.sourceRegistry ?? null,
        logger: ctx.log.scope("canvas-source-bridge")
      }),
      // 主体只来自宿主统一认证器（不信任请求 body 的 staffId/ownerId）；本地单实例返回实例 owner。
      canvasSubjectResolver: createCanvasSubjectResolver(ctx.access.authenticator),
      // 扩展登录远端后接管同步上游（按 capability 声明解析；无提供者时为 null，行为不变）。
      upstreamCredential: resolveUpstreamCredential(ctx),
      // 归属的持久记录：解析到远端配置时写一条，宿主重启后存储路由仍能选对后端。
      upstreamOwnership: ownership.store,
      // 画布连上远端的那一刻：把存量资产补传到服务端托管存储（第二台设备才看得到）。
      onCanvasUpstreamLinked: (canvasId: string) => mediaAssetSync.run(canvasId),
      // 目录徽标通过它把「文档已同步、媒体仍在传/失败」表达成 syncing/failed。
      mediaAssetSync,
      // 目录来源：与同步上游同一份接入的另一个面。接入时本机与远端两个来源都生效。
      //
      // **传函数而不是数组**：canvas 在 application 之前装载，这里执行时 `ctx.get("application")`
      // 还不存在、扩展也还没激活——当场求值只会得到空数组，于是「接上服务端却看不到服务端
      // 已有的画布」。与 `upstreamCredential` 同口径：每次列举目录时现查一次 capability。
      catalogSources: () => resolveCatalogSources(ctx),
      // 远端删除：属于远端的画布先在服务端删掉，否则本机删完又会被目录拉回来。
      deleteRemote: resolveRemoteDelete(ctx),
      ...(contentRuntime ? { contentRuntime } : {}),
      filmSetConversionProviders: () => filmSetConversionProviders(ctx),
      filmSetConversionExecution: createAssistantDeliveryPort(() => {
        const service = ctx.get("application")?.service.agentConversations();
        if (!service) throw new Error("助手会话服务尚未就绪");
        return service;
      }, () => filmSetConversionProviders(ctx)),
      // owner 规则归提供方：宿主只把可信主体与本次 Cookie 转交，第一个给出结果的提供方生效。
      filmSetConversionOwnerResolver: (input: { principal?: unknown; cookie?: string }) => {
        for (const provider of filmSetConversionProviders(ctx)) {
          const resolved = provider.resolveOwner?.(input);
          if (resolved) return resolved;
        }
        return null;
      },
      ...(mediaRead ? { filmSetConversionMediaRead: mediaRead } : {}),
      ...(enableYjsSync !== undefined ? { enableYjsSync } : {}),
      logger: ctx.log.scope("canvas"),
      // 录制端口先占位：服务实例在 canvas 创建后装配（需要房间），用 getter 延迟读取。
      get recording() {
        return recordingService ?? undefined;
      }
    } as never);
    recordingService = await createHostRecordingService({
      contentRuntime,
      canvas,
      media: ctx.media.port(),
      executor: ctx.get("recordingExecutor") ?? null,
      logger: ctx.log.scope("recording")
      // 活动浮层由**前端**从状态查询派生并发 `extension.activity.updated`
      // （该事件属于 UI scope；宿主进程没有这条总线）。
    });
    assetSync = createCanvasMediaBackfill(ctx, async (canvasId) => {
      const service = canvas.composition?.service;
      if (!service) throw new Error("画布存储未启用");
      return service.getCanvas(canvasId);
    });
    const scenePackages = canvas.scenePackages && !ctx.access.runtime.enabled
      ? new ScenePackageService({store:canvas.scenePackages,directory:path.join(path.dirname(readStorePath(env)),"scene-packages"),importMedia:input=>ctx.media.port().importBytes(input),verifyMedia:async(key,expected,canvasId)=>{const result=await ctx.media.port().verify(key,expected,{canvasId});return result.exists&&result.matches;}}) : null;
    const packageHandler=createScenePackageHandler(scenePackages);
    ctx.effect(()=>ctx.gateway.route(ROUTE_ORDER.canvas-1,packageHandler));
    ctx.effect(() => async () => {await scenePackages?.close();await canvas.close();});
    ctx.provide("canvas", canvas);
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.canvas, (req, res) => canvas.handle(req, res)));
    ctx.effect(() => ctx.gateway.readiness(READINESS_ORDER.canvas, () => canvas.readiness()));
    const sync = canvas.sync;
    if (sync) {
      ctx.effect(() => ctx.gateway.upgrade((req, socket, head) => (sync.matches(req.url ?? "") ? sync.handle(req, socket, head) ?? true : false)));
    }
    // 装载完成后再解析一次上游：扩展宿主（application）在 canvas 之后才装载，
    // 重启后恢复的扩展会话也只有到 `host/ready` 才读得到。运行中登录/登出由扩展显式
    // 调用 `CanvasService.refreshUpstream()` 触发，不轮询。
    ctx.on("host/ready", () => {
      void canvas.refreshUpstream().catch(() => undefined);
    });
  }
};
