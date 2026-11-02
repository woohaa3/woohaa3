import type { Context, Plugin } from "@deepseek-ai/cordis";
import { decodeSceneAreaData, decodeWorkflowGroupData, type WorldAuthoringPrepareOutcome, type WorldObjectIdentity } from "@woohaa3/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { definePlugin } from "../../plugin.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";

export const WORLD_SCOPES_PLUGIN_ID = "world-scopes";

function objectLabel(identity: WorldObjectIdentity): string {
  return identity.kind === "instance" ? `模型 ${identity.instanceId}` : `镜头 ${identity.cameraId}`;
}

export function ScopeContext({ ctx, canvasId }: { ctx: Context; canvasId: string | undefined }) {
  const canvas = useSyncExternalStore(woohaa3CanvasStore.subscribe, () => workingCanvasOf(woohaa3CanvasStore.getState()), () => null);
  const selection = useSyncExternalStore(nodeSelectionStore.subscribe, nodeSelectionStore.getSnapshot, nodeSelectionStore.getSnapshot);
  const nodeId = selection.nodeIds.length === 1 ? selection.primaryNodeId : null;
  const data = nodeId ? canvas?.nodeData[nodeId] : undefined;
  const area = decodeSceneAreaData(data?.sceneArea);
  const group = decodeWorkflowGroupData(data?.workflowGroup2d);
  const areaId = area.ok ? area.value.areaId : null;
  const version = area.ok ? area.value.scopeVersion : null;
  const [result, setResult] = useState<{ key: string; canvas: typeof canvas; outcome: WorldAuthoringPrepareOutcome } | null>(null);
  const key = `${canvasId}:${nodeId}:${areaId}:${version}`;
  useEffect(() => {
    if (!areaId || !canvasId) return;
    const abort = new AbortController();
    let active = true;
    setResult(null);
    ctx.canvasRemote.prepareSceneArea({ canvasId, areaId }, abort.signal).then(outcome => {
      if (!active) return;
      if (outcome.ok && (outcome.snapshot.canvasId !== canvasId || outcome.snapshot.areaNodeId !== nodeId
        || outcome.snapshot.area.areaId !== areaId || outcome.snapshot.area.scopeVersion !== version)) {
        setResult({ key, canvas, outcome: { ok: false, code: "version-conflict", message: "场景上下文已过期" } });
      } else setResult({ key, canvas, outcome });
    }).catch(() => {
      if (active) setResult({ key, canvas, outcome: { ok: false, code: "not-ready", message: "无法读取场景上下文" } });
    });
    return () => { active = false; abort.abort(); };
  }, [ctx, canvasId, areaId, key, canvas, nodeId, version]);
  if (!area.ok && !group.ok) return null;
  const outcome = result?.key === key && result.canvas === canvas ? result.outcome : null;
  return <div style={{ position: "absolute", top: 72, right: 16, padding: 12, background: "var(--color-bg-elevated, #fff)", color: "var(--color-text, #222)", border: "1px solid var(--color-border, #ccc)", borderRadius: 6, maxWidth: 300 }}>
    {group.ok ? <><strong>2D 组</strong><div>成员 {group.value.memberNodeIds.length}</div>
      <ul>{group.value.memberNodeIds.map(id => <li key={id}>{id}</li>)}</ul></> : <>
      <strong>场景区</strong>
      {!outcome ? <div>正在读取上下文</div> : outcome.ok ? <>
        {([ ["writable", "可写"], ["read-only", "部分参考"], ["unknown", "未就绪"] ] as const).map(([kind, label]) => {
          const objects = outcome.snapshot.objects.filter(item => item.containment === kind);
          return <div key={kind}>{label} {objects.length}<ul>{objects.map(item => <li key={objectLabel(item.identity)}>{objectLabel(item.identity)}</li>)}</ul></div>;
        })}
        <div>占用状态未查询</div>
      </> : <><div>{outcome.message}</div>{outcome.conflicts?.map(conflict => <div key={`${objectLabel(conflict.target)}:${conflict.runId}:${conflict.epoch}`}>{objectLabel(conflict.target)}: {conflict.runId} / {conflict.epoch}</div>)}</>}
    </>}
  </div>;
}

export function worldScopesExtension(canvasId: string | undefined): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    const remove = ctx.slots.register("canvas.overlay", {
      id: WORLD_SCOPES_PLUGIN_ID, owner: WORLD_SCOPES_PLUGIN_ID, priority: 25,
      render: () => <ScopeContext ctx={ctx} canvasId={canvasId} />
    });
    ctx.effect(() => remove, "world-scopes-overlay");
  }, { name: WORLD_SCOPES_PLUGIN_ID, inject: ["slots", "canvasRemote"] });
}
