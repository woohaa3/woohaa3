/**
 * Task Service composition：公开选项与返回类型
 * （自 `composition.ts` 拆出，change: 2026-10-13-add-enterprise-access-and-production-deployment，
 *  规模门禁 ≤500 行；对应 change: 2026-10-09-... R10 计划的 `composition/types.ts`）。
 *
 * 纯类型与依赖声明，不含实现。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PptaskJobRepository } from "@sdppp/pptask";
import type { SqliteTaskStore } from "../repository/sqlite-task-store.js";
import type { SqliteTaskHistoryRepository } from "../repository/history-repository.js";
import type { TaskRuntime } from "../worker/runtime.js";
import type { MediaClient } from "../clients/media-client.js";
import type { PptaskEnvConfig } from "../config/env.js";
import type { ArkVideoImageAsset, ArkVideoImageAssetInput } from "../providers/ark-types.js";
import type { ModelsConfig } from "../config/models-config.js";
import type {
  BackendTaskPort,
  CanvasTaskCatalog,
  PrincipalContext,
  TaskInspectionFacade
} from "@woohaa3/contracts";

export type TaskServiceOptions = {
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  env?: Record<string, string | undefined>;
  modelsConfig: ModelsConfig;
  storePath?: string;
  serviceToken?: string;
  mediaServiceUrl?: string;
  ensureVideoImageAsset?: (input: ArkVideoImageAssetInput) => Promise<ArkVideoImageAsset>;
  mediaClient?: MediaClient;
  jobRepository?: PptaskJobRepository;
  workerServer?: import("@sdppp/pptask-worker-server").PptaskWorkerServer;
  fetchImpl?: typeof globalThis.fetch;
  logger?: (event: Record<string, unknown>) => void;
  historyRetentionDays?: number;
  historyMaxRecords?: number;
  generationProviders?: () => readonly import("@woohaa3/contracts").GenerationProvider[];
  /**
   * 全局 history / 监控查询前授权（change: 2026-10-13-...，任务 3.6/7.5）：统一后端注入
   * `tasks.inspect` 校验；注入后 loopback/服务令牌/operator 用户放行一并失效。
   */
  assertInspect?: (principal: PrincipalContext) => Promise<void>;
  /** 统一入口的可信 principal 解析（与 `assertInspect` 成对注入）。 */
  authenticatePrincipal?: (req: IncomingMessage) => Promise<PrincipalContext | null>;
  resolveModelSelection?: (registry: ReadonlyArray<{ modelKey: string; providerId: string; providerModelId: string; modelType: import("@woohaa3/contracts").CanvasTaskModelType }>) =>
    | { ok: true; models: import("../config/models-config.js").ResolvedModel[]; defaults: Partial<Record<import("@woohaa3/contracts").CanvasTaskModelType, string>> }
    | { ok: false; reason: string };
  /** 运营策略版本戳。只改启用集合时任务目录也要重算。 */
  selectionStamp?: () => string;
};

export type TaskService = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  readiness: () => Promise<{ ready: boolean; reason?: string }>;
  close: () => Promise<void>;
  runtime: () => TaskRuntime | null;
  catalog: () => Promise<CanvasTaskCatalog>;
  /** 任务目录修订（单调，轻量读）：宿主快照透出给浏览器做目录失效。 */
  catalogRevision: () => number;
  history: () => SqliteTaskHistoryRepository;
  /**
   * 受限任务监控 facade（change: 2026-10-13-...，任务 7.4）：宿主注入查询前授权检查。
   */
  taskInspection: (assertAuthorized: (principal: PrincipalContext) => Promise<void>) => TaskInspectionFacade;
  taskStore: () => SqliteTaskStore;
  port: () => BackendTaskPort;
  start: () => void;
};

export type { PptaskEnvConfig };
