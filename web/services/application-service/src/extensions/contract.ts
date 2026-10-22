/**
 * Application 后端插件宿主契约
 * （change: 2026-10-05-extract-application-plugin-host，任务 1.2 / design D2/D3）。
 *
 * 纯类型契约（handler/capability/resource/definition、受限 facade、delegated principal）由
 * `@woohaa3/contracts` 提供；本模块只保留**宿主运行时**的辅助类型与错误，以及需要宿主实现
 * 组装的部分。它 MUST NOT 引入任何下游服务实现。
 */
export {
  AUTH_LEVEL_RANK,
  isAuthLevelAtLeast
} from "@woohaa3/contracts";
export type {
  ApplicationBackendActivation,
  ApplicationBackendCapabilityRegistration,
  ApplicationBackendConfigFacade,
  ApplicationBackendHandlerRegistration,
  ApplicationBackendHttpHandlerRegistration,
  ApplicationBackendRawHttpHandlerRegistration,
  ApplicationBackendHost,
  ApplicationBackendExtensionDefinition,
  ApplicationBackendExtensionHealth,
  ApplicationBackendResource,
  ApplicationBackendWorkAdmission,
  ApplicationBackendWorkFacade,
  ApplicationBackendWorkHandle,
  ApplicationExtensionCanvasFacade,
  ApplicationExtensionHandlerResult,
  ApplicationExtensionHttpHandler,
  ApplicationExtensionHttpMethod,
  ApplicationExtensionHttpRequest,
  ApplicationExtensionHttpResponse,
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse,
  ApplicationExtensionHandlerPurpose,
  ApplicationExtensionMediaFacade,
  ApplicationExtensionPrincipal,
  ApplicationExtensionPublicRouteMapping,
  ApplicationExtensionRequestContext,
  ApplicationExtensionSecretStore,
  ApplicationExtensionServices,
  ApplicationExtensionStreamBudget,
  ApplicationExtensionTaskAssociation,
  ApplicationExtensionTaskFacade,
  ApplicationExtensionTaskSubmitResult,
  ApplicationPrincipal,
  ApplicationUserDelegation,
  ApplicationAuthoringServices,
  ApplicationCanvasAuthoringFacade,
  ApplicationPersonalGenerationFacade
} from "@woohaa3/contracts";
