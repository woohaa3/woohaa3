/**
 * 扩展「来源 / 信任」的展示口径（设置面插件行、插件详情卡片、来源筛选共用一份）。
 *
 * 来源是安装事实：内置（随宿主发布）、团队市场（woohaa-server）、GitHub 仓库、本地文件。
 * 未知 sourceId 原样显示——把新来源藏成「市场」会让人误判可用范围。
 */
import type { ExtensionTrust, InstalledExtensionView } from "@woohaa3/contracts";

export type ExtensionSourceBadge = {
  /** 筛选用的稳定 id：`builtin` 或 sourceId。 */
  id: string;
  label: string;
  tone: "builtin" | "market" | "local";
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  "woohaa-server": "团队市场",
  "github-release": "GitHub",
  "local-file": "本地文件"
};

/** 单个扩展的安装来源；非受管扩展一律按内置处理。 */
export function extensionSource(installed?: InstalledExtensionView): ExtensionSourceBadge {
  if (!installed?.managed) return { id: "builtin", label: "内置", tone: "builtin" };
  const sourceId = installed.sourceId ?? "unknown";
  if (sourceId === "local-file") return { id: sourceId, label: SOURCE_LABELS[sourceId]!, tone: "local" };
  return { id: sourceId, label: SOURCE_LABELS[sourceId] ?? sourceId, tone: "market" };
}

/**
 * 签名状态徽标。`signed:<keyId>` 只证来源与完整性，不代表执行边界——
 * 扩展与宿主同进程、同权限，这句话由详情里的说明承担，不塞进徽标。
 */
export function extensionTrustBadge(installed?: InstalledExtensionView): { label: string; tone: "signed" | "unsigned" } | null {
  if (!installed?.managed || !installed.trust) return null;
  return installed.trust === "unsigned" ? { label: "未签名", tone: "unsigned" } : { label: "已签名", tone: "signed" };
}

/** 观察期徽标：只在观察尚未结束时出现，截止时间进 title。 */
export function extensionObservationBadge(installed?: InstalledExtensionView, now = Date.now()): { label: string; title: string } | null {
  if (!installed?.managed || !installed.observeUntil) return null;
  const until = Date.parse(installed.observeUntil);
  if (!Number.isFinite(until) || until <= now) return null;
  return { label: "观察中", title: `观察期至 ${new Date(until).toLocaleString()}，期间失败将自动回滚` };
}

/** 受管扩展的 keyId（`signed:<keyId>` 的后半段），用于详情展示。 */
export function signedKeyId(trust: ExtensionTrust | undefined): string | null {
  return trust && trust !== "unsigned" ? trust.slice("signed:".length) : null;
}
