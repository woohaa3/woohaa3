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
  /** 移除运行期登记的扩展：有在途工作 → `extension-busy`；启动期清单 → `extension-not-removable`。站点配置保留。 */
  removeExtension: (extensionId: string) => Promise<SiteExtensionRuntimeOutcome>;
  /** 在途工作 lease（供插件 facade / 内部工作接线）。 */
  workLease: (extensionId: string) => ExtensionWorkLease | undefined;
  /** 宿主注入的配置 facade（只读已提交配置；不含秘密值）。 */
  configFacade: (extensionId: string) => ApplicationBackendConfigFacade;
  /** 宿主注入的在途工作 facade（admit/resume/计数）。 */
  workFacade: (extensionId: string) => ApplicationBackendWorkFacade;
  dispose: () => Promise<void>;
};
