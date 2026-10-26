/**
 * 受管扩展「该版本已被撤回」提示（change: 2026-10-21-add-server-extension-marketplace，design Risks：yank 不召回已装副本）。
 *
 * - 只对来自市场来源（非 local-file）的受管扩展、在卡片挂载 / 版本变化时**按需查询一次**，不轮询；
 *   宿主侧另有 5 分钟缓存，重复打开卡片不会反复打服务端。
 * - 查询失败或状态未知：什么都不显示，不阻塞卡片其它操作。
 * - 只提示「升级到新版本或卸载」，不强制卸载；已安装副本继续运行。
 */
import { useEffect, useState } from "react";
import type { InstalledExtensionView, ManagedVersionStatusView } from "@woohaa3/contracts";
import { MARKETPLACE_LOCAL_FILE_SOURCE_ID, compareSemver } from "@woohaa3/contracts";
import { createMarketplaceRemote, type MarketplaceRemote } from "../../services/marketplace-remote.js";
import "./marketplace-install.css";

let sharedRemote: Pick<MarketplaceRemote, "versionStatus"> | null = null;
const defaultRemote = () => (sharedRemote ??= createMarketplaceRemote());

/** 是否需要查询：市场来源的受管扩展才查。 */
export function shouldCheckVersionStatus(installed: InstalledExtensionView | undefined): installed is InstalledExtensionView & { version: string; sourceId: string } {
  return !!installed && installed.managed === true && typeof installed.version === "string" && typeof installed.sourceId === "string" && installed.sourceId !== MARKETPLACE_LOCAL_FILE_SOURCE_ID;
}

export function withdrawnText(status: ManagedVersionStatusView): string {
  const head = status.reason ? `该版本已被撤回：${status.reason}` : "该版本已被撤回，已不在市场的可用版本中";
  const upgrade = status.latest && compareSemver(status.latest, status.version) > 0 ? `可升级到 v${status.latest}，或卸载。` : "建议卸载或改用其他版本。";
  return `${head}。已安装的副本仍在运行，${upgrade}`;
}

export function ManagedVersionStatusNotice({
  installed,
  remote
}: {
  installed: InstalledExtensionView | undefined;
  remote?: Pick<MarketplaceRemote, "versionStatus">;
}) {
  const [status, setStatus] = useState<ManagedVersionStatusView | null>(null);
  const check = shouldCheckVersionStatus(installed);
  const id = installed?.id;
  const version = installed?.version;
  useEffect(() => {
    setStatus(null);
    if (!check || !id) return;
    let cancelled = false;
    void (remote ?? defaultRemote())
      .versionStatus(id)
      .then((result) => {
        if (!cancelled && result && result.version === version) setStatus(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [check, id, version, remote]);
  if (!status || status.status !== "withdrawn") return null;
  return (
    <p className="managed-extension__withdrawn" role="status" data-testid={`managed-withdrawn-${status.extensionId}`}>
      {withdrawnText(status)}
    </p>
  );
}
