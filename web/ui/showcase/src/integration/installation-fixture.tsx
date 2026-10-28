import { useEffect, useMemo, useState } from "react";
import type { ExtensionInstallJobView, SettingsSnapshot } from "@woohaa3/contracts";
import { createMarketplaceInstallController } from "../../../../frontend/src/cordis/plugins/settings/marketplace-install.js";
import { createManagedExtensionsController } from "../../../../frontend/src/cordis/plugins/settings/managed-extensions.js";
import { MarketplaceInstallPanel } from "../../../../frontend/src/cordis/plugins/settings/marketplace-install-ui.js";
import { Button } from "@woohaa3/ui/primitives";
import { IntegrationStage, PendingActions, ScenarioPicker, useRecorder, type Scenario } from "./memory.js";
export function createInstallationFixture(record: (event: string) => void, scenario: Scenario) {
  let fail = scenario === "error", hold = scenario === "loading", trusted = "";
  const waiting: Array<() => void> = [];
  const jobs = new Map<string, ExtensionInstallJobView>();
  const timers = new Set<() => void>();
  const accept = async () => {
    record("提交内存安装");
    if (fail) { fail = false; return { ok: false as const, code: "unavailable", error: "内存安装失败，请重试" }; }
    const job: ExtensionInstallJobView = { jobId: `memory-${jobs.size}`, action: "install", sourceId: "memory", extensionId: "fixture", version: "1.0.0", status: "running", phase: "download", startedAt: "2026-10-28T08:00:00Z" };
    jobs.set(job.jobId, job); return { ok: true as const, jobId: job.jobId, job };
  };
  const managed = createManagedExtensionsController({
    remote: {
      installFile: accept, uninstall: accept, rollback: accept,
      job: async id => ({ ok: true, job: { ...jobs.get(id)!, status: "succeeded", outcome: "installed" } }),
      cancel: async id => ({ ok: true, job: { ...jobs.get(id)!, status: "cancelled" } }),
      restart: async () => { record("内存重启"); return { ok: true }; }
    }, reload: async () => { record("刷新内存插件列表"); },
    setTimer: callback => { timers.add(callback); return callback; }, clearTimer: callback => { timers.delete(callback as () => void); }
  });
  const controller = createMarketplaceInstallController({ remote: {
    async search() { record("搜索内存市场"); if (hold) await new Promise<void>(resolve => waiting.push(resolve)); return { ok: true, items: scenario === "empty" ? [] : [{ extensionId: "fixture", label: "内存扩展", latest: "1.0.0", description: "不下载、不写文件" }], sources: [{ sourceId: "memory", label: "内存市场", ok: true }], unavailable: [] }; },
    async extension() { record("读取扩展版本"); return { ok: true, detail: { sourceId: "memory", extension: { extensionId: "fixture", label: "内存扩展", versions: [{ version: "1.0.0", packageDigest: "sha256:fixture", size: 1024, keyId: "fixture", engines: { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1 } }] }, trustedKeyIds: trusted ? ["fixture"] : [], signingKeys: [{ keyId: "fixture", publicKey: "MEMORY", trusted: !!trusted }] } }; },
    async versionStatus() { return null; },
    install: accept
  }, onJob: managed.track, readTrustedKeys: () => trusted, writeSetting: async (_key, value) => { trusted = value; record("保存内存信任根"); return { ok: true }; } });
  const snapshot: SettingsSnapshot = { settings: [], plugins: [], files: { config: "/fixture", secrets: "/fixture" }, extensionInstallations: { revision: 0, jobs: [], restartSupported: true, allowUnsignedLocal: false } };
  return { controller, managed, snapshot, failNext: () => { fail = true; }, settle: () => { hold = false; waiting.splice(0).forEach(resolve => resolve()); const pending = [...timers]; timers.clear(); pending.forEach(fn => fn()); record("推进内存安装"); } };
}
export function InstallationIntegration() {
  const [scenario, select] = useState<Scenario>("ready"); const { record, log } = useRecorder();
  const fixture = useMemo(() => createInstallationFixture(record, scenario), [record, scenario]);
  useEffect(() => () => fixture.managed.dispose(), [fixture]);
  return <IntegrationStage title="插件市场安装 / 信任 / 任务结果">
    <ScenarioPicker value={scenario} onChange={select} /><PendingActions settle={fixture.settle} /><Button onClick={fixture.failNext}>下次安装失败</Button>
    <MarketplaceInstallPanel key={scenario} controller={fixture.controller} jobs={fixture.managed} snapshot={fixture.snapshot} canManage defaultOpen view />{log}
  </IntegrationStage>;
}
