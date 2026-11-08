/**
 * 设置快照里的扩展视图：已安装扩展、受管安装概览、宿主安全模式。
 * 从 `settings/index.ts` 拆出（源码规模门禁 ≤500 行），由它统一 re-export。
 */
import type { PluginIcon } from "../plugin-icon.js";
import type { ExtensionInstallJobView, ExtensionTrust } from "../backend/marketplace.js";
import type { TemporaryHostingCategory, TemporaryHostingRouteView } from "../extension/services/host/exposer.js";

/**
 * 本次启动扫描并装配的扩展（「在场」信息，只读展示）。
 *
 * 启用/停用不在这里：它是站点控制面的 `desiredEnabled`，运行中生效。目录名只表达扩展是否
 * **已安装**（`.` 前缀 = 未安装，沿用扫描语义），不表达「已装但停用」。
 */
export type InstalledExtensionView = {
  id: string;
  label: string;
  description: string;
  /** 扩展所在绝对目录，仅用于展示。 */
  directory: string;
  icon?: PluginIcon;
  /**
   * 扩展声明的版本，设置面按 `v<version>` 展示。
   *
   * 来源按可信程度取值：宿主已加载的可信元数据（站点声明 / provider metadata）> 浏览器产物
   * `artifact-manifest.json` 的 metadata > `package.json`；都没有时缺省（不展示版本）。
   */
  version?: string;
  /** 所在扩展根是否被声明为可写根；只有可写根允许在面板里安装/卸载。 */
  writable: boolean;
  /**
   * 受管扩展（由 Extension Manager 安装在受管根，change: 2026-10-21-add-extension-marketplace-point）。
   * 只有受管扩展在设置面显示卸载 / 回滚 / 来源 / 信任 / 权限；内置根扩展缺省为 false。
   */
  managed?: boolean;
  /** 受管扩展可回滚到的上一版本。 */
  previousVersion?: string;
  /**
   * 同 id 受管版本覆盖的内置版本。仅在受管版本严格高于内置版本时出现；
   * 卸载受管版本后本机回到这个内置版本（能热切换时立即恢复，否则下一次启动）。
   */
  builtinVersion?: string;
  /** 安装来源（`local-file` 或某个市场来源）。 */
  sourceId?: string;
  trust?: ExtensionTrust;
  quarantine?: string;
  /** 含后端代码的受管扩展已提交新版本，需要受控重启后生效。 */
  restartRequired?: boolean;
  /** 观察期截止时间（ISO）；观察期内激活失败或健康连续失败会自动回滚。 */
  observeUntil?: string;

};

/** `/api/settings` 附带的受管安装概览（进行中的任务，供设置面恢复进度）。 */
export type ExtensionInstallationsView = {
  /** `installations.json` 的 revision。 */
  revision: number;
  /** 进行中或最近结束的任务（最多保留最近若干条）。 */
  jobs: ExtensionInstallJobView[];
  /** 本机宿主是否能受控重启（运行在受支持的拉起进程下）；false 时设置面提示「请手动重启」。 */
  restartSupported: boolean;
};

/**
 * 宿主安全模式（change: 2026-10-21-harden-extension-fault-isolation，D7）。
 *
 * `boot-failures`：连续多次未就绪后自动进入；`forced`：`WOOHAA3_SAFE_MODE=1`。`suspended` 是本次未装配的
 * 扩展，它们的站点实际状态为 `suspended`，已保存的启停配置不变。
 */
export type HostSafeModeView = {
  reason: "boot-failures" | "forced";
  /** 进入安全模式的时刻（ISO 8601）。 */
  since: string;
  suspendedCount: number;
  suspended: string[];
  /** 最近一次失败的安全摘要（可能缺省：崩溃进程的诊断不一定留得下来）。 */
  lastFailure?: string;
};

/**
 * 扩展点当前可用的提供者。
 *
 * 设置页据此把「选哪个」渲染成可选项，并把选择直接链到提供者插件的配置——扩展点自己的配置
 * （选谁）与提供者的深配置（桶、密钥、地址）因此能在同一处衔接。
 */
export type SettingExtensionPointProvider = {
  /** 设置值里引用的 id（例如存储的 `backendId`）。 */
  id: string;
  /** 面向用户的显示名；提供者没声明时回退 id。 */
  label: string;
  /** 注册这个能力的插件 id；宿主用它打开对应插件详情。未声明时为 null。 */
  ownerExtensionId: string | null;
  /** 临时图床类别；缺省表示只能手动选择的普通地址提供者。 */
  temporaryCategory?: TemporaryHostingCategory;
};

/** 宿主扩展点的可用提供者；按扩展点分组，新增扩展点时在这里加一段。 */
export type SettingsExtensionPoints = {
  /** 存储后端（`storage.primary` 的可选值）。 */
  storage?: SettingExtensionPointProvider[];
  /** 对外地址提供者（`exposer.primary` 的可选值）。 */
  exposer?: SettingExtensionPointProvider[];
  /** 临时图床的权威路由快照（模式、候选、当前选择与最近真实失败）。 */
  temporaryHosting?: TemporaryHostingRouteView;
};
