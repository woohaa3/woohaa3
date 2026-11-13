/**
 * 插件开关：站点插件写服务端权威状态，browser-local 写宿主配置文件（`extensions.<id>.enabled`）。
 *
 * 两者都是**运行中立即生效**——配置写入后宿主热重载、前端按 id 热装/热卸 fiber，
 * 不存在「重启后生效」或「下次打开生效」这回事。
 *
 * 目录名与这里无关——`.` 前缀只表示扩展未安装（change: 2026-10-19-restore-runtime-extension-toggling）。
 */
import { useState } from "react";
import { Switch } from "@woohaa3/ui/primitives";
import type { ExtensionManagerFacade } from "../extension-manager/contract.js";
import type { BackendSettingsStore } from "./backend-settings-store.js";
import { diagnosticsOf, pluginStateKind, type PluginSettingsGroup, type PluginViewIndex } from "./plugin-groups.js";

/** 失败原因独立于配置入口；没有配置项或修改权限也可以展开查看。 */
export function PluginFailureDetails({ index, group }: { index: PluginViewIndex; group: PluginSettingsGroup }) {
  const failed = index.siteRows.get(group.id)?.actualState === "failed"
    || index.browserRows.get(group.id)?.status === "failed";
  if (!failed) return null;
  const reasons = diagnosticsOf(index, group).filter((reason) => reason.trim());
  return (
    <details className="plugin-failure" data-testid={`plugin-failure-${group.id}`}>
      <summary>查看失败原因</summary>
      <div className="plugin-failure__reasons">
        {reasons.length > 0
          ? reasons.map((reason, i) => <p key={i}>{reason}</p>)
          : <p>插件激活失败，未返回具体原因。</p>}
      </div>
    </details>
  );
}

export function PluginStateControl({ index, group, manager, siteManageable, store, testId }: {
  index: PluginViewIndex;
  group: PluginSettingsGroup;
  manager: ExtensionManagerFacade;
  siteManageable: boolean;
  store?: BackendSettingsStore;
  testId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = pluginStateKind(index, group);
  const siteRow = kind === "site" ? index.siteRows.get(group.id) : undefined;
  const browserRow = kind === "browser" ? index.browserRows.get(group.id) : undefined;
  if (!siteRow && !browserRow) return null;

  if (siteRow) {
    const label = siteRow.actualStateLabel;
    return (
      <div className="plugin-state">
        <span className="plugin-state__label" data-pending={siteRow.busy ? "true" : "false"} data-actual-state={siteRow.actualState}>
          {busy ? "正在应用…" : label}
        </span>
        <Switch
          checked={siteRow.desiredEnabled}
          disabled={busy || !siteManageable || siteRow.busy}
          onCheckedChange={(enabled) => {
            setBusy(true);
            setError(null);
            manager.setSiteEnabled(siteRow.extensionId, enabled);
            // facade 的写入是异步的（提交 → 激活/释放 → 重取权威状态）；状态跟随 facade 通知刷新，
            // 这里只解除本地的按钮锁定，不伪造「已生效」。
            queueMicrotask(() => setBusy(false));
          }}
          testId={testId}
        />
        {siteRow.diagnostics.length > 0 ? <span className="settings-page__hint">{siteRow.diagnostics.join("；")}</span> : null}
        {error ? <span className="settings-page__error">{error}</span> : null}
      </div>
    );
  }

  const browserEnabled = browserRow!.status !== "disabled";
  return (
    <div className="plugin-state">
      <span className="plugin-state__label" data-pending={kind === "browser" && browserRow!.status.startsWith("pending") ? "true" : "false"}>
        {browserRow!.status === "failed" ? "激活失败" : browserEnabled ? "运行中" : "已停用"}
      </span>
      <Switch
        checked={browserEnabled}
        disabled={busy || !store?.canManage()}
        onCheckedChange={(enabled) => {
          setBusy(true);
          setError(null);
          manager.setEnabled(browserRow!.id, enabled);
          queueMicrotask(() => setBusy(false));
        }}
        testId={testId}
      />
      {error ? <span className="settings-page__error">{error}</span> : null}
    </div>
  );
}
