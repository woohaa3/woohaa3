import { useMemo, useState } from "react";
import type { AgentConnectionView, McpInstallClient, ServiceConnectionView } from "@woohaa3/contracts";
import { McpConnectionPanel, type McpPanelSnapshot } from "../../../../frontend/src/cordis/plugins/agent-assistant/mcp-connection-panel.js";
import { CapabilityOverview } from "../../../../frontend/src/cordis/plugins/agent-assistant/capability-pages.js";
import type { McpInstallationRemote } from "../../../../frontend/src/cordis/services/mcp-installation-remote.js";
import { IntegrationStage, PendingActions, ScenarioPicker, useRecorder, type Scenario } from "./memory.js";
import "../../../../frontend/src/cordis/plugins/agent-assistant/style.css";
export function CapabilityIntegration() {
  const [mcp, setMcp] = useState<McpPanelSnapshot | null>(null);
  const [scenario, select] = useState<Scenario>("ready"); const { record, log } = useRecorder();
  const ready = scenario !== "error";
  const local: AgentConnectionView[] = scenario === "empty" ? [] : [{ connectionId: "memory-agent", adapterId: "codex-appserver", extensionId: "local-agent", name: "内存本地助手", runCategory: "local-appserver", authMode: "local-login", configRevision: 1, credentialEpoch: 1, ready, credentialConfigured: ready, models: [], capabilities: { discussion: true, imageInput: false, tools: true, structuredResult: false, cancel: true, resume: false }, status: { transport: { state: ready ? "ready" : "failed" }, credential: { state: "unknown" }, modelAccess: { state: "unknown" }, tools: { state: "ready" } } }];
  const sources: ServiceConnectionView[] = scenario === "empty" ? [] : [{ serviceConnectionId: "memory-source", name: "内存提供商", scope: "personal", kind: "api", configRevision: 1, credentialEpoch: 1, enabled: true, credentialConfigured: ready, removed: false, locked: false, managedByAdministrator: false, endpoints: [], capabilities: [], bindings: [] }];
  const fixture = useMemo(() => {
    const waiting: Array<() => void> = [];
    const client: McpInstallClient = { id: "codex", label: "Codex", group: "cli", configPath: "/fixture/codex.toml", configured: false, targets: [{ key: "default", label: "内存配置", path: "/fixture/codex.toml", configured: false }] };
    let detectFail = scenario === "error", installFail = true;
    const remote: McpInstallationRemote = {
      async detect() { record("MCP 检测"); if (scenario === "loading") await new Promise<void>(resolve => waiting.push(resolve));
        if (detectFail) { detectFail = false; return { ok: false, code: "fixture", error: "客户端检测失败，重试恢复" }; }
        return { ok: true, value: { clients: scenario === "empty" ? [] : [client] } }; },
      async install(id, key) { record(`安装 ${id}/${key}`); if (installFail) { installFail = false; return { ok: false, code: "fixture", error: "内存安装失败，请重试" }; }
        client.configured = true; client.targets[0]!.configured = true;
        return { ok: true, value: { client, changed: true } }; }
    };
    return { remote, settle: () => { waiting.splice(0).forEach(resolve => resolve()); record("完成检测"); } };
  }, [scenario]);
  return <IntegrationStage title="能力中心 / MCP 检测与安装">
    <ScenarioPicker value={scenario} onChange={select} /><PendingActions settle={fixture.settle} />
    <CapabilityOverview local={local} sources={sources} loading={scenario === "loading"} sourceLoading={scenario === "loading"} sourceError={scenario === "error" ? "目录读取失败" : null} mcp={mcp} onNavigate={page => record(`打开 ${page}`)} onAdd={() => record("添加连接")} />
    <McpConnectionPanel key={scenario} remote={fixture.remote} onStatusChange={setMcp} />{log}
  </IntegrationStage>;
}
