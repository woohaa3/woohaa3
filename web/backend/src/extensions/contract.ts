/**
 * 后端应用插件契约（change: 2026-10-06-unify-backend-runtime-with-cordis，任务 3.1–3.3 / design D3/D4；
 *  change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 1.2）。
 *
 * 统一后端进程的 Cordis 宿主声明 `ctx.generation` 等类型化服务；可信后端插件在 activation
 * 内通过 `ctx` 贡献能力、请求处理、后台资源与**生成 Provider**。宿主保证依赖解析、
 * owner-scoped disposer、反序回滚与停用 draining。
 */
import type { HostGenerationService } from "@woohaa3/contracts";

export type {
  ApplicationBackendActivation,
  ApplicationBackendCapabilityRegistration,
  ApplicationBackendConfigFacade,
  ApplicationBackendHandlerRegistration,
  ApplicationBackendHost,
  ApplicationBackendExtensionDefinition,
  ApplicationBackendResource,
  ApplicationBackendWorkFacade,
  ApplicationBackendWorkHandle,
  ApplicationExtensionPrincipal,
  ApplicationExtensionServices,
  ApplicationExtensionTaskAssociation,
  GenerationModelDefinition,
  GenerationProvider,
  GenerationCancelCapability,
  PromptRequirement
} from "@woohaa3/contracts";

/** 生成扩展点 `ctx.generation`：插件注册后可被生成模块（Task 领域）解析。 */
export type GenerationExtension = HostGenerationService;

