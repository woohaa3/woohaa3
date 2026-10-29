import { useEffect, useMemo, useState } from "react";
import { SdkAgentSettingsPanel } from "../../../../extensions/sdk-agent/src/frontend/settings-panel.js";
import type { SdkAgentRemote, SdkAgentConnectionView } from "../../../../extensions/sdk-agent/src/frontend/remote.js";
import { LocalAgentSettingsPanel } from "../../../../extensions/local-agent/src/frontend/settings-panel.js";
import type { LocalAgentRemote, LocalAgentConnectionView } from "../../../../extensions/local-agent/src/frontend/remote.js";
import { ChatGptAuthorizationRow } from "../../../../extensions/oauth-agent/src/frontend/authorization-row.js";
import { createChatGptService } from "../../../../extensions/oauth-agent/src/frontend/service.js";
import { RemoteServerSettingsPanel } from "../../../../extensions/remote-server/src/frontend/settings-panel.js";
import { createRemoteServerService } from "../../../../extensions/remote-server/src/frontend/remote.js";
import { LOCAL_ONLY_SNAPSHOT } from "../../../../extensions/remote-server/src/shared.js";
import { Button } from "@woohaa3/ui/primitives";
import { IntegrationStage, PendingActions, ScenarioPicker, useRecorder, type Scenario } from "./memory.js";
const ok = <T,>(value: T) => ({ ok: true as const, value });
export function createConfigurationFixture(record: (event: string) => void, scenario: Scenario) {
  let fail = scenario === "error", hold = scenario === "loading", authorized = false;
  const waiting: Array<() => void> = [];
  const perform = async (event: string) => { record(event); if (hold) await new Promise<void>(resolve => waiting.push(resolve)); if (fail) { fail = false; return false; } return true; };
  const connections: SdkAgentConnectionView[] = [];
  const sdk: SdkAgentRemote = {
    list: async () => ok({ connections: [...connections], adapters: scenario === "empty" ? [] : [{ adapterId: "responses", label: "长名称的 SDK 兼容服务".repeat(5), runCategory: "llm", authMode: "api-key", officialBaseUrl: "https://example.invalid/v1", allowCustomBaseUrl: true, requiresLocalRuntime: false, suggestedModels: ["fixture-model"] }] }),
    async configure(input) { if (!await perform("保存 SDK 配置")) return { ok: false, error: "保存失败，请重试" }; connections.splice(0, connections.length, { connectionId: "memory-sdk", adapterId: input.adapterId, name: "fixture", label: "长名称连接".repeat(8), authMode: "api-key", runCategory: "llm", configRevision: 1, credentialEpoch: 1, credentialConfigured: Boolean(input.secret), needsLocalRuntime: false, allowCustomBaseUrl: true, models: input.models ?? ["fixture-model"] }); return ok({ connectionId: "memory-sdk", models: ["fixture-model"] }); },
    async create(input) { return sdk.configure(input); },
    async saveCredential(input) {
      if (!await perform("保存凭据")) return { ok: false, error: "凭据保存失败，请重试" };
      const connection = connections.find(item => item.connectionId === input.connectionId);
      if (!connection) return { ok: false, error: "连接已失效" };
      connection.credentialConfigured = true; connection.credentialEpoch++;
      return ok({ credentialConfigured: true, credentialEpoch: connection.credentialEpoch });
    },
    async clearCredential(id) {
      if (!await perform("清除凭据")) return { ok: false, error: "凭据清除失败，请重试" };
      const connection = connections.find(item => item.connectionId === id);
      if (!connection) return { ok: false, error: "连接已失效" };
      connection.credentialConfigured = false; connection.credentialEpoch++;
      return ok({ credentialConfigured: false, credentialEpoch: connection.credentialEpoch });
    },
    async remove(id) { if (!await perform("删除 SDK 连接")) return { ok: false, error: "删除失败，请重试" }; const index = connections.findIndex(item => item.connectionId === id); if (index >= 0) connections.splice(index, 1); return ok({ removed: index >= 0 }); },
    async check() { return await perform("检测 SDK") ? ok({ transport: "ready", credential: "ready", modelAccess: "ready", tools: "unknown", note: "内存检测" }) : { ok: false, error: "连接失效" }; },
    async testGeneration() { record("内存测试调用"); return ok({ ok: true, model: "fixture-model", assistantText: "内存响应" }); }
  };
  const localConnections: LocalAgentConnectionView[] = [];
  const local: LocalAgentRemote = {
    async list() { if (!await perform("检测本地助手")) return { ok: false, error: "本地助手检测失败，请重试" }; return ok({ connections: [...localConnections], adapters: scenario === "empty" ? [] : [{ installed: true, running: false, managed: false, note: "内存工具", adapterId: "codex-appserver", label: "本地助手".repeat(12), transport: "stdio-jsonrpc", requiresLocalLogin: true, supportedVersions: "fixture" }], locationNote: "内存宿主" }); },
    async create() { record("启用本地助手"); localConnections.splice(0, localConnections.length, { connectionId: "memory-local", adapterId: "codex-appserver", name: "memory-local", label: "内存本地助手", runCategory: "agent", authMode: "local-login", configRevision: 1, requiresLocalLogin: true, executableInstalled: true, running: true }); return ok({ connectionId: "memory-local" }); },
    async check() { record("检测连接"); return ok({ transport: "ready", credential: "unknown", modelAccess: "unknown", tools: "unknown", note: "内存" }); },
    async remove() { record("移除本地助手"); localConnections.splice(0); return ok({ removed: true }); }
  };
  const oauth = createChatGptService({ remote: {
    async fetchStatus() { record("读取授权"); return { ok: true, snapshot: authorized ? { planEnabled: true, localSession: false, ownerKind: "principal", state: "ready", account: { email: "fixture@example.invalid" } } : { planEnabled: true, localSession: false, ownerKind: "principal", state: "disconnected" } }; },
    async startAuthorize() { await perform("请求授权"); return { ok: false, error: "内存授权失败；可重试或手工结算此展示授权" }; },
    async disconnect() { authorized = false; record("断开授权"); return { ok: true, snapshot: { planEnabled: true, localSession: false, ownerKind: "principal", state: "disconnected" } }; },
    async fetchModels() { return { ok: true, snapshot: { models: [] } }; },
    generate() { throw new Error("展示不执行生成"); },
    async receipt() { return { ok: false, error: "无展示任务" }; }
  } });
  let serverSnapshot = { ...LOCAL_ONLY_SNAPSHOT };
  const server = createRemoteServerService({ async request(input) {
    record(`远端 ${input.path}`);
    if (!await perform("服务端请求")) return { ok: false, code: "unavailable", error: "服务端连接失败，请重试" };
    if (input.path.endsWith("/probe")) return { ok: true, status: 200, data: { ok: true, serverUrl: "https://example.invalid", version: "fixture", commit: "fixture", methods: ["password"] } };
    if (input.path.endsWith("/login")) { serverSnapshot = { ...serverSnapshot, phase: "connected", serverUrl: "https://example.invalid", displayName: "内存用户", subject: "memory" }; return { ok: true, status: 200, data: { ok: true, snapshot: serverSnapshot } }; }
    if (input.path.endsWith("/logout")) { serverSnapshot = { ...LOCAL_ONLY_SNAPSHOT }; return { ok: true, status: 200, data: { ok: true } }; }
    return { ok: true, status: 200, data: serverSnapshot };
  } });
  return { sdk, local, oauth, server, settle: () => { hold = false; waiting.splice(0).forEach(resolve => resolve()); record("结算配置请求"); }, authorize: async () => { authorized = true; await oauth.refresh(); }, failNext: () => { fail = true; }, dispose: () => { oauth.dispose(); server.dispose(); } };
}
export function ConfigurationIntegration() {
  const [scenario, select] = useState<Scenario>("ready"); const { record, log } = useRecorder();
  const fixture = useMemo(() => createConfigurationFixture(record, scenario), [scenario]);
  useEffect(() => { fixture.oauth.start(); return () => fixture.dispose(); }, [fixture]);
  return <IntegrationStage title="SDK / OAuth / 本地助手 / 远端配置">
    <ScenarioPicker value={scenario} onChange={select} /><PendingActions settle={fixture.settle} />
    <Button onClick={() => { fixture.failNext(); record("下次请求失败"); }}>下次失败</Button><Button onClick={() => void fixture.authorize()}>结算内存授权</Button>
    <SdkAgentSettingsPanel key={scenario + "sdk"} remote={fixture.sdk} onSaved={id => record(`保存 ${id}`)} />
    <LocalAgentSettingsPanel key={scenario + "local"} remote={fixture.local} />
    <ChatGptAuthorizationRow service={fixture.oauth} />
    <RemoteServerSettingsPanel service={fixture.server} />{log}
  </IntegrationStage>;
}
