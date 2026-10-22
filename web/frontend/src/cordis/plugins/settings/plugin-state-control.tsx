/**
 * 插件开关：站点插件写服务端权威状态（运行中生效），browser-local 写浏览器本地偏好（下次启动生效）。
 *
 * 目录名与这里无关——`.提示` 只表示扩展未安装（change: 2026-10-19-restore-runtime-extension-toggling）。
 */
import { useState } from "react";
import { Switch } from "../../../shared/ui/Switch.js";
import type { ExtensionManagerFacade } from "../extension-manager/contract.js";
import type { BackendSettingsStore } from "./backend-settings-store.js";
import { pluginStateKind, type PluginSettingsGroup, type PluginViewIndex } from "./plugin-groups.js";

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
        {browserEnabled ? "本次已启用" : "本次未启用"}
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
      <span className="settings-page__hint">下次打开生效</span>
      {error ? <span className="settings-page__error">{error}</span> : null}
    </div>
  );
}
