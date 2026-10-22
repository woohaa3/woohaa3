import slotRules from "./foundation-slots.json";
import type { IdentityProvider, ResourceAccessPolicy, ResourceDirectory, ResourceLifecyclePolicy, SiteAccessPolicy } from "./access.js";
import type { ExtensionDocumentStoreProvider } from "./store.js";

/** 已知能力；Storage 始终必需，Identity/Access 必须同时存在或同时缺省。 */
export const FOUNDATION_SLOTS = Object.freeze(slotRules.known) as readonly ["storage", "identity", "access"];
export type FoundationSlot = (typeof FOUNDATION_SLOTS)[number];
export const REQUIRED_FOUNDATION_SLOTS = Object.freeze(slotRules.required) as readonly ["storage"];

/** 在产生资源前确定本次装配要求，不能用工厂结果推断是否启用鉴权。 */
export function requiredFoundationSlots(declared: readonly FoundationSlot[]): readonly FoundationSlot[] {
  return declared.some(slot => slotRules.accessControl.includes(slot))
    ? FOUNDATION_SLOTS : REQUIRED_FOUNDATION_SLOTS;
}

export type AssembledFoundationProviders<S extends StorageProvider = StorageProvider> = {
  storage: S;
} & ({ identity: IdentityProvider; access: AccessProvider } | { identity?: undefined; access?: undefined });

/** 数据接口按领域分开，底层连接与释放由同一 Storage 实现持有。 */
export type StorageProvider<TCanvas = unknown> = {
  providerId: string;
  canvas: TCanvas;
  documents: ExtensionDocumentStoreProvider;
  readExtensionConfig(extensionId: string): Record<string, unknown>;
  directory: ResourceDirectory;
  listCanvasSummaries(ids: readonly string[]): Promise<Array<{
    canvasId: string; title: string; revision: number; updatedAt: string; nodeCount: number;
  }>>;
};

/** 授权、目录与权限生命周期是一个对外注册单元，内部保持专用接口。 */
export type AccessProvider = {
  providerId: string;
  site: SiteAccessPolicy;
  resource: ResourceAccessPolicy;
  lifecycle: ResourceLifecyclePolicy;
  directory: ResourceDirectory;
  sharing: boolean;
  ready?(): boolean;
};

/** 声明工厂的槽位值类型表；实际装配结果使用 AssembledFoundationProviders。 */
export type FoundationProviders<S extends StorageProvider = StorageProvider> = {
  storage: S;
  identity: IdentityProvider;
  access: AccessProvider;
};

export type BootstrapContext<S extends StorageProvider = StorageProvider> = {
  /** 只能取得已声明且已经初始化的依赖。 */
  get<K extends FoundationSlot>(slot: K): FoundationProviders<S>[K];
};

export type BootstrapProviderDefinition<S extends StorageProvider = StorageProvider> = {
  [K in FoundationSlot]: {
    slot: K;
    requires: readonly FoundationSlot[];
    create(context: BootstrapContext<S>): Promise<{
      value: FoundationProviders<S>[K];
      dispose?: () => void | Promise<void>;
    }>;
  }
}[FoundationSlot];

/** server-only bootstrap 入口导出声明；导入时不得连接数据库或执行注册。 */
export type BootstrapExtension<S extends StorageProvider = StorageProvider> = {
  extensionId: string;
  providers: readonly BootstrapProviderDefinition<S>[];
  /** 初始化完成后，把扩展拥有的实例交给自己的普通后端入口。 */
  backendOptions?: (providers: AssembledFoundationProviders<S>) => unknown;
};
