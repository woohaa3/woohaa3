import { useState } from "react";
import type { SettingsSnapshot } from "@woohaa3/contracts";
import { Button, SettingsFeedback } from "@woohaa3/ui";
import { SelectInput } from "@woohaa3/ui/forms";
import type { BackendSettingsStore } from "../settings/backend-settings-store.js";
import { ConnectionSettingsForm } from "../settings/provider-settings-cards.js";
import { providerConfigGroups, settingsPartition } from "../settings/plugin-groups.js";

/** Use the same credential form and settings authority as the model-provider drawer. */
export function HostingOwnerConfiguration({ ownerId, snapshot, store, onSaved }: {
  ownerId: string; snapshot: SettingsSnapshot; store: BackendSettingsStore; onSaved: () => void;
}) {
  const provider = providerConfigGroups(snapshot).find(group => group.id === ownerId);
  const group = provider ?? settingsPartition(snapshot).groups.find(group => group.id === ownerId);
  if (!group?.entries.length) return <SettingsFeedback tone="warning">当前来源没有可编辑的配置。请检查扩展是否已启用。</SettingsFeedback>;
  return <ConnectionSettingsForm entries={group.entries} store={store} onSaved={onSaved}
    primaryKeys={provider ? undefined : group.entries.filter(entry => entry.kind === "boolean").map(entry => entry.key)} />;
}

/** Editing the policy never uploads media or changes the selected provider's credentials. */
export function HostingRouteConfiguration({ snapshot, store, onSaved }: {
  snapshot: SettingsSnapshot; store: BackendSettingsStore; onSaved: () => void;
}) {
  const route = snapshot.extensionPoints?.temporaryHosting;
  const entry = snapshot.settings.find(item => item.key === "exposer.primary");
  const current = route?.mode === "manual" ? route.selectedId ?? String(entry?.value ?? "auto") : String(entry?.value || "auto");
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = [
    { value: "auto", label: "自动" },
    ...(snapshot.extensionPoints?.exposer ?? []).map(item => ({ value: item.id, label: item.label })),
  ];
  if (!options.some(option => option.value === draft)) options.push({ value: draft, label: `${draft}（未注册）` });
  const locked = !entry || entry.lockedBy !== null;
  const save = async () => {
    if (locked || busy || draft === current) return;
    setBusy(true); setError(null);
    try {
      const result = await store.save({ "exposer.primary": draft });
      if (result.ok) onSaved();
      else setError(result.issues.find(issue => issue.key === "exposer.primary")?.message ?? result.error);
    } catch { setError("保存失败，请重试。"); }
    finally { setBusy(false); }
  };
  return <form className="provider-connection" onSubmit={event => { event.preventDefault(); void save(); }}>
    <SelectInput label="临时图床来源" value={draft} options={options} onValueChange={value => { setDraft(value); setError(null); }} disabled={locked || busy} />
    {entry?.lockedBy ? <p>由环境变量 {entry.lockedBy} 锁定。</p> : !entry ? <SettingsFeedback tone="warning">当前宿主未提供临时图床配置。</SettingsFeedback> : null}
    {error ? <SettingsFeedback tone="danger">{error}</SettingsFeedback> : null}
    <div className="provider-connection__actions"><Button size="sm" tone="primary" type="submit" loading={busy} disabled={locked || busy || draft === current}>保存</Button></div>
  </form>;
}
