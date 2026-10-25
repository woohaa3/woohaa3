import { createSqliteExtensionDocumentStore } from "./repository/extension-document-store.js";
import { createServiceConnectionRegistry, type ServiceConnectionRegistryOptions, type ServiceConnectionRegistry } from "./service-connections/registry.js";
import { createExtensionAssistants } from "./extensions/extension-assistants.js";
import { CanvasCreationStore } from "./repository/canvas-creation-store.js";
import { CanvasCreationService } from "./extensions/canvas-creation-service.js";
/**
 * Application Service composition root
 * （change: 2026-10-05-extract-application-plugin-host，任务 2.1–2.3 / 3.2 / design D1；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.1–1.5 / 3.5）。
 *
 * 独立运行单元：在同一服务端进程组合**统一身份认证**、独立 store、公共 Context（受限服务 facade）、
 * 插件宿主、站点控制面与本地 API。生产站点 HTTP 入口由 ingress 提供：`/api/extensions*`
 * 由本进程处理，其它领域路径代理到独立服务。**不** import 领域服务 composition root，
 * 也不访问其数据库。
 *
 * 企业访问变化要点：类型化基础提供者 registry（identity/site-access/resource-access/
 * resource-lifecycle）；统一执行边界（认证一次 + 具名 action/资源检查）；删除
 * adminToken/shared-secret/本地会话注入。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeAppBasePath,
  type ApplicationExtensionMetadata,
  type MediaMetadata,
  type RequiredProviderProfiles
} from "@woohaa3/contracts";
import { createApplicationBackendExtensionManifest } from "./extensions/manifest.js";
import { createApplicationExtensionHost, type ApplicationExtensionHost } from "./extensions/host.js";
import { createSiteExtensionControlPlane, type SiteExtensionControlPlane } from "./extensions/control-plane.js";
import { createSqliteSiteExtensionConfigStore } from "./extensions/config-store.js";
import { createSqliteExtensionWorkRepository } from "./repository/extension-work-repository.js";
import { openInstanceDataScope, verifiedLegacyInstanceMigration } from "./repository/instance-data-scope.js";
import { createApplicationExtensionApiHandler, type ApplicationExtensionApiHandler } from "./api/extension-api.js";
import { createProviderRequestAuthenticator, type ApplicationRequestAuthenticator } from "./auth/adapter.js";
import { createAccessEnforcer, type AccessEnforcer } from "./extensions/access-enforcement.js";
import {
  createProviderRegistry,
  validateRequiredProviderBootstrap,
  type ProviderRegistry
} from "./extensions/provider-registry.js";
import {
  createApplicationCanvasFacade,
  createApplicationMediaFacade,
  createApplicationTaskFacade
} from "./clients/domain-clients.js";
import {
  resolveApplicationServiceConfig,
  type ApplicationServiceConfig
} from "./config/env.js";
import { createExtensionTaskIntentRepository } from "./repository/extension-task-intent-repository.js";
import { createExtensionTaskRecovery } from "./extensions/task-recovery.js";
import { createSqliteAgentConversationStore } from "./repository/agent-conversation-repository.js";
import { createAgentAdapterRegistry } from "./extensions/agent-adapter-registry.js";
import { candidateAssistantDirectory } from "./extensions/agent-candidate-directory.js";
import { createAgentConnectionRegistry, type AgentConnectionRegistry } from "./extensions/agent-connection-registry.js";
import { createAgentConversationService, type AgentConversationService } from "./extensions/agent-conversation-service.js";
import { createAgentConversationApiHandler, type AgentConversationApiHandler } from "./api/agent-conversation-api.js";
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationExtensionPrincipal,
  ApplicationExtensionServices
} from "./extensions/contract.js";

export type ApplicationServiceOptions = {
  serviceConnectionProviders?: () => readonly import("@woohaa3/contracts").GenerationProvider[];
  serviceConnectionSources?: Omit<ServiceConnectionRegistryOptions, "documents"> & { documents?: ServiceConnectionRegistryOptions["documents"] };

  mediaFormats?: import("@woohaa3/contracts").MediaFormatRegistry;
