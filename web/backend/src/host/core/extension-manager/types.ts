/**
 * Extension Manager 依赖的包工具（change: 2026-10-21-add-extension-marketplace-point，D4/D6/D7）。
 *
 * 实现在仓库的 `scripts/lib/extension-package.mjs` / `extension-installations.mjs` /
 * `extension-descriptor.mjs` 与 `scripts/extensions-preflight.mjs`（与 `pnpm extensions:check` 同一份逻辑）；
 * 后端打包入口不能静态 import 仓库根脚本，因此运行期按路径加载（见 `toolkit.ts`），测试注入替身。
 * 所有失败都以带 `code` 的错误抛出，`code` 取 `MARKETPLACE_FAILURE_CODES`。
 */
import type { AnyExtensionPlugin, ExtensionEngines, ExtensionTrust } from "@woohaa3/contracts";

export type TrustedKey = { keyId: string; publicKey: string };

/**
 * 内置根里与市场版本可比较的扩展（dev / release / 桌面宿主都从同一份扫描结果生成）。
 *
 * - `version` 是**分发版本**（`extension.json.version` 优先，否则 `package.json.version`），
 *   与 `pack:extension` 打进 `.wxt` 的版本是同一个口径；
 * - `requiresBackend` / `hotSwappable` 用来决定同 id 受管版本能否覆盖内置版本：
 *   纯前端或 hostPlugin 可以在运行期切换；站点后端（`backend`）暂不支持覆盖升级。
 */
export type BuiltinExtension = {
  extensionId: string;
  version: string;
  directory: string;
  requiresBackend: boolean;
  hotSwappable: boolean;
};

export type PreflightResult = {
  ok: boolean;
  errors: Array<{ code?: string; message: string }>;
  warnings: Array<string | { code?: string; message: string }>;
  extensionId?: string;
  version?: string;
  engines?: ExtensionEngines;
  /** 声明了 backend / hostPlugin / metadata / publicRoutes：提交后需要生效。 */
  requiresRestart?: boolean;
  /** 后端是否能在运行期换版：纯 hostPlugin 为 true；站点 backend 工厂为 false（需重启）。 */
  hotSwappable?: boolean;
  /** 扩展声明的依赖（extensionId → semver range）；缺省无依赖。 */
  dependencies?: Readonly<Record<string, string>>;
};

export type InstallationRecord = {
  current: string;
  previous?: string | null;
  sourceId: string;
  packageDigest?: string;
  filesDigest?: string;
  trust?: ExtensionTrust;
  evidence?: Record<string, unknown>;
  quarantine?: string;
  quarantineCleanupPending?: boolean;
  versions?: Record<string, { filesDigest?: string; packageDigest?: string; trust?: ExtensionTrust; evidence?: Record<string, unknown> }>;

  state?: "active" | "observing" | "uninstalling";
  observeUntil?: string | null;
  /** 含后端代码：观察期从下一次启动开始计时。 */
  observeAfterRestart?: boolean;
  requiresRestart?: boolean;
  /** 后端是否能在运行期换版；缺省按旧记录兼容处理（见 manager-context / lifecycle）。 */
  hotSwappable?: boolean;
  /** 本记录的变更需要受控重启后生效（下一次启动清除）。 */
  restartPending?: boolean;
  rejected?: string[];
  history?: Array<Record<string, unknown>>;
};

export type InstallationsState = {
  schemaVersion: number;
  revision: number;
  extensions: Record<string, InstallationRecord>;
};

export type InstallationsHandle = {
  layout: {
    root: string;
    installationsFile: string;
    installedDir: string;
    stagingDir: string;
    versionDir(extensionId: string, version: string): string;
  };
  read(): InstallationsState;
  commit(mutator: (draft: InstallationsState) => InstallationsState | void, options: { expectedRevision: number }): InstallationsState;
  clearStaging(): void;
  release(): void;
};

export type ExtensionPackageToolkit = {
  computePackageDigest(packagePath: string): string | Promise<string>;
  unpackExtensionPackage(input: { packagePath: string; destDir: string; limits?: Record<string, number> }): unknown;
  verifyExtensionPackage(input: { treeDir: string; packageDigest?: string; trustedKeys: readonly TrustedKey[]; allowUnsigned: boolean }): { trust: ExtensionTrust; evidence?: Record<string, unknown> } | Promise<{ trust: ExtensionTrust; evidence?: Record<string, unknown> }>;
  trustStateStamp?(): string;
  verifyManagedActivation?(input: { dir: string; record?: InstallationRecord; fresh?: boolean }): Promise<unknown>;
  filesDigest(treeDir: string): string | Promise<string>;
  preflightDirectory(dir: string, options: { managed: true }): PreflightResult | Promise<PreflightResult>;
  openInstallations(input: { managedRoot: string; lock?: boolean }): InstallationsHandle;
  appendHistory(record: InstallationRecord, entry: Record<string, unknown>): InstallationRecord;
  listOrphanVersionDirs(managedRoot: string, state: InstallationsState): Array<{ extensionId: string; version: string; dir: string }>;
  checkEnginesCompatible(engines: ExtensionEngines | undefined): { ok: true } | { ok: false; reasons: string[] };
  satisfiesRange(version: string, range: string): boolean | null;
  /** 公钥 → keyId（sha256(SPKI DER) 前 16 hex）；市场详情用它判断本机信任根里有没有某个 keyId。 */
  keyIdOf?(publicKey: string): string;
  /**
   * 运行期从受管版本目录加载真实扩展层插件（热切换）：读声明、校验信任边界与模块存在性、
   * `import()` 该版本目录的入口并调用 `hostPlugin` 工厂。不同版本目录是不同 URL，不命中 ESM 缓存。
   */
  loadRuntimePlugin?(input: { dir: string; extensionId: string; version: string }): Promise<{ plugin: AnyExtensionPlugin; descriptor: unknown }>;
};
