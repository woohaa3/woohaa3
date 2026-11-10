/**
 * 站点插件控制面的公开类型（从 control-plane.ts 拆出，源码规模门禁 ≤500 行；由 control-plane.ts 统一 re-export）。
 */
import type {
  ApplicationExtensionMetadata,
  ApplicationExtensionSafeDiagnostic,
  ApplicationExtensionStatus,
  RequiredProviderProfiles
} from "@woohaa3/contracts";
import type { ApplicationBackendExtensionDefinition, ApplicationBackendConfigFacade, ApplicationBackendWorkFacade } from "./contract.js";
import type { ApplicationExtensionHost } from "./host.js";
import type { SqliteSiteExtensionConfigStore } from "./config-store.js";
import type { ExtensionWorkLease, ExtensionWorkReferenceStore } from "./work.js";

export type SiteExtensionControlPlaneError =
  | { ok: false; code: "extension-not-found"; message: string }
  | { ok: false; code: "config-invalid"; message: string }
  | { ok: false; code: "prepare-failed"; message: string }
  | { ok: false; code: "required-provider"; message: string }
  | { ok: false; code: "revision-conflict"; message: string; currentRevision: number }
  | { ok: false; code: "storage-failed"; message: string };

export type SiteExtensionWriteOutcome =
  | { ok: true; revision: number; status: ApplicationExtensionStatus }
  | SiteExtensionControlPlaneError;

export type SiteExtensionQuarantineOutcome =
  | { ok: true; revision: number; status: ApplicationExtensionStatus; changed: boolean }
  | { ok: false; code: "extension-not-found"; message: string };

/** 运行期登记 / 移除的结果（control-plane-runtime.ts）。 */
export type SiteExtensionRuntimeOutcome =
  | { ok: true; revision: number; status?: ApplicationExtensionStatus }
  | { ok: false; code: "extension-exists" | "extension-invalid" | "extension-not-found" | "extension-not-removable"; message: string }
  | { ok: false; code: "extension-busy"; message: string; activeWorkCount: number };

export type SiteExtensionMetadataSource = {
  list: () => readonly ApplicationExtensionMetadata[];
  get: (extensionId: string) => ApplicationExtensionMetadata | undefined;
};

export type SiteExtensionControlPlaneOptions = {
  host: ApplicationExtensionHost;
  store: SqliteSiteExtensionConfigStore;
  workStore: ExtensionWorkReferenceStore;
  metadata: SiteExtensionMetadataSource;
  /** 构建时可信后端入口（按 extensionId 静态登记；生产/测试清单不同）。 */
  definitions: readonly ApplicationBackendExtensionDefinition[];
  /**
   * 可信部署 profile 里必需基础提供者（按 extensionId）。用于拒绝在线停用必需 provider
   * （change: 2026-10-13-...，任务 1.5）：必需提供者只能经发布/重启更新，不能由站点控制面关闭。
   */
  requiredProviders?: RequiredProviderProfiles;
  /**
   * 候选配置校验：返回 null 表示通过，否则为安全错误信息。
   * 由插件 config schema owner 提供；缺省接受任意已校验 JSON。
   */
  validateConfig?: (extensionId: string, values: Record<string, unknown>, metadata: ApplicationExtensionMetadata) => string | null;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
  /**
   * 单次版本激活的时限（毫秒，按调用现取；change: 2026-10-21-harden-extension-fault-isolation，D4）。
   * 超时记为 failed / `activation-timeout`，不自动重试；迟到的成功实例立即释放。缺省 30s。
   */
  activationTimeoutMs?: () => number;
  /**
   * 安全模式下被暂停的扩展（D7）：不激活、不改写 desiredEnabled，实际状态投影为 `suspended`。
   */
  suspended?: ReadonlySet<string>;
  /**
   * 扩展启停的事实来源（配置文件 `extensions.<id>.enabled`）。
   *
   * 提供时启停读它、写它也走它；不提供时回退到 SQLite 里的 `desiredEnabled`
   * （兼容旧部署与测试）。这是把「启停」从站点配置表里解耦出来的唯一接缝。
   */
  toggles?: ExtensionToggleStore;
};

/** 扩展启停的读写口：实现了它，启停就不再依赖站点配置表。 */
export type ExtensionToggleStore = {
  /** 全部显式声明的启停；未出现的 ID 由 manifest 的 `defaultEnabled` 决定（未声明 = 停用）。 */
  all(): Readonly<Record<string, boolean>>;
  /** 写一个扩展的启停；失败如实上报（配置文件写入可能被权限或语法问题挡住）。 */
  set(extensionId: string, enabled: boolean): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * 订阅启停变化（配置文件被手工编辑、或其它客户端写入）。
   *
   * 返回退订函数。控制面收到通知后自行 reconcile——否则「改了配置但没人激活」会让
   * 状态永远停在 configuring。可选：不实现时只有显式写入路径会触发 reconcile。
   */
  subscribe?(listener: () => void): () => void;
  /**
   * 扩展自己的配置值（配置文件 `extensions.<id>.*` 去掉 `enabled`）。
   *
   * 缺省返回空对象（旧部署与测试）。配置值的 schema 由扩展自己的 `Config` 解释，
   * 控制面只做透传，不在这里二次校验。
   */
  values?(extensionId: string): Record<string, unknown>;
};

export type SiteExtensionControlPlane = {
  /** 公开 snapshot：全部已配置插件 + 实际状态（不含秘密）。 */
  snapshot: () => { revision: number; catalog: Array<{ extensionId: string; name: string; description: string; version: string; directory?: string }>; plugins: ApplicationExtensionStatus[] };
  /** 有界增量：cursor 过旧时 resyncRequired。 */
  changes: (after: number) => { revision: number; changes: Array<{ revision: number; extensionId: string; status: ApplicationExtensionStatus }>; resyncRequired: boolean };
  /** 单插件状态（含未配置插件）。 */
  status: (extensionId: string) => ApplicationExtensionStatus | undefined;
  /** 带 expectedRevision 的管理写入。 */
  write: (input: { extensionId: string; expectedRevision: number; enabled: boolean; values: Record<string, unknown>; secretRefs: string[]; actor: string }) => Promise<SiteExtensionWriteOutcome>;
  /** 进程启动/重启后依据已提交版本重建实际状态（commit 后崩溃的恢复路径）。 */
  reconcile: () => Promise<void>;
  /**
   * 首次 reconcile 中必需提供者（`requiredProviders`）已协调完毕（D5）。可选扩展此时可能仍在
   * configuring：宿主就绪只等这一步，不等可选扩展激活完成。
   */
  requiredReconciled: () => Promise<void>;
  /**
   * 崩溃熔断（change: 2026-10-21-isolate-extension-host-process，D7）：把扩展置为 `quarantined`。
   * 释放 public 实例、不改写 desiredEnabled、写审计并推进 revision；已隔离时幂等（不再写审计）。
   * 隔离期间的配置提交照常落库但不激活；重启后仍保持隔离（审计是事实源）。
   */
  quarantine: (extensionId: string, diagnostic?: Partial<ApplicationExtensionSafeDiagnostic>, actor?: string) => Promise<SiteExtensionQuarantineOutcome>;
  /** 解除隔离：写审计并推进 revision，随后按 desiredEnabled 重新协调该扩展。未隔离时幂等。 */
  unquarantine: (extensionId: string, actor?: string) => Promise<SiteExtensionQuarantineOutcome>;
  /**
   * 运行期登记一个扩展（首次安装的受管后端扩展）：只对它协调一次。同 id 已登记 → `extension-exists`。
   * 详见 control-plane-runtime.ts。
   */
  addExtension: (input: { metadata: ApplicationExtensionMetadata; definition: ApplicationBackendExtensionDefinition }) => Promise<SiteExtensionRuntimeOutcome>;
  /**
   * 同 id 换版（市场版本覆盖内置版本、受管扩展升级、回滚、开发者模式重装）：元数据覆盖原来那一行、
   * 定义换成新目录工厂，释放旧实例后按当前配置重新协调。未登记 → `extension-not-found`；
   * 有在途工作 → `extension-busy`。
   */
  replaceExtension: (input: { metadata: ApplicationExtensionMetadata; definition: ApplicationBackendExtensionDefinition }) => Promise<SiteExtensionRuntimeOutcome>;
  /**
   * 移除一个扩展：有在途工作 → `extension-busy`。
   *
   * **可移除性由元数据的 `origin` 决定，不由「什么时候登记的」决定**：只有 `builtin`（随客户端发布的
   * 内置根）不可移除（`extension-not-removable`）；`managed` / `dev` / `writable` 都可以卸载，
   * 包括那些因为装过一次、重启后被扫进启动期清单的受管扩展。站点配置与审计一律保留。
   */
  removeExtension: (extensionId: string) => Promise<SiteExtensionRuntimeOutcome>;
  /** 在途工作 lease（供插件 facade / 内部工作接线）。 */
  workLease: (extensionId: string) => ExtensionWorkLease | undefined;
  /** 宿主注入的配置 facade（只读已提交配置；不含秘密值）。 */
  configFacade: (extensionId: string) => ApplicationBackendConfigFacade;
  /** 宿主注入的在途工作 facade（admit/resume/计数）。 */
  workFacade: (extensionId: string) => ApplicationBackendWorkFacade;
  dispose: () => Promise<void>;
};
