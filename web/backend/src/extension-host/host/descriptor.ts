/**
 * isolated 描述（扫描器 `isolatedDescriptorOf` 的产出，纯数据；change: 2026-10-21-isolate-extension-host-process，D1）
 * 与由它派生的宿主授予能力清单（D4）。
 */
import type { ExtensionHostCapabilities, PluginIcon, SettingDefinition } from "@woohaa3/contracts";

export type IsolatedPluginDescriptor = {
  isolated: true;
  extensionId: string;
  version: string;
  /** 版本目录（子进程 cwd）。 */
  directory: string;
  /** `backend-dist/entry.mjs` 的绝对路径。 */
  entry: string;
  factory: string;
  kind: "provider";
  order?: number;
  permissions: {
    network?: readonly string[];
    storageNamespaces?: readonly string[];
    publicRoutes?: boolean;
    [key: string]: unknown;
  };
  /** extension.json 声明的公开路径。 */
  publicRoutes: readonly string[];
  plugin: {
    name: string;
    label: string;
    configPrefix: string;
    fields: Readonly<Record<string, SettingDefinition>>;
    health: boolean;
    modelRefresh?: { path: string; hint: string };
  };
  icon?: PluginIcon;
  origin: { managed: true; rootWritable: false };
};

export function isIsolatedDescriptor(value: unknown): value is IsolatedPluginDescriptor {
  return typeof value === "object" && value !== null && (value as { isolated?: unknown }).isolated === true;
}

/** 宿主授予子进程的能力清单（D4）：路由前缀按 permissions 裁剪，存储与出网照声明。 */
export function capabilitiesFor(descriptor: IsolatedPluginDescriptor): ExtensionHostCapabilities {
  const prefixes = new Set<string>([`/api/extensions/${descriptor.extensionId}/`]);
  if (descriptor.plugin.modelRefresh?.path) prefixes.add(descriptor.plugin.modelRefresh.path);
  if (descriptor.permissions.publicRoutes === true) for (const route of descriptor.publicRoutes) prefixes.add(route);
  return {
    extensionId: descriptor.extensionId,
    routePrefixes: [...prefixes],
    storageNamespaces: [...(descriptor.permissions.storageNamespaces ?? [])],
    network: [...(descriptor.permissions.network ?? [])]
  };
}

/** 路由前缀是否在授予范围内（宿主侧复核，子进程侧已先拦一次）。 */
export function routeAllowed(capabilities: ExtensionHostCapabilities, prefix: string): boolean {
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return capabilities.routePrefixes.some((granted) => {
    const base = granted.endsWith("/") ? granted : `${granted}/`;
    return normalized.startsWith(base) || prefix === granted.replace(/\/+$/, "");
  });
}
