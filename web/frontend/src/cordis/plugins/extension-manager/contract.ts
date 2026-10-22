/**
 * Plugin Manager 共享契约
 * （change: add-frontend-plugin-manager，design D1/D4/D5）。
 *
 * 纯类型：清单展示元数据、面板视图模型与插件注入点。不 import React/DOM，避免
 * `canvas-manifest` 与 Plugin Manager Plugin 之间形成运行时循环依赖。
 */
import type { PluginIcon } from "@woohaa3/contracts";

/** 纯展示元数据（Plugin Manager 的权威目录；不实例化任何 Plugin）。 */
export type CanvasExtensionMetadata = {
  /** 部署侧提供的所在目录，仅用于展示。 */
  directory?: string;
  id: string;
  name: string;
  description: string;
  required: boolean;
  /** 是否为用户可配置的 optional Plugin。 */
  configurable: boolean;
  /** 插件声明的图标：语义图形名或品牌图形路径；未声明时设置页回退通用插件图标。 */
  icon?: PluginIcon;
};

/** 面板一行的展示状态。 */
export type ExtensionManagerRowStatus =
  | "active"
  | "disabled"
  | "failed"
  | "pending-enable"
  | "pending-disable";

export type ExtensionManagerViewRow = {
  /** 部署侧提供的所在目录，仅用于展示。 */
  directory?: string;
  id: string;
  name: string;
  description: string;
  required: boolean;
  configurable: boolean;
  status: ExtensionManagerRowStatus;
  /** 插件声明的图标；未声明时设置页回退通用插件图标。 */
  icon?: PluginIcon;
};

/** 面板只读快照。 */
export type ExtensionManagerView = {
  rows: ExtensionManagerViewRow[];
  /** 站点插件行（服务端权威状态；change: 2026-10-04-add-backend-plugin-extensions）。 */
  siteRows: ExtensionSiteRow[];
  /** 生成模型行（服务端权威策略；change: 2026-10-04-add-runninghub-and-extensionize-litellm）。 */
  modelRows: ExtensionModelRow[];
  /** 站点写操作是否可用（管理员授权）。 */
  siteManageable: boolean;
  /** 站点状态同步错误（安全文案）；无错误为 null。 */
  siteError: string | null;
  /** 目标状态与本次启动实际装配是否不一致（存在待生效变更）。 */
  pending: boolean;
  /** 持久化降级原因（读取/写入失败或存储不可用）；无问题时为 null。 */
  persistenceMessage: string | null;
  /** 最近一次操作错误（不含底层原始数据）；无错误时为 null。 */
  error: string | null;
};

/** 面板能力（由 Plugin Manager Plugin 提供，Dialog renderer 消费）。 */
export type ExtensionManagerFacade = {
  getSnapshot(): ExtensionManagerView;
  subscribe(listener: () => void): () => void;
  /** 写入一个可配置 optional 插件的浏览器本地目标状态（不改变当前 Fiber；下次启动生效）。 */
  setEnabled(id: string, enabled: boolean): void;
  /** 触发刷新应用（生产实现为页面 reload）。 */
  refresh(): void;
  /** 写入一个站点应用插件的目标配置（服务端权威；运行中生效，仅管理员可用）。 */
  setSiteEnabled(id: string, enabled: boolean): void;
  /** 站点插件的实际状态（不含秘密；由服务端状态同步）。 */
  siteRows(): ExtensionSiteRow[];
  /** 站点操作是否可用（管理员授权）。 */
  canManageSite(): boolean;
  /** 生成模型行（服务端权威策略）。 */
  modelRows(): ExtensionModelRow[];
  /** 启用/停用一个生成模型（仅管理员）。 */
  setModelEnabled(modelKey: string, enabled: boolean): void;
  /** 一次启用或关闭一批模型（仅管理员）。 */
  setModelsEnabled(modelKeys: readonly string[], enabled: boolean): void;
  /** 重新拉取生成模型策略（发现新模型后立刻看到现状）。 */
  refreshModels(): Promise<void>;
  /** 设置某类型的默认生成模型（仅管理员）。 */
  setModelDefault(modelKey: string, modelType: string): void;
};

/**
 * 生成模型管理行（change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.1）。
 *
 * `executable` 表示 Provider 注册表中可执行；策略可包含不可执行的占位/历史模型。
 *
 * `extensionId` 是可选补充（旧宿主没有）：设置页用它把模型归到插件卡片（「服务端接入」这类
 * Provider 没有 `providers.<id>` 配置段，按 providerId 匹配不到）。
 */
export type ExtensionModelRow = {
  modelKey: string;
  providerId: string;
  modelType: string;
  title: string;
  enabled: boolean;
  isDefault: boolean;
  executable: boolean;
  tombstone: boolean;
  /** 提供该模型的宿主插件 id；旧宿主的策略历史行没有。 */
  extensionId?: string;
};

/**
 * 站点插件面板行（change: 2026-10-04-add-backend-plugin-extensions，任务 4.2）。
 *
 * `actualState` 来自服务端权威状态；面板不得从本地布尔值推导后端可用性。
 */
export type ExtensionSiteRow = {
  /** 部署侧提供的所在目录，仅用于展示。 */
  directory?: string;
  extensionId: string;
  name: string;
  description: string;
  desiredEnabled: boolean;
  actualState: string;
  /** 面向用户的实际状态说明（含 draining/failed 等）。 */
  actualStateLabel: string;
  /** 安全诊断（不含秘密）；无诊断为空数组。 */
  diagnostics: string[];
  /** 该行是否处于进行中/异常（用于样式与只读提示）。 */
  busy: boolean;
  /**
 * 该站点插件是 Provider 类插件（声明了 `providers.<providerId>` 配置段）：它的启停不列在
 * 「站点插件」清单里，而是和配置一起出现在设置页「插件配置」的 Provider 卡片上。
 */
  providerManaged: boolean;
  /** 发布 metadata 声明的图标；站点服务端摘要不含图标，拿不到时回退通用插件图标。 */
  icon?: PluginIcon;
};
