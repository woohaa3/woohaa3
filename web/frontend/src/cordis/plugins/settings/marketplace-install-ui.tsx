/**
 * 设置面「从市场安装」（change: 2026-10-21-add-server-extension-marketplace，tasks 7.5 / design D7、D8）。
 *
 * 只有宿主启用受管安装、当前用户可管理、且存在非 local-file 的市场来源时出现。来源只有一个时直接用它。
 * keyId 未被本机信任：安装按钮仍可点，旁边提示会失败并给出「信任此公钥」（二次确认后写本机配置）。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { MarketplaceSigningKey, SettingsSnapshot } from "@woohaa3/contracts";
import { Button } from "../../../shared/ui/Button.js";
import { SelectInput, TextInput } from "../../../shared/ui/FormControls.js";
import { versionTrusted, type MarketplaceInstallController } from "./marketplace-install.js";
import "./marketplace-install.css";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function MarketplaceInstallPanel({
  controller,
  snapshot,
  canManage
}: {
  controller: MarketplaceInstallController;
  snapshot: SettingsSnapshot | null;
  canManage: boolean;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [confirmKey, setConfirmKey] = useState<MarketplaceSigningKey | null>(null);
  const enabled = !!snapshot?.extensionInstallations && canManage;

  useEffect(() => {
    if (enabled && open && state.sources.length === 0 && !state.searching) void controller.load();
  }, [enabled, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const sourceOptions = useMemo(
    () => state.sources.map((source) => ({ value: source.sourceId, label: source.ok ? source.label : `${source.label}（不可用）` })),
    [state.sources]
  );
  if (!enabled) return null;

  const selected = state.selected;
  const detail = selected?.detail ?? null;
  const version = detail?.extension.versions.find((entry) => entry.version === selected?.version) ?? null;
  const trusted = detail && selected?.version ? versionTrusted(detail, selected.version) : null;
  const signingKey = version?.keyId ? detail?.signingKeys.find((key) => key.keyId === version.keyId) ?? null : null;

  return (
    <div className="marketplace-install" data-testid="marketplace-install">
      <div className="managed-install__row">
        <Button size="sm" tone={open ? "primary" : "neutral"} onClick={() => setOpen(!open)} data-testid="marketplace-install-toggle">
          从市场安装
        </Button>
        <span className="settings-page__hint">从服务端团队市场搜索并安装；签名公钥必须先被本机信任。</span>
      </div>
      {open ? (
        <div className="marketplace-install__body" data-testid="marketplace-install-body">
          {state.sources.length === 0 && !state.searching ? (
            <p className="settings-page__hint" data-testid="marketplace-no-source">当前没有可用的市场来源（需要连接服务端）。</p>
          ) : null}
          {state.sources.length > 1 ? (
            <SelectInput label="市场来源" value={state.sourceId ?? ""} options={sourceOptions} onValueChange={(value) => void controller.setSource(value)} />
          ) : null}
          {state.unavailableReason ? (
            <p className="settings-page__hint" data-testid="marketplace-unavailable">{state.unavailableReason}</p>
          ) : null}
          {state.sourceId && !state.unavailableReason ? (
            <form
              className="managed-install__row"
              onSubmit={(event) => {
                event.preventDefault();
                void controller.search(text.trim());
              }}
            >
              <TextInput value={text} placeholder="搜索扩展" onChange={(event) => setText(event.currentTarget.value)} data-testid="marketplace-search-input" />
              <Button size="sm" type="submit" disabled={state.searching}>搜索</Button>
            </form>
          ) : null}
          {state.error ? <p className="settings-page__error" role="alert" data-testid="marketplace-error">{state.error}</p> : null}
          {state.notice ? <p className="settings-page__hint" role="status" data-testid="marketplace-notice">{state.notice}</p> : null}

          {!selected && state.items.length > 0 ? (
            <ul className="settings-page__list" data-testid="marketplace-results">
              {state.items.map((item) => (
                <li key={item.extensionId} className="settings-page__item" data-testid={`marketplace-item-${item.extensionId}`}>
                  <div className="settings-page__item-head">
                    <span className="settings-page__item-label">{item.label}</span>
                    <span className="settings-page__badge is-muted">v{item.latest}</span>
                    <Button size="sm" tone="ghost" onClick={() => void controller.select(item.extensionId)}>查看版本</Button>
                  </div>
                  {item.description ? <p className="settings-page__item-description">{item.description}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {!selected && !state.searching && state.sourceId && !state.unavailableReason && state.items.length === 0 ? (
            <p className="settings-page__hint" data-testid="marketplace-empty">没有找到扩展。</p>
          ) : null}

          {selected ? (
            <div className="marketplace-install__detail" data-testid="marketplace-detail">
              <div className="settings-page__item-head">
                <span className="settings-page__item-label">{detail?.extension.label ?? selected.extensionId}</span>
                {detail?.installedVersion ? <span className="settings-page__badge is-muted">本机 v{detail.installedVersion}</span> : null}
                <Button size="sm" tone="ghost" onClick={() => controller.close()}>返回</Button>
              </div>
              {selected.loading ? <p className="settings-page__hint" role="status">正在读取版本…</p> : null}
              {detail && detail.extension.versions.length > 0 ? (
                <>
                  <SelectInput
                    label="版本"
                    value={selected.version ?? ""}
                    options={detail.extension.versions.map((entry) => ({ value: entry.version, label: `v${entry.version}` }))}
                    onValueChange={(value) => controller.chooseVersion(value)}
                  />
                  {version ? (
                    <ul className="marketplace-install__meta" data-testid="marketplace-version-meta">
                      <li>大小：{formatSize(version.size)}</li>
                      {version.engines ? <li>运行环境：宿主 {version.engines.hostAbi} · SDK {version.engines.sdkAbi} · 协议 {version.engines.protocolVersion}</li> : null}
                      {version.dependencies ? <li>依赖：{Object.entries(version.dependencies).map(([id, range]) => `${id}@${range}`).join("、")}</li> : null}
                      <li>签名公钥：{version.keyId ?? "未知"}{trusted === true ? "（本机已信任）" : trusted === false ? "（本机未信任）" : ""}</li>
                    </ul>
                  ) : null}
                  {trusted === false ? (
                    <div className="settings-page__hint" role="status" data-testid="marketplace-untrusted">
                      签名公钥未被本机信任，安装会失败。
                      {signingKey ? (
                        <Button size="sm" tone="ghost" disabled={state.trusting !== null} onClick={() => setConfirmKey(signingKey)} data-testid="marketplace-trust">
                          信任此公钥
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {confirmKey ? (
                    <div className="marketplace-install__confirm" role="alertdialog" data-testid="marketplace-trust-confirm">
                      <p>
                        信任公钥 <code>{confirmKey.keyId}</code>{confirmKey.label ? `（${confirmKey.label}）` : ""} 后，本机会安装由它签名的任何扩展，
                        这些扩展的代码会在本机运行。确认该公钥来自你信任的发布者？
                      </p>
                      <Button
                        size="sm"
                        tone="primary"
                        onClick={() => {
                          const key = confirmKey;
                          setConfirmKey(null);
                          void controller.trustKey(key);
                        }}
                        data-testid="marketplace-trust-confirm-yes"
                      >
                        确认信任
                      </Button>
                      <Button size="sm" tone="ghost" onClick={() => setConfirmKey(null)}>取消</Button>
                    </div>
                  ) : null}
                  <Button size="sm" tone="primary" disabled={!selected.version || state.installing} onClick={() => void controller.install()} data-testid="marketplace-install-submit">
                    安装 v{selected.version}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
