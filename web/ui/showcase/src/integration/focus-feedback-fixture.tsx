import { useEffect, useMemo, useState } from "react";
type Context = FrontendRuntime["ctx"];
import { TASK_EXECUTION_STATES, type SettingsSnapshot } from "@woohaa3/contracts";
import { RuntimeProvider } from "../../../../frontend/src/cordis/react.js";
import type { FrontendRuntime } from "../../../../frontend/src/cordis/kernel.js";
import { SlotRegistry } from "../../../../frontend/src/cordis/slots.js";
import { CanvasNavigationStore } from "../../../../frontend/src/cordis/navigation/store.js";
import { FocusHeader } from "../../../../frontend/src/cordis/focus/header.js";
import { ModelInfoPanel } from "../../../../frontend/src/cordis/plugins/model-editor/model-info-panel.js";
import { MediaContentStatus } from "../../../../frontend/src/cordis/plugins/canvas-runtime/media-content-status.js";
import { SafeModeBanner } from "../../../../frontend/src/cordis/services/safe-mode-banner.js";
import { HostConnectivityOverlay } from "../../../../frontend/src/cordis/services/host-connectivity-overlay.js";
import { createHostConnectivityService } from "../../../../frontend/src/cordis/services/host-connectivity.js";
import { RenderErrorBoundary } from "../../../../frontend/src/cordis/app-error-boundary.js";
import { ErrorInspector } from "../../../../frontend/src/cordis/plugins/task-execution/execution-panel/error-inspector.js";
import { TaskStateBadge } from "../../../../frontend/src/pages/task-history/history-detail.js";
import { Button } from "@woohaa3/ui/primitives";
import { IntegrationStage, ScenarioPicker, useRecorder, type Scenario } from "./memory.js";
const subscribe = () => () => undefined;
export function FocusIntegration() {
  const [scenario, select] = useState<Scenario>("ready"); const { record, log } = useRecorder(); const [recovered, recover] = useState(false);
  const runtime = useMemo(() => {
    const navigation = new CanvasNavigationStore({ prepareExit: async () => { record("请求退出聚焦"); return scenario === "error" ? { ok: false, reason: "展示退出保护：请先恢复目标" } : { ok: true }; } });
    let focused = false;
    navigation.setFocusAdapter({ apply: target => { focused = target !== null; return { ok: true }; }, isFocused: () => focused });
    navigation.enterNodeFocus({ nodeId: "memory-model", kind: "model" });
    const canvas = { nodeData: { "memory-model": scenario === "error" ? { modelScriptStatus: "failed", modelScriptError: "内容目标已失效" } : {} } };
    const selection = { primaryNodeId: scenario === "empty" ? null : "memory-model" };
    const media = scenario === "ready" || recovered ? { status: "ready" } : scenario === "loading" ? { status: "pending" } : { status: "failed", diagnostic: "媒体来源已失效" };
    const ctx = {
      slots: new SlotRegistry(), canvasNavigation: navigation,
      canvasState: { subscribe, getWorkingCanvas: () => canvas, getCanvas: () => canvas },
      canvasRuntime: { subscribeViewport: subscribe, viewportVersion: () => 0, nodeScreenRect: () => ({ left: 16, top: 100, width: 300, height: 100 }), modelSceneOverride: () => scenario === "ready" || recovered ? { ops: [] } : null },
      selection: { subscribe, getSnapshot: () => selection },
      mediaContent: { subscribe, state: () => media, retry: () => { record("重试当前媒体"); recover(true); } },
      get: () => ({ subscribe, getResources: () => new Map(), isLoading: () => scenario === "loading" })
    } as unknown as Context;
    return { ctx } as FrontendRuntime;
  }, [record, scenario, recovered]);
  return <IntegrationStage title="聚焦标题 / 模型信息 / 媒体状态">
    <ScenarioPicker value={scenario} onChange={v => { recover(false); select(v); }} /><Button onClick={() => { recover(true); select("ready"); record("恢复目标"); }}>恢复目标</Button>
    <RuntimeProvider runtime={runtime}><div style={{ minHeight: 360, position: "relative" }}><FocusHeader fallbackTitle={"长名称模型".repeat(12)} help="仅展示；未装配 GPU 画布" actions={<Button onClick={() => record("聚焦动作")}>动作</Button>} /><ModelInfoPanel ctx={runtime.ctx} nodeId="memory-model" /><MediaContentStatus /></div></RuntimeProvider>{log}
  </IntegrationStage>;
}
function RecoverableChild({ failed }: { failed: boolean }) { if (failed) throw new Error("展示面板异常"); return <p>面板已恢复，业务状态保持在原 owner。</p>; }
export function FeedbackIntegration() {
  const { record, log } = useRecorder(); const [failed, fail] = useState(false); const [safe, setSafe] = useState(true); const [restartFailed, setRestartFailed] = useState(true);
  const [connectivity] = useState(() => createHostConnectivityService({ probe: async () => ({ reachable: true, releaseId: "memory" }), pinnedReleaseId: () => "memory", reopenCanvas: () => { record("重新打开画布"); }, initialBackoffMs: 100 }));
  useEffect(() => () => connectivity.dispose(), [connectivity]);
  const settingsRemote = useMemo(() => ({ fetchSnapshot: async () => ({ ok: true as const, snapshot: { settings: [], plugins: [], files: { config: "/fixture", secrets: "/fixture" }, safeMode: safe ? { reason: "boot-failures", since: "2026-10-28T08:00:00Z", suspendedCount: 2, suspended: ["a", "b"], lastFailure: "内存扩展启动失败" } : null } as SettingsSnapshot }), write: async () => ({ ok: false as const, code: "fixture", error: "禁止真实设置写入" }) }), [safe]);
  return <IntegrationStage title="连接 / 安全模式 / 局部错误 / 业务状态">
    <Button onClick={() => { connectivity.expectRestart(); record("重连"); }}>模拟断线与恢复</Button><Button onClick={() => connectivity.offerRelease({ releaseId: "memory-next", href: "/fixture" })}>内存扩展更新</Button>
    <SafeModeBanner connectivity={connectivity} settingsRemote={settingsRemote} restartRemote={{ restart: async () => { record("退出安全模式"); if (restartFailed) { setRestartFailed(false); return { ok: false, code: "unavailable", error: "重启失败，请重试" }; } setSafe(false); return { ok: true }; } }} />
    <HostConnectivityOverlay connectivity={connectivity} />
    <Button onClick={() => fail(true)}>触发局部异常</Button>
    <RenderErrorBoundary resetKey={failed} fallback={({ error, retry }) => <div><p>{error}</p><Button onClick={() => { fail(false); retry(); record("重试面板"); }}>重试面板</Button></div>}><RecoverableChild failed={failed} /></RenderErrorBoundary>
    <ErrorInspector error={"业务错误详情".repeat(30)} /><div>{TASK_EXECUTION_STATES.map(state => <TaskStateBadge key={state} state={state} />)}</div>{log}
  </IntegrationStage>;
}
