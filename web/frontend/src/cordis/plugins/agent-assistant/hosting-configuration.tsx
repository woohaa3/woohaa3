import type { SettingsSnapshot } from "@woohaa3/contracts";
import { Button, SettingsFeedback } from "@woohaa3/ui";
import { useSlot } from "../../host.js";
import type { BackendSettingsStore } from "../settings/backend-settings-store.js";
import { ConnectionSettingsForm } from "../settings/provider-settings-cards.js";
import { providerConfigGroups, settingsPartition } from "../settings/plugin-groups.js";

/** Use the same credential form and settings authority as the model-provider drawer. */
export function HostingOwnerConfiguration({ ownerId, snapshot, store, onSaved }: {
  ownerId: string; snapshot: SettingsSnapshot; store: BackendSettingsStore; onSaved: () => void;
}) {
  // 来源的就绪条件可能不是设置项（例如要求先登录账号）：有专用贡献时交给扩展自己。
  const contributions = useSlot("agent-assistant.hosting-source");
  const contribution = contributions.find(entry => entry.ownerExtensionId === ownerId);
  if (contribution) {
    const Source = contribution.render;
    return <Source onSaved={onSaved} />;
  }
  const provider = providerConfigGroups(snapshot).find(group => group.id === ownerId);
  const group = provider ?? settingsPartition(snapshot).groups.find(group => group.id === ownerId);
  if (!group?.entries.length) return <SettingsFeedback tone="warning">当前来源没有可编辑的配置。请检查扩展是否已启用。</SettingsFeedback>;
  return <ConnectionSettingsForm entries={group.entries} store={store} onSaved={onSaved}
    primaryKeys={provider ? undefined : group.entries.filter(entry => entry.kind === "boolean").map(entry => entry.key)} />;
}

/** Unconfigured sources can be set up here; priority is edited in the provider list. */
export function HostingSourceConfiguration({ snapshot, onOpenOwner }: {
  snapshot: SettingsSnapshot; onOpenOwner: (ownerId: string) => void;
}) {
  const candidates = snapshot.extensionPoints?.temporaryHosting?.candidates.filter(candidate => !candidate.configured && candidate.ownerExtensionId) ?? [];
  return candidates.length ? <ul className="agent-assistant__list">{candidates.map(candidate => <li key={candidate.exposerId}>
    <div className="agent-assistant__identity"><strong>{candidate.label}</strong><p>{candidate.statusNote ?? "未配置"}</p></div>
    <Button size="sm" tone="ghost" onClick={() => onOpenOwner(candidate.ownerExtensionId!)}>配置</Button>
  </li>)}</ul> : <p className="agent-assistant__empty-note">所有图床提供商均已配置。</p>;
}
