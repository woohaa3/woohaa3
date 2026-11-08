/**
 * Provider 配置卡片（紧凑视图）：Provider 凭据弹窗与设置页共用。
 *
 * 每个已装载的 Provider 一组，复用同一份配置和密钥仓库。AI 面板的 compact 模式默认只展示
 * 主密钥，以及没有默认值又还没填的连接地址；其他配置放高级设置，按 Provider 合并保存。
 * 完整设置页继续按项编辑。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import "./settings.css";
import type { SettingsEntryView, SettingsWriteValue } from "@woohaa3/contracts";
import { Switch } from "@woohaa3/ui/primitives";
import { Button } from "@woohaa3/ui/primitives";
import type { BackendSettingsStore } from "./backend-settings-store.js";
import { SettingRow } from "./setting-row.js";
import { providerConfigGroups } from "./plugin-groups.js";
import { PluginIconMark } from "./plugin-icons.js";

export function ProviderSettingsCards({
  store,
  secretsOnly = false,
  compact = false,
  providerId,
  onSaved,
}: {
  store: BackendSettingsStore;
  secretsOnly?: boolean;
  providerId?: string;
  onSaved?: () => void;
  /** AI 面板只展示连接所需的字段，按 Provider 一次保存。 */
  compact?: boolean;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => {
    void store.load();
  }, [store]);
  if (state.status === "loading") return <p className="settings-page__hint" role="status">正在读取 Provider 配置…</p>;
  if (state.status === "unauthorized") {
    return (
      <p className="settings-page__hint" data-testid="provider-settings-unauthorized">
        需要管理员权限才能查看和修改 Provider 配置。
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
  const groups = providerConfigGroups(state.snapshot)
    .filter(group => !providerId || group.providerId === providerId)
    .map((group) => ({ ...group, entries: secretsOnly ? group.entries.filter((entry) => entry.secret) : group.entries }))
    .filter((group) => group.entries.length > 0);
  if (groups.length === 0) {
    return <p className="settings-page__hint" data-testid="provider-settings-empty">没有已装载的 Provider。</p>;
  }
  return (
    <div className={compact ? "provider-settings__grid" : undefined} data-testid="provider-settings-list">
      {groups.map((group) => (
        <section key={group.id} className="provider-settings__card" data-provider-id={group.providerId ?? group.id}>
          <h3 className="settings-page__group-title"><span className="plugin-card__head">{group.icon ? <PluginIconMark icon={group.icon} /> : null}{group.label}</span></h3>
          {compact ? <ConnectionSettingsForm entries={group.entries} store={store} onSaved={onSaved} /> : <ul className="settings-page__list" data-testid={`provider-settings-${group.providerId ?? group.id}`}>
            {group.entries.map((entry) => (
              <SettingRow key={`${entry.key}:${String(entry.value)}:${entry.configured}`} entry={entry} store={store} />
            ))}
          </ul>}
        </section>
      ))}
    </div>
  );
}

/**
 * 连接必需、但还没有取值的地址字段（例如 LiteLLM 的网关地址）。
 *
 * 这类字段没有默认值，Provider 的可用性又要求它与主凭据同时就绪（`apiKey` 与网关地址都齐才算
 * available）。把它藏进「高级设置」会让用户只看到主密钥、Provider 却一直不可用。未填写时与主
 * 凭据并列展示，填好之后收回高级设置。
 */
function missingEndpoint(entry: SettingsEntryView): boolean {
  return entry.kind === "url" && (entry.value === null || entry.value === "");
}

/** 只记录用户编辑的字段，其他 Provider 刷新快照时不覆盖未保存的草稿。 */
export function ConnectionSettingsForm({ entries, store, onSaved, primaryKeys }: { entries: SettingsEntryView[]; store: BackendSettingsStore; onSaved?: () => void; primaryKeys?: readonly string[] }) {
  const [drafts, setDrafts] = useState<Record<string, SettingsWriteValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState<string | null>(null);
  const primary = entries.filter(entry => (primaryKeys ? primaryKeys.includes(entry.key) : entry.key.endsWith(".apiKey")) || entry.lockedBy !== null || entry.pendingRestart || missingEndpoint(entry));
  const advanced = entries.filter(entry => !primary.includes(entry));
  const update = (entry: SettingsEntryView, value: SettingsWriteValue) => {
    setSaved(false);
    setDrafts(previous => {
      const next = { ...previous };
      if ((entry.secret && typeof value === "string" && value.trim() === "") || value === entry.value) delete next[entry.key];
      else next[entry.key] = value;
      return next;
    });
  };
  const save = async () => {
    if (busy || Object.keys(drafts).length === 0) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    // 锁定项不参与写入；空密钥表示保留，只有确认清除才写 null。
    const values = Object.fromEntries(Object.entries(drafts).filter(([key]) => entries.some(entry => entry.key === key && entry.lockedBy === null)).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]));
    try {
      const result = await store.save(values);
      if (result.ok) { setDrafts({}); setSaved(true); setClearing(null); onSaved?.(); }
      else setError(result.issues.map(issue => `${entries.find(entry => entry.key === issue.key)?.label ?? "配置"}：${issue.message}`).join("；") || result.error);
    } catch { setError("保存失败，请重试。"); }
    finally { setBusy(false); }
  };
  const field = (entry: SettingsEntryView) => {
    const edited = Object.hasOwn(drafts, entry.key);
    const value = edited ? drafts[entry.key] : entry.secret ? "" : entry.value ?? "";
    const locked = entry.lockedBy !== null;
    // 去掉标签复述、请求头实现和已展示的默认值，保留区域、格式等使用约束。
    const subject = entry.label.split(/\s+/).at(-1) ?? entry.label;
    const hint = entry.description.split(/[。；]/).filter(part => part.trim() && !part.includes("请求头") && !part.trim().endsWith(subject) && part.trim() !== String(entry.value ?? "") && !/^默认 https?:\/\/\S+$/.test(part.trim())).join("。");
    return <div className="provider-connection__field" data-setting-key={entry.key} key={entry.key}>
      <label>
        <span>{entry.label}</span>
        {entry.kind === "boolean" ? <Switch checked={value === true} disabled={locked || busy} onCheckedChange={next => update(entry, next)} /> : <input
          className="settings-page__input"
          type={entry.secret ? "password" : entry.kind === "integer" ? "number" : entry.kind === "url" ? "url" : "text"}
          autoComplete="off" spellCheck={false} disabled={locked || busy} value={value === null ? "" : String(value)}
          placeholder={edited && value === null ? "保存后清除" : entry.secret ? entry.configured ? "已配置；留空保留，填写则替换" : entry.label : ""}
          onChange={event => update(entry, entry.kind === "integer" ? Number(event.target.value) : event.target.value)}
        />}
      </label>
      {hint ? <p className="settings-page__hint">{hint}</p> : null}
      {locked ? <p className="settings-page__hint">由环境变量 {entry.lockedBy} 锁定，移除后可修改。</p> : null}
      {entry.pendingRestart || entry.reload !== "hot" && edited ? <p className="settings-page__hint">{entry.pendingRestart ? "等待重启" : "重启后生效"}</p> : null}
      {!locked && (entry.source === "file" || entry.source === "secrets") ? <Button size="sm" tone="ghost" disabled={busy} onClick={() => setClearing(entry.key)}>清除{entry.label}</Button> : null}
      {clearing === entry.key ? <div className="provider-connection__confirmation"><span>清除{entry.label}？</span><Button size="sm" disabled={busy} onClick={() => setClearing(null)}>取消</Button><Button size="sm" tone="danger" disabled={busy} onClick={() => { setDrafts(previous => ({ ...previous, [entry.key]: null })); setSaved(false); setClearing(null); }}>确认清除</Button></div> : null}
    </div>;
  };
  return <form className="provider-connection" onSubmit={event => { event.preventDefault(); void save(); }}>
    {primary.map(field)}
    {advanced.length ? <details className="provider-connection__advanced"><summary>高级设置</summary>{advanced.map(field)}</details> : null}
    {error ? <p className="settings-page__error">{error}</p> : null}
    <div className="provider-connection__actions">{saved ? <span>已保存</span> : null}<Button size="sm" tone="primary" type="submit" loading={busy} disabled={busy || Object.keys(drafts).length === 0}>保存</Button></div>
  </form>;
}
