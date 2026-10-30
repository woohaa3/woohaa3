/**
 * 「核心服务」分区：宿主自己的配置项，按核心服务分页签。
 *
 * 这里只放**与具体插件无关**的宿主配置（远端同步的静态回落、选哪个存储后端、本机遥测）。
 * 页签集合由「当前有配置项的服务」推导，没有配置的服务不出现；单个服务时不渲染页签条。
 * 插件声明的配置段（storage.local.*、providers.ark.* 等，每项带 ownerExtensionId）归属各自的
 * 插件卡片，显示在「插件配置」分区。
 *
 * 敏感项不回显，只显示已配置 / 未配置；被旧环境变量锁定的项只读，并提示迁移到配置文件。
 * 页签切换的门禁（写请求中拒绝、dirty 先确认）由工作区经 onSelectService 提供。
 */
import { useSyncExternalStore } from "react";
import type { SettingsSnapshot } from "@woohaa3/contracts";
import "./settings.css";
import { Button } from "@woohaa3/ui/primitives";
import type { ExtensionManagerFacade, ExtensionManagerView, ExtensionSiteRow } from "../extension-manager/contract.js";
import type { BackendSettingsStore } from "./backend-settings-store.js";
import { SettingRow } from "./setting-row.js";
import { settingsPartition } from "./plugin-groups.js";
import type { SettingsEditSession } from "./edit-session.js";
import { hostServiceGroups, type HostServiceGroup } from "./host-services.js";
import {
  exposerProviders,
  isStorageSettingKey,
  providersForSettingKey,
  relatedProviderPlugin,
  storageProviders,
  storageSettingOptions,
  type StorageProviderOption
} from "./extension-point-links.js";
import { generationProviders, type GenerationProviderView } from "./generation-providers.js";

/** 没有插件管理快照时（独立语境/测试）的稳定空视图。 */
const EMPTY_EXTENSION_VIEW: ExtensionManagerView = {
  rows: [],
  siteRows: [],
  modelRows: [],
  siteManageable: false,
  siteError: null,
  pending: false,
  persistenceMessage: null,
  error: null
};
const subscribeNone = () => () => undefined;

export function BackendSettingsSection({
  store,
  editSession,
  activeServiceId,
  onSelectService,
  onGoToPlugins,
  onOpenTelemetry,
  extensions,
  onOpenPlugin
}: {
  store: BackendSettingsStore;
  /** 设置工作区的编辑会话；缺省（凭据弹窗等独立语境）不参与退出保护。 */
  editSession?: SettingsEditSession;
  /** 工作区持有的当前服务页签；缺省或已失效时落到第一个有配置的服务。 */
  activeServiceId?: string | null;
  /** 请求切换服务页签；工作区负责 dirty/pending 门禁。缺省时直接切换（独立语境）。 */
  onSelectService?: (serviceId: string) => void;
  /** 指引里的「去插件配置」；缺省不显示该按钮。 */
  onGoToPlugins?: () => void;
  /** 打开本机遥测复盘页；未提供时不显示入口（独立语境下没有导航权威）。 */
  onOpenTelemetry?: () => void;
  /** 插件管理快照：扩展点提供者的站点插件状态（可选）。 */
  extensions?: ExtensionManagerFacade;
  /** 打开某个插件详情（扩展点选择项的「打开配置」）；缺省不显示该按钮。 */
  onOpenPlugin?: (pluginId: string) => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const extensionView = useSyncExternalStore(
    extensions ? extensions.subscribe : subscribeNone,
    () => (extensions ? extensions.getSnapshot() : EMPTY_EXTENSION_VIEW),
    () => EMPTY_EXTENSION_VIEW
  );
  if (state.status === "loading") return <p className="settings-page__hint" role="status">正在读取核心服务配置…</p>;
  if (state.status === "unauthorized") {
    return (
      <p className="settings-page__hint" data-testid="backend-settings-unauthorized">
        需要管理员权限才能查看和修改核心服务配置。
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div className="settings-page__hint">
        <p className="settings-page__error" role="alert">{state.error}</p>
        <Button size="sm" onClick={() => void store.load()}>重试</Button>
      </div>
    );
  }

  const { snapshot } = state;
  const { host } = settingsPartition(snapshot);
  // 生成服务的「配置」是 Provider 插件：有 Provider 时页签要出现，即使没有任何宿主 YAML 配置。
  const generation = generationProviders(snapshot, extensionView);
  const groups = hostServiceGroups(host, {
    includeServiceIds: generation.length > 0 ? ["generation"] : []
  });
  // 扩展点选择项的可选提供者：已注册后端 + 插件声明但尚未注册的后端。
  const providers = storageProviders(snapshot);
  // 地址提供者是另一个扩展点：选项分开给，但「跳到提供者插件」要在合并列表里找。
  const addressProviders = exposerProviders(snapshot);
  const allProviders = [
    ...providers,
    ...addressProviders.filter((candidate) => !providers.some((known) => known.id === candidate.id))
  ];
  if (groups.length === 0) {
    return (
      <div className="settings-services__empty" data-testid="backend-settings-empty">
        <p className="settings-services__empty-title">当前没有核心服务配置</p>
        <p className="settings-page__hint">
          宿主自己的配置项都还没有，或者已被插件接管；有配置或被插件影响的服务会在这里自动出现页签。
        </p>
      </div>
    );
  }

  const active = groups.find((group) => group.service.id === activeServiceId) ?? groups[0]!;
  const tabItems = groups.map((group) => ({
    group,
    count: group.service.id === "generation" ? generation.length : group.entries.length
  }));
  const isGeneration = active.service.id === "generation";
  return (
    <>
      {groups.length > 1 ? <ServiceTabs items={tabItems} activeId={active.service.id} onSelect={onSelectService} /> : null}
      <div className="settings-services__ctx">
        <p className="settings-services__desc" data-testid="backend-settings-service-desc">{active.service.description}</p>
        <span className="settings-services__count" data-testid="backend-settings-service-count">
          {isGeneration ? generation.length + " 个 Provider" : active.entries.length + " 项宿主配置"}
        </span>
      </div>
      {isGeneration ? (
        <GenerationProviders providers={generation} {...(onOpenPlugin ? { onOpenPlugin } : {})} />
      ) : (
        <>
      {active.service.pointer ? (
        <div className="settings-services__pointer" data-testid={'host-service-pointer-' + active.service.id}>
          <span>{active.service.pointer}</span>
          {onGoToPlugins ? (
            <Button size="sm" tone="ghost" onClick={onGoToPlugins} data-testid="host-service-goto-plugins">去插件配置</Button>
          ) : null}
        </div>
      ) : null}
      <ul className="settings-page__list" data-testid="backend-settings-list">
        {active.entries.map((entry) => {
          const storageKey = isStorageSettingKey(entry.key) ? entry.key : null;
          const keyProviders = storageKey ? providersForSettingKey(storageKey, providers, addressProviders) : providers;
          const options = storageKey && keyProviders.length > 0
            ? storageSettingOptions(storageKey, keyProviders, typeof entry.value === "string" ? entry.value : "")
            : null;
          return (
            <SettingRow
              key={entry.key + ":" + String(entry.value) + ":" + entry.configured}
              entry={entry}
              store={store}
              {...(editSession ? { editSession } : {})}
              {...(options ? { options } : {})}
              {...(storageKey
                ? {
                    renderRelated: (value: string) => (
                      <RelatedProvider
                        entryKey={entry.key}
                        backendId={value}
                        providers={allProviders}
                        snapshot={snapshot}
                        siteRows={extensionView.siteRows}
                        {...(onOpenPlugin ? { onOpenPlugin } : {})}
                        {...(onGoToPlugins ? { onGoToPlugins } : {})}
                      />
                    )
                  }
                : {})}
            />
          );
        })}
      </ul>
      {active.service.id === "telemetry" && onOpenTelemetry ? (
        <p className="settings-page__hint" data-testid="open-telemetry-review">
          本机遥测记录的事件与异常命中可在复盘页查看；数据只在本机，不联网。
          <Button size="sm" onClick={onOpenTelemetry}>打开复盘页</Button>
        </p>
      ) : null}
      <p className="settings-page__hint">
        配置文件 <code>{snapshot.files.config}</code>，密钥文件 <code>{snapshot.files.secrets}</code>。
        直接编辑这两个文件同样会自动生效；插件声明的配置项写进同一份文件。
      </p>
        </>
      )}
    </>
  );
}

/**
 * 扩展点选择项的关联提供者：显示提供者插件与真实状态，并提供直达该插件配置的入口。
 *
 * 解析不到提供者时只提示并回退到插件列表——不猜插件、不跳到错误详情。
 */
function RelatedProvider({
  entryKey,
  backendId,
  providers,
  snapshot,
  siteRows,
  onOpenPlugin,
  onGoToPlugins
}: {
  entryKey: string;
  backendId: string;
  providers: readonly StorageProviderOption[];
  snapshot: SettingsSnapshot;
  siteRows: readonly ExtensionSiteRow[];
  onOpenPlugin?: (pluginId: string) => void;
  onGoToPlugins?: () => void;
}) {
  if (!backendId) return null;
  const related = relatedProviderPlugin({ backendId, providers, snapshot, siteRows });
  if (!related) {
    return (
      <>
        <span className="settings-page__related-missing">没有已安装插件提供这个后端</span>
        {onGoToPlugins ? (
          <Button size="sm" tone="ghost" onClick={onGoToPlugins} data-testid={'setting-related-goto-plugins-' + entryKey}>
            去插件配置
          </Button>
        ) : null}
      </>
    );
  }
  return (
    <>
      <span>关联插件：{related.label}</span>
      {related.unregistered ? (
        <span className="settings-page__badge is-warning">后端未注册</span>
      ) : (
        <span className="settings-page__badge is-muted">{related.status}</span>
      )}
      {related.openable && onOpenPlugin ? (
        <Button size="sm" tone="ghost" onClick={() => onOpenPlugin(related.pluginId)} data-testid={'setting-related-open-' + entryKey}>
          打开配置
        </Button>
      ) : null}
    </>
  );
}

function ServiceTabs({
  items,
  activeId,
  onSelect
}: {
  items: ReadonlyArray<{ group: HostServiceGroup; count: number }>;
  activeId: string;
  onSelect?: (serviceId: string) => void;
}) {
  return (
    <div className="settings-services__tabs" role="tablist" aria-label="核心服务" data-testid="host-service-tabs">
      {items.map(({ group, count }) => {
        const active = group.service.id === activeId;
        return (
          <button
            key={group.service.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={active ? "settings-services__tab is-active" : "settings-services__tab"}
            data-testid={'host-service-tab-' + group.service.id}
            onClick={() => { if (!active) onSelect?.(group.service.id); }}
          >
            {group.service.label}
            <span className="settings-services__count-badge">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 生成服务的 Provider 汇总：Generation 的配置由 Provider 插件提供，这里展示「谁在供模型」。
 *
 * 不重复 Provider 的凭据表单：每行直链到对应插件详情，凭据、地址与模型目录仍在插件里管理。
 */
function GenerationProviders({
  providers,
  onOpenPlugin
}: {
  providers: readonly GenerationProviderView[];
  onOpenPlugin?: (pluginId: string) => void;
}) {
  return (
    <>
      <ul className="settings-page__list" data-testid="generation-providers">
        {providers.map((provider) => (
          <li className="settings-page__item" key={provider.pluginId} data-generation-provider={provider.providerId}>
            <div className="settings-page__item-head">
              <span className="settings-page__item-label">{provider.label}</span>
              {provider.configKey ? <code className="settings-page__item-key">{provider.configKey}</code> : null}
              <span className="settings-page__badge is-muted">{provider.status}</span>
            </div>
            <p className="settings-page__item-description">
              {provider.modelCount > 0
                ? '模型 ' + provider.enabledCount + '/' + provider.modelCount + ' 已启用；配置在这个插件自己的详情里。'
                : '还没有可用模型：先在这个插件里完成配置，再刷新模型目录。'}
            </p>
            {onOpenPlugin ? (
              <Button
                size="sm"
                tone="ghost"
                onClick={() => onOpenPlugin(provider.pluginId)}
                data-testid={'generation-provider-open-' + provider.pluginId}
              >
                打开配置
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="settings-page__hint">
        生成服务本身只拥有站点级模型策略；Provider 提供模型目录与配置。模型目录与启停在对应 Provider 的详情里。
      </p>
    </>
  );
}
