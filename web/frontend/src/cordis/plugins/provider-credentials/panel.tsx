/**
 * Provider 凭据 dialog renderer。
 *
 * 顶部是插件自带的授权入口（ChatGPT 等 contribution），下面每个已装载的 Provider 一张卡片，
 * 列出它在自己配置段里声明的密钥项（`/api/settings`，写进本地密钥文件）。不硬编码具体 Provider；
 * 完整的 Provider 配置与启停在设置页「插件配置」的同一张卡片上（画布 scope 没有站点写权限，
 * 这里只指路）。change: 2026-10-16-consolidate-canvas-settings-entries：画布不再注册凭据入口，
 * 本弹窗只作为生成面板授权操作的落点。
 */
import { useSyncExternalStore, type ComponentType } from "react";
import { Dialog } from "@woohaa3/ui/dialogs";
import type { DialogRendererProps } from "../../services/dialogs/renderer-registry.js";
import { ProviderSettingsCards } from "../settings/provider-settings-cards.js";
import { ContributionBoundary } from "../../contribution-boundary.js";
import type { BackendSettingsStore } from "../settings/backend-settings-store.js";

export const PROVIDER_CREDENTIALS_DIALOG_TITLE = "Provider 凭据";

export type ProviderCredentialsTopContribution = { id: string; render: ComponentType<{ requestClose?: () => void }> };

export type ProviderCredentialsTopOptions = {
  topContributions?: () => ReadonlyArray<ProviderCredentialsTopContribution>;
  subscribeTop?: (listener: () => void) => () => void;
};

export function createProviderCredentialsRenderer(store: BackendSettingsStore, options: ProviderCredentialsTopOptions = {}) {
  return function ProviderCredentialsRenderer({ requestClose }: DialogRendererProps) {
    return (
      <Dialog.Content
        size="md"
        variant="standard"
        labelledBy="provider-credentials-title"
        ariaLabel={PROVIDER_CREDENTIALS_DIALOG_TITLE}
        onOverlayClick={requestClose}
      >
        <Dialog.Header onClose={requestClose}>
          <Dialog.Title id="provider-credentials-title">{PROVIDER_CREDENTIALS_DIALOG_TITLE}</Dialog.Title>
        </Dialog.Header>
        <Dialog.Body>
          <ProviderCredentialsSections store={store} {...options} requestClose={requestClose} />
        </Dialog.Body>
      </Dialog.Content>
    );
  };
}

export function ProviderCredentialsSections({
  store,
  topContributions,
  subscribeTop,
  requestClose
}: ProviderCredentialsTopOptions & { store: BackendSettingsStore; requestClose?: () => void }) {
  // 订阅 slot 变化，使后激活的授权 contribution 也能出现。
  useSyncExternalStore(
    subscribeTop ?? (() => () => undefined),
    () => topContributions?.().length ?? 0,
    () => topContributions?.().length ?? 0
  );
  const top = topContributions?.() ?? [];
  return (
    <>
      {top.length > 0 ? (
        <Dialog.Section>
          <div className="provider-credentials__top" data-testid="provider-credentials-top">
            {top.map((contribution) => {
              const Render = contribution.render;
              return (
                <div key={contribution.id} data-contribution-id={contribution.id}>
                  <ContributionBoundary entry={contribution} slot="provider-credentials.top" fallback="card">
                    <Render {...(requestClose ? { requestClose } : {})} />
                  </ContributionBoundary>
                </div>
              );
            })}
          </div>
        </Dialog.Section>
      ) : null}
      <Dialog.Section>
        <ProviderSettingsCards store={store} secretsOnly />
        <p className="provider-credentials__description">
          其它 Provider 配置项在「设置 → 插件配置」的 Provider 卡片上；Provider 未启用时不会生效，启停也在那张卡片上。
        </p>
      </Dialog.Section>
    </>
  );
}
