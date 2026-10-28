/**
 * 设置面「从市场安装」。
 *
 * 列表是信息卡，详情换成同一面板内的页面（不叠第二层浮层）；两者共用一份控制器状态。
 * 搜索结果按来源缓存，切回看过的来源先出内容再后台刷新；界面只显示「更新于 hh:mm」与
 * 「正在刷新…」，不解释缓存。
 *
 * keyId 未被本机信任：安装按钮仍可点，旁边提示会失败并给出「信任此公钥」（二次确认后写本机配置）。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { compareSemver, type MarketplaceSigningKey, type MarketplaceVersionInfo, type SettingsSnapshot } from "@woohaa3/contracts";
import { Button } from "../../../shared/ui/Button.js";
import { TextInput } from "../../../shared/ui/FormControls.js";
import { appPublicUrl } from "../../services/app-base-path.js";
import { resolvePluginIcon } from "./plugin-icons.js";
import { versionTrusted, type MarketplaceInstallController } from "./marketplace-install.js";
import { describeJob, type ManagedExtensionsController, type ManagedExtensionsState } from "./managed-extensions.js";
import "./marketplace-install.css";

/** 没有任务控制器时的空状态（hook 必须无条件调用，所以用稳定的兜底函数）。 */
const NO_JOBS: ManagedExtensionsState = { jobs: [], error: null, submitting: false, restart: { status: "idle", message: null }, unquarantining: [] };
const subscribeNoJobs = () => () => undefined;
const getNoJobs = () => NO_JOBS;

const REPO_TAG = /^([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9._-]+)@(.+)$/;
const CARD_TONES = ["", "warm", "pink", "blue", "purple"] as const;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** 卡片语气色：只按 id 稳定取色，不引入业务含义。 */
function toneOf(extensionId: string): string {
  let hash = 0;
  for (const char of extensionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CARD_TONES[hash % CARD_TONES.length]!;
}

/**
 * 来源给的 label 有两种形状：GitHub 是 `owner/repo@tag`，本部署市场是人可读名称。
 * 前者用 extensionId 当标题、仓库当副标题；后者直接用 label，extensionId 放副标题。
 */
function presentationOf(label: string, extensionId: string): { title: string; source: string | null } {
  const match = REPO_TAG.exec(label);
  return match ? { title: extensionId, source: match[1]! } : { title: label, source: null };
}

/** Release 标题常是 `<id> <version>` 这类没人读的文本；这种情况下不占卡片的描述位。 */
function usefulDescription(item: { extensionId: string; description?: string }): string | null {
  const text = item.description?.trim();
  if (!text) return null;
  if (text.toLowerCase() === item.extensionId.toLowerCase()) return null;
  if (new RegExp(`^${item.extensionId}\\s+v?\\d`, "i").test(text)) return null;
  return text;
}

function PluginGlyph({ icon, size = 19 }: { icon: string | undefined; size?: number }) {
  const resolved = resolvePluginIcon(icon);
  return resolved.kind === "image" ? (
    <img className="marketplace-icon__image" src={appPublicUrl(resolved.src)} width={size} height={size} alt="" />
  ) : (
    <resolved.Icon size={size} />
  );
}

function ExtensionCard({
  item,
  installedVersion,
  installedIcon,
  installing,
  onOpen,
  onInstall
}: {
  item: { extensionId: string; label: string; description?: string; latest: string; icon?: string; size?: number; publishedAt?: string; hotReload?: boolean };
  installedVersion: string | undefined;
  installedIcon: string | undefined;
  installing: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const presentation = presentationOf(item.label, item.extensionId);
  const upgrade = installedVersion ? compareSemver(item.latest, installedVersion) > 0 : false;
  const description = usefulDescription(item);
  const published = formatDate(item.publishedAt);
  return (
    <li
      className={`marketplace-card${installing ? " is-installing" : ""}`}
      data-tone={toneOf(item.extensionId) || undefined}
      data-testid={`marketplace-item-${item.extensionId}`}
      onClick={onOpen}
    >
      {installing ? <span className="marketplace-card__progress" /> : null}
      <div className="marketplace-card__head">
        <span className="marketplace-icon" aria-hidden="true">
          <PluginGlyph icon={item.icon ?? installedIcon} />
        </span>
        <div className="marketplace-card__ident">
          <div className="marketplace-card__title">
            <h4>{presentation.title}</h4>
            {installedVersion ? (
              <span className={`marketplace-badge${upgrade ? " is-up" : " is-ok"}`}>{upgrade ? "可升级" : "已安装"}</span>
            ) : null}
          </div>
          <p className="marketplace-card__sub">
            {presentation.source ? `${presentation.source} · ` : ""}
            {item.extensionId} · v{item.latest}
          </p>
        </div>
      </div>
      {description ? <p className="marketplace-card__desc">{description}</p> : null}
      <div className="marketplace-card__meta">
        {item.size ? <span>{formatSize(item.size)}</span> : null}
        {published ? <span>更新于 {published}</span> : null}
        {item.hotReload !== undefined ? (
          <span className={item.hotReload ? "marketplace-tag is-hot" : "marketplace-tag is-restart"}>{item.hotReload ? "热加载" : "需重启"}</span>
        ) : null}
      </div>
      <div className="marketplace-card__foot">
        <Button size="sm" tone="ghost" onClick={(event) => { event.stopPropagation(); onOpen(); }}>
          详情
        </Button>
        <span className="marketplace-card__spacer" />
        <Button
          size="sm"
          tone={installedVersion && !upgrade ? "neutral" : "primary"}
          disabled={Boolean(installedVersion && !upgrade) || installing}
          onClick={(event) => { event.stopPropagation(); onInstall(); }}
        >
          {installing ? "安装中…" : installedVersion && !upgrade ? `已安装 v${installedVersion}` : upgrade ? `升级到 v${item.latest}` : `安装 v${item.latest}`}
        </Button>
      </div>
    </li>
  );
}

function Skeleton() {
  return (
    <ul className="marketplace-grid" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <li key={index} className="marketplace-card is-skeleton">
          <div className="marketplace-card__head">
            <span className="marketplace-skeleton is-icon" />
            <div className="marketplace-card__ident">
              <span className="marketplace-skeleton" style={{ width: `${52 + index * 7}%`, height: 13 }} />
              <span className="marketplace-skeleton" style={{ width: `${30 + index * 5}%`, height: 10 }} />
            </div>
          </div>
          <span className="marketplace-skeleton" style={{ width: "94%", height: 10 }} />
          <span className="marketplace-skeleton" style={{ width: "72%", height: 10 }} />
          <div className="marketplace-card__foot">
            <span className="marketplace-skeleton" style={{ width: 80, height: 10 }} />
            <span className="marketplace-card__spacer" />
            <span className="marketplace-skeleton" style={{ width: 84, height: 26, borderRadius: 7 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MarketplaceInstallPanel({
  controller,
  jobs,
  snapshot,
  canManage,
  defaultOpen = false,
  view = false
}: {
  controller: MarketplaceInstallController;
  /** 任务控制器：市场安装受理后的任务与插件列表共用同一份，这里就地显示进度。 */
  jobs?: ManagedExtensionsController;
  snapshot: SettingsSnapshot | null;
  canManage: boolean;
  /** 作为设置内的独立安装视图时默认展开，不显示额外的「从市场安装」开关。 */
  defaultOpen?: boolean;
  view?: boolean;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const jobState = useSyncExternalStore(jobs?.subscribe ?? subscribeNoJobs, jobs?.getState ?? getNoJobs, jobs?.getState ?? getNoJobs);
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");
  const [confirmKey, setConfirmKey] = useState<MarketplaceSigningKey | null>(null);
  const enabled = !!snapshot?.extensionInstallations && canManage;

  useEffect(() => {
    if (enabled && open && state.sources.length === 0 && !state.searching) void controller.load();
  }, [enabled, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const installedIndex = useMemo(() => {
    const map = new Map<string, { version?: string; icon?: string }>();
    for (const entry of snapshot?.installedExtensions ?? []) {
      map.set(entry.id, { ...(entry.version ? { version: entry.version } : {}), ...(entry.icon ? { icon: entry.icon } : {}) });
    }
    return map;
  }, [snapshot]);

  if (!enabled) return null;

  const selected = state.selected;
  const detail = selected?.detail ?? null;
  const version = detail?.extension.versions.find((entry) => entry.version === selected?.version) ?? null;
  const trusted = detail && selected?.version ? versionTrusted(detail, selected.version) : null;
  const signingKey = version?.keyId ? detail?.signingKeys.find((key) => key.keyId === version.keyId) ?? null : null;
  // 进行中的任务全显示；都结束后只留最近一条，避免历史「已完成」堆在面板里。
  const scopedJobs = selected ? jobState.jobs.filter((job) => job.extensionId === selected.extensionId) : jobState.jobs;
  const runningJobs = scopedJobs.filter((job) => job.status === "running");
  const visibleJobs = runningJobs.length > 0 ? runningJobs : scopedJobs.slice(0, 1);
  const builtinInstalled = detail?.installedKind === "builtin" ? detail.installedVersion : undefined;
  const selectedIsNewer = selected?.version && builtinInstalled ? compareSemver(selected.version, builtinInstalled) > 0 : true;
  const isCurrent = Boolean(selected?.version && detail?.installedVersion === selected.version);
  const canInstall = Boolean(selected?.version) && !state.installing && selectedIsNewer && !isCurrent;
  const upgradeLabel =
    selected?.version && detail?.installedVersion && compareSemver(selected.version, detail.installedVersion) > 0
      ? `升级到 v${selected.version}`
      : `安装 v${selected?.version ?? ""}`;

  const openDetail = (extensionId: string) => {
    setConfirmKey(null);
    void controller.select(extensionId);
  };

  /** 卡片上的主操作：按精确版本直接安装，不切详情（信任与失败语义仍由宿主判定）。 */
  const quickInstall = (extensionId: string, versionToInstall: string) => {
    setConfirmKey(null);
    void controller.installListed(extensionId, versionToInstall);
  };

  const status = state.searching
    ? state.sources.length === 0
      ? "正在读取市场…"
      : "搜索中…"
    : state.refreshing
      ? "正在刷新…"
      : state.fetchedAt
        ? `更新于 ${formatTime(state.fetchedAt)}`
        : null;

  const versionMeta = (entry: MarketplaceVersionInfo) => (
    <ul className="marketplace-detail__meta" data-testid="marketplace-version-meta">
      <li>大小：{formatSize(entry.size)}</li>
      {formatDate(entry.publishedAt) ? <li>发布时间：{formatDate(entry.publishedAt)}</li> : null}
      {entry.engines ? <li>运行环境：宿主 {entry.engines.hostAbi} · SDK {entry.engines.sdkAbi} · 协议 {entry.engines.protocolVersion}</li> : null}
      {entry.dependencies ? <li>依赖：{Object.entries(entry.dependencies).map(([id, range]) => `${id}@${range}`).join("、")}</li> : null}
      <li>
        签名公钥：
        {entry.keyId ? `${entry.keyId}${trusted === true ? "（本机已信任）" : trusted === false ? "（本机未信任）" : ""}` : "来源未声明；安装时按本机信任根校验"}
      </li>
    </ul>
  );

  return (
    <div className={view ? "marketplace-install is-view" : "marketplace-install"} data-testid="marketplace-install">
      {!view ? (
        <div className="managed-install__row">
          <Button size="sm" tone={open ? "primary" : "neutral"} onClick={() => setOpen(!open)} data-testid="marketplace-install-toggle">
            从市场安装
          </Button>
          <span className="settings-page__hint">从服务端团队市场搜索并安装；签名公钥必须先被本机信任。</span>
        </div>
      ) : null}
      {open ? (
        <div className="marketplace-install__body" data-testid="marketplace-install-body">
          {selected ? (
            <section className="marketplace-detail" data-testid="marketplace-detail">
              <button className="marketplace-detail__back" onClick={() => { setConfirmKey(null); controller.close(); }}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7M19 12H5" /></svg>
                返回列表
              </button>
              <div className="marketplace-detail__hero">
                <span className="marketplace-icon is-large" aria-hidden="true">
                  <PluginGlyph icon={detail?.extension.icon ?? installedIndex.get(selected.extensionId)?.icon} size={23} />
                </span>
                <div className="marketplace-detail__ident">
                  <div className="marketplace-detail__title">
                    <h3>{detail?.extension.label ?? selected.extensionId}</h3>
                    {detail?.installedVersion ? (
                      <span className="marketplace-badge is-ok" data-testid="marketplace-installed-version">
                        {detail.installedKind === "builtin" ? "内置" : "本机"} v{detail.installedVersion}
                      </span>
                    ) : null}
                    {detail?.updateAvailable && detail.latestVersion ? (
                      <span className="marketplace-badge is-up" data-testid="marketplace-update-available">
                        可升级到 v{detail.latestVersion}
                      </span>
                    ) : null}
                  </div>
                  <p className="marketplace-detail__sub">
                    {selected.extensionId}
                    {state.sourceId ? ` · ${state.sources.find((source) => source.sourceId === state.sourceId)?.label ?? state.sourceId}` : ""}
                  </p>
                </div>
              </div>
              {usefulDescription({ extensionId: selected.extensionId, ...(detail?.extension.description ? { description: detail.extension.description } : {}) }) ? (
                <p className="marketplace-detail__desc">{usefulDescription({ extensionId: selected.extensionId, ...(detail?.extension.description ? { description: detail.extension.description } : {}) })}</p>
              ) : null}
              {selected.loading ? <p className="settings-page__hint" role="status">正在读取版本…</p> : null}
              {state.error ? <p className="settings-page__error" role="alert" data-testid="marketplace-error">{state.error}</p> : null}
              {state.notice ? <p className="settings-page__hint" role="status" data-testid="marketplace-notice">{state.notice}</p> : null}
              {detail && detail.extension.versions.length > 0 ? (
                <>
                  <div className="marketplace-detail__cols">
                    <section>
                      <h4 className="marketplace-detail__section">版本</h4>
                      <ul className="marketplace-versions">
                        {detail.extension.versions.map((entry) => (
                          <li key={entry.version}>
                            <button
                              className={`marketplace-version${entry.version === selected.version ? " is-on" : ""}`}
                              onClick={() => controller.chooseVersion(entry.version)}
                            >
                              <span className="marketplace-version__radio" />
                              <span className="marketplace-version__label">v{entry.version}</span>
                              {detail.installedVersion === entry.version ? <span className="marketplace-badge is-ok">已安装</span> : null}
                              {entry.state === "yanked" ? <span className="marketplace-badge is-warn">已撤回</span> : null}
                              <span className="marketplace-version__spacer" />
                              <span className="marketplace-version__date">{formatDate(entry.publishedAt) ?? "—"}</span>
                              <span className="marketplace-version__size">{formatSize(entry.size)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                      {version ? versionMeta(version) : null}
                    </section>
                    <section>
                      <h4 className="marketplace-detail__section">安装后</h4>
                      <dl className="marketplace-kv">
                        <dt>生效方式</dt>
                        <dd>{state.items.find((item) => item.extensionId === selected.extensionId)?.hotReload === true ? "热加载，无需重启宿主" : "按扩展声明生效；需要重启时会在任务里提示"}</dd>
                        <dt>启停</dt>
                        <dd>安装后可在插件列表中随时启用 / 停用</dd>
                      </dl>
                    </section>
                  </div>
                  {trusted === false ? (
                    <div className="marketplace-detail__warn" role="status" data-testid="marketplace-untrusted">
                      签名公钥未被本机信任，安装会失败。
                      {signingKey ? (
                        <Button size="sm" tone="ghost" disabled={state.trusting !== null} onClick={() => setConfirmKey(signingKey)} data-testid="marketplace-trust">
                          信任此公钥
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {confirmKey ? (
                    <div className="marketplace-detail__confirm" role="alertdialog" data-testid="marketplace-trust-confirm">
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
                  {!selectedIsNewer ? (
                    <p className="settings-page__hint" data-testid="marketplace-builtin-not-newer">
                      内置版本 v{builtinInstalled} 不低于所选版本；同一扩展只允许从市场安装更高的版本。
                    </p>
                  ) : null}
                  <footer className="marketplace-detail__foot">
                    <span className="settings-page__hint">
                      {state.installingId === selected.extensionId ? "正在安装…" : detail.installedVersion === selected.version ? `当前已安装 v${selected.version}` : `将安装 v${selected.version} · ${formatSize(version?.size ?? 0)}`}
                    </span>
                    <span className="marketplace-detail__spacer" />
                    <Button size="sm" tone="ghost" onClick={() => { setConfirmKey(null); controller.close(); }}>取消</Button>
                    <Button size="sm" tone="primary" disabled={!canInstall} onClick={() => void controller.install()} data-testid="marketplace-install-submit">
                      {state.installingId === selected.extensionId ? "安装中…" : isCurrent ? `已安装 v${selected.version}` : upgradeLabel}
                    </Button>
                  </footer>
                </>
              ) : null}
            </section>
          ) : (
            <>
              {state.sources.length === 0 && !state.searching ? (
                <p className="settings-page__hint" data-testid="marketplace-no-source">当前没有可用的市场来源（需要连接服务端）。</p>
              ) : null}
              {state.sources.length > 1 ? (
                <div className="marketplace-sources" role="tablist" aria-label="市场来源">
                  {state.sources.map((source) => (
                    <button
                      key={source.sourceId}
                      className={`marketplace-source${source.sourceId === state.sourceId ? " is-on" : ""}`}
                      onClick={() => void controller.setSource(source.sourceId)}
                      role="tab"
                      aria-selected={source.sourceId === state.sourceId}
                    >
                      {source.label}
                      {source.ok ? null : <span className="marketplace-source__bad">不可用</span>}
                    </button>
                  ))}
                </div>
              ) : null}
              {state.unavailableReason ? (
                <p className="settings-page__hint" data-testid="marketplace-unavailable">{state.unavailableReason}</p>
              ) : null}
              {state.sourceId && !state.unavailableReason ? (
                <div className="marketplace-toolbar">
                  <form
                    className="marketplace-search"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void controller.search(text.trim());
                    }}
                  >
                    <span className="marketplace-search__icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                    </span>
                    <TextInput value={text} placeholder="搜索扩展名称、ID 或描述" onChange={(event) => setText(event.currentTarget.value)} data-testid="marketplace-search-input" />
                    <Button size="sm" type="submit" disabled={state.searching}>搜索</Button>
                  </form>
                  <Button size="sm" tone="ghost" onClick={() => void controller.refresh()} title="刷新" className="marketplace-refresh">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={state.refreshing ? "is-spinning" : undefined}><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" /></svg>
                  </Button>
                </div>
              ) : null}
              {state.error ? <p className="settings-page__error" role="alert" data-testid="marketplace-error">{state.error}</p> : null}
              {state.notice ? <p className="settings-page__hint" role="status" data-testid="marketplace-notice">{state.notice}</p> : null}
              {status || (state.sourceId && !state.unavailableReason) ? (
                <div className="marketplace-status">
                  {status ? (
                    <span className="marketplace-status__time">
                      {state.searching || state.refreshing ? <span className="marketplace-spinner" aria-hidden="true" /> : null}
                      {status}
                    </span>
                  ) : null}
                  {state.sourceId && !state.unavailableReason ? (
                    <span className="marketplace-status__count">{state.items.length} 个扩展{state.query ? ` · 搜索“${state.query}”` : ""}</span>
                  ) : null}
                </div>
              ) : null}
              {state.searching && state.items.length === 0 ? <Skeleton /> : null}
              {state.items.length > 0 ? (
                <ul className="marketplace-grid" data-testid="marketplace-results" style={{ opacity: state.searching ? 0.45 : 1 }}>
                  {state.items.map((item) => (
                    <ExtensionCard
                      key={item.extensionId}
                      item={item}
                      installedVersion={installedIndex.get(item.extensionId)?.version}
                      installedIcon={installedIndex.get(item.extensionId)?.icon}
                      installing={state.installingId === item.extensionId}
                      onOpen={() => openDetail(item.extensionId)}
                      onInstall={() => void quickInstall(item.extensionId, item.latest)}
                    />
                  ))}
                </ul>
              ) : null}
              {!state.searching && state.sourceId && !state.unavailableReason && state.items.length === 0 && !state.error ? (
                <p className="settings-page__hint" data-testid="marketplace-empty">没有找到扩展。</p>
              ) : null}
            </>
          )}
          {visibleJobs.length > 0 ? (
            <ul className="managed-install__jobs" data-testid="marketplace-jobs">
              {visibleJobs.map((job) => {
                const jobView = describeJob(job);
                return (
                  <li key={job.jobId} className="managed-install__job" data-tone={jobView.tone} data-testid={`marketplace-job-${job.jobId}`}>
                    <span className="managed-install__job-title">{jobView.title}</span>
                    <span className="managed-install__job-detail" data-testid={`marketplace-job-detail-${job.jobId}`}>{jobView.detail}</span>
                    {job.status === "running" ? (
                      <Button size="sm" tone="ghost" onClick={() => void jobs?.cancel(job.jobId)}>取消</Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
