import { useEffect, useMemo, useState } from "react";
import type { SettingsEntryView, SettingsSnapshot, SettingsWriteValue } from "@woohaa3/contracts";
import { SettingsWorkspace } from "../../../../frontend/src/cordis/plugins/settings/workspace/settings-workspace.js";
import { ProviderSettingsCards } from "../../../../frontend/src/cordis/plugins/settings/provider-settings-cards.js";
import { createBackendSettingsStore } from "../../../../frontend/src/cordis/plugins/settings/backend-settings-store.js";
import { createSettingsEditSession } from "../../../../frontend/src/cordis/plugins/settings/edit-session.js";
import { createExtensionManagerFacade } from "../../../../frontend/src/cordis/plugins/extension-manager/facade.js";
import { AppThemeService } from "../../../../frontend/src/cordis/services/theme/service.js";
import { createRuntimeComponentsStore } from "../../../../frontend/src/cordis/services/runtime-components.js";
import { Button } from "@woohaa3/ui/primitives";
import { IntegrationStage, PendingActions, ScenarioPicker, useRecorder, type Scenario } from "./memory.js";
import "../../../../frontend/src/cordis/plugins/settings/settings.css";
const entry = (key: string, extra: Partial<SettingsEntryView> = {}): SettingsEntryView => ({ key, label: key, description: "内存配置，不写本机文件", kind: "string", reload: "hot", secret: false, source: "file", lockedBy: null, value: "", configured: false, pendingRestart: false, ...extra });
export function createSettingsFixture(record: (event: string) => void, scenario: Scenario) {
  let fail = scenario === "error";
  let snapshot: SettingsSnapshot = {
    settings: scenario === "empty" ? [] : [entry("telemetry.enabled", { kind: "boolean", value: true }), entry("canvas.label"), entry("canvas.locked", { lockedBy: "FIXTURE_LOCK", value: "只读" }), entry("providers.fixture.apiKey", { secret: true, ownerExtensionId: "fixture-provider" }), entry("providers.fixture.baseUrl", { kind: "url", value: "https://example.invalid", ownerExtensionId: "fixture-provider" })],
    plugins: scenario === "empty" ? [] : [{ id: "fixture-provider", label: "长名称的内存 Provider".repeat(4), description: "设置与插件列表使用同一生产组件", layer: "extension", settingCount: 2, siteManaged: false, provider: true }],
    installedExtensions: [{ id: "fixture-provider", label: "内存 Provider", description: "展示配置", directory: "/fixture", writable: false }],
    files: { config: "/fixture/config.yml", secrets: "/fixture/secrets.yml" }
  };
  const waiting: Array<() => void> = [];
  let hold = scenario === "loading";
  const wait = async () => { if (hold) await new Promise<void>(resolve => waiting.push(resolve)); };
  const backend = createBackendSettingsStore({
    async fetchSnapshot() { record("读取设置"); await wait(); return { ok: true, snapshot }; },
    async write(values: Record<string, SettingsWriteValue>) {
      record(`写入 ${Object.keys(values).join(",")}`); await wait();
      if (fail) { fail = false; return { ok: false, code: "fixture", error: "内存保存失败，请重试" }; }
      snapshot = { ...snapshot, settings: snapshot.settings.map(item => item.key in values ? { ...item, configured: values[item.key] !== null, value: item.secret ? null : values[item.key]! } : item) };
      return { ok: true, snapshot };
    }
  });
  const fetcher: typeof fetch = async () => { record("读取内存运行时状态"); return Response.json({ available: false, components: [] }); };
  const runtimeComponents = { source: createRuntimeComponentsStore(fetcher), fetcher };
  const editSession = createSettingsEditSession();
  const theme = new AppThemeService({ storage: null, restore: false });
  const manager = createExtensionManagerFacade({ catalog: [], ids: [], assembled: {}, refresh: () => record("刷新扩展"), site: { canManageSite: () => true } });
  return { backend, theme, runtimeComponents, extensions: manager.facade, editSession, hold: () => { hold = true; }, settle: () => { hold = false; waiting.splice(0).forEach(resolve => resolve()); record("结算保存"); }, failNext: () => { fail = true; }, dispose: () => { theme.dispose(); manager.dispose(); editSession.reset(); } };
}
export function SettingsIntegration() {
  const [scenario, select] = useState<Scenario>("ready"); const { record, log } = useRecorder();
  // Recorder has stable ownership through this facade; source recreation is scenario-controlled.
  const fixture = useMemo(() => createSettingsFixture(record, scenario), [scenario]);
  const [closed, close] = useState(false);
  useEffect(() => () => fixture.dispose(), [fixture]);
  return <IntegrationStage title="设置工作区 / Provider / 插件管理">
    <ScenarioPicker value={scenario} onChange={v => { close(false); select(v); }} />
    <Button onClick={() => { fixture.hold(); record("保持后续请求进行中"); }}>保持保存中</Button><PendingActions settle={fixture.settle} />
    <Button onClick={() => { fixture.failNext(); record("下次保存失败"); }}>下次保存失败</Button>
    {!closed && <div style={{ height: 600 }}><SettingsWorkspace key={scenario} {...fixture} initialSection="backend" onRequestClose={() => {
      if (fixture.editSession.isPending() || fixture.editSession.isDirty()) { record("退出保护拒绝关闭"); return; } close(true); record("关闭设置");
    }} onRequestNavigate={() => { const allowed = !fixture.editSession.isPending() && !fixture.editSession.isDirty(); record(`导航 ${allowed ? "允许" : "拒绝"}`); return allowed; }} /></div>}
    <ProviderSettingsCards store={fixture.backend} compact />{log}
  </IntegrationStage>;
}
