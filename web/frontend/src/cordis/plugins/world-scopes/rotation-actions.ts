import type { Context } from "@deepseek-ai/cordis";
import {
  createHighEntropyId, decodeSceneAreaData, decodeWorldInstanceData, decodeWorldCamera,
  modelGroundAnchorLocal, storedHumanoidRig, worldModelGroundAnchor,
  rotateGroundQuarterTurns, rotateGroundBoundsQuarterTurn, rotateWorldTransformQuarterTurn,
  rotateWorldQuarterTurn, sceneAreaAnimationOrigin, SCENE_AREA_PLAN_CONTRACT_VERSION,
  createWorldAnimationScript, executeWorldAnimationScript, sampleWorldAnimationInArea,
  serializeWorldAnimationScript, quatMul,
  type CanvasCommand, type CanvasNodeData, type ServerCanvas, type WorldPreparedAuthoritySnapshot, type SampledInstanceMotion
} from "@woohaa3/contracts";
import { MODEL_SCENES_SERVICE, type ModelScenesProvider } from "../service-keys.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { setWorldRotationPreview } from "../../services/world-rotation-preview.js";
import { nodeSelectionStore } from "../../services/selection-store.js";

/** Pure optimistic projection of the authority's fixed member set. No new members are absorbed. */
export function rotatedAreaData(canvas: ServerCanvas, nodeId: string, snapshot: WorldPreparedAuthoritySnapshot, turns: number) {
  const data = new Map<string, CanvasNodeData>();
  const area = decodeSceneAreaData(canvas.nodeData[nodeId]?.sceneArea);
  if (!area.ok) return data;
  let bounds = area.value.bounds, origin = sceneAreaAnimationOrigin(area.value);
  const pivot = { u: (bounds.min.u + bounds.max.u) / 2, v: (bounds.min.v + bounds.max.v) / 2 };
  for (let i = 0; i < turns; i++) bounds = rotateGroundBoundsQuarterTurn(bounds);
  origin = rotateGroundQuarterTurns(origin, pivot, turns);
  data.set(nodeId, { ...canvas.nodeData[nodeId], sceneArea: { ...area.value, bounds,
    animationOrigin: origin, animationQuarterTurns: ((area.value.animationQuarterTurns ?? 0) + turns) % 4 } } as unknown as CanvasNodeData);
  const ids = new Set(snapshot.writable.map(target => JSON.stringify([target.kind, target.kind === "instance" ? target.instanceId : target.cameraId])));
  for (const node of canvas.document.nodes) {
    const current = canvas.nodeData[node.id];
    const instance = decodeWorldInstanceData(current?.sharedWorldInstance);
    if (instance.ok && ids.has(JSON.stringify(["instance", instance.value.instanceId]))) {
      let transform = instance.value.transform;
      for (let i = 0; i < turns; i++) transform = rotateWorldTransformQuarterTurn(transform, pivot);
      data.set(node.id, { ...current, sharedWorldInstance: { ...instance.value, transform } } as unknown as CanvasNodeData);
    }
    const camera = decodeWorldCamera(current?.worldCamera);
    if (camera.ok && ids.has(JSON.stringify(["camera", camera.value.cameraId]))) {
      let rotation = camera.value.rotation;
      for (let i = 0; i < turns; i++) rotation = rotateWorldQuarterTurn(rotation);
      data.set(node.id, { ...current, worldCamera: { ...camera.value,
        position: { ...camera.value.position, ...rotateGroundQuarterTurns(camera.value.position, pivot, turns) }, rotation } } as unknown as CanvasNodeData);
    }
  }
  return data;
}

export function createWorldRotationActions(ctx: Context, canvasId: string | undefined) {
  const queue: string[] = [];
  let running = false, disposed = false;
  let error: string | null = null;
  let snapshot: { pending: number; error: string | null } = { pending: 0, error };
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  const read = () => {
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    return canvas?.id === canvasId ? canvas : null;
  };
  const publish = () => {
    snapshot = { pending: queue.length, error };
    if (!disposed) listeners.forEach(listener => listener());
  };
  const preview = (data: ReadonlyMap<string, CanvasNodeData> | null) => {
    setWorldRotationPreview(data && canvasId ? { canvasId, data } : null);
    ctx.canvasRuntime.controller()?.invalidate("world-rotation");
  };
  const waitRevision = (revision: number) => new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (reason?: string) => {
      stop(); clearTimeout(timer); abort.signal.removeEventListener("abort", cancelled);
      reason ? reject(new Error(reason)) : resolve();
    };
    const cancelled = () => finish("画布已关闭");
    const timer = setTimeout(() => finish("旋转已保存，画布同步尚未完成，请稍后重试"), 10_000);
    const check = () => {
      const canvas = read();
      if (!canvas) finish("画布已切换");
      else if (canvas.revision >= revision) finish();
    };
    stop = woohaa3CanvasStore.subscribe(check);
    abort.signal.addEventListener("abort", cancelled, { once: true });
    if (abort.signal.aborted) cancelled(); else check();
  });
  const replay = async (commands: CanvasCommand[]) => {
    if (disposed || !read() || !ctx.canvasSession.isWritable()) return { ok: false as const, reason: "画布当前不可写" };
    const submitted = ctx.canvasSession.submitCommands(commands, createHighEntropyId("world-rotate-history"));
    if (!submitted.ok) return { ok: false as const, reason: submitted.reason };
    const settled = await submitted.handle.settled;
    return settled.state === "committed" ? { ok: true as const } : { ok: false as const, reason: settled.error ?? "旋转未保存" };
  };
  let prepared: { nodeId: string; snapshot: WorldPreparedAuthoritySnapshot } | null = null;
  const updatePreview = () => {
    const canvas = read();
    if (!canvas || !prepared || queue[0] !== prepared.nodeId) return;
    const count = queue.filter(id => id === prepared!.nodeId).length;
    preview(rotatedAreaData(canvas, prepared.nodeId, prepared.snapshot, count));
  };
  const rotateOne = async (nodeId: string) => {
    const canvas = read();
    if (!canvas || disposed || !ctx.canvasSession.isWritable()) throw new Error("画布当前不可写");
    const area = decodeSceneAreaData(canvas.nodeData[nodeId]?.sceneArea);
    if (area.ok) {
      const ready = await ctx.canvasRemote.prepareSceneArea({ canvasId: canvas.id, areaId: area.value.areaId }, abort.signal);
      if (!ready.ok) throw new Error(ready.message);
      if (disposed || !ctx.canvasSession.isWritable() || !read()) throw new Error("画布当前不可写");
      if (ready.snapshot.occupancy.state !== "idle") throw new Error("片场正在被任务占用，暂时无法旋转");
      prepared = { nodeId, snapshot: ready.snapshot };
      updatePreview();
      const operationId = createHighEntropyId("scene-area-rotate");
      const result = await ctx.canvasRemote.executeSceneArea({ canvasId: canvas.id, request: {
        contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION, canvasId: canvas.id, operationId,
        intent: "rotate", area: ready.snapshot.area, members: ready.snapshot.members
      } }, abort.signal);
      if (!result.ok) throw new Error(result.message);
      if (disposed || !read()) return;
      const history = async (direction: "undo" | "redo") => {
        if (disposed || !ctx.canvasSession.isWritable() || !read()) return { ok: false as const, reason: "画布当前不可写" };
        const outcome = await ctx.canvasRemote.historySceneArea(direction, { canvasId: canvas.id, operationId });
        if (!outcome.ok) return { ok: false as const, reason: outcome.message };
        await waitRevision(outcome.revision);
        return { ok: true as const };
      };
      const recorded = ctx.canvasEdit.recordExternal({ id: `scene-area:${operationId}`, label: "旋转片场 90°",
        undo: () => history("undo"), redo: () => history("redo") });
      if (!recorded.ok) throw new Error(`旋转已保存，但无法登记撤销：${recorded.reason}`);
      await waitRevision(result.revision);
      return;
    }
    const instance = decodeWorldInstanceData(canvas.nodeData[nodeId]?.sharedWorldInstance);
    if (!instance.ok) throw new Error("模型已不可用");
    const provider = ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider | undefined;
    const resource = provider?.getResources().get(nodeId);
    if (!resource) throw new Error("模型正在加载，暂时无法旋转");
    const rig = storedHumanoidRig(canvas.nodeData[nodeId]?.modelRig);
    const local = modelGroundAnchorLocal(resource.ops, rig.ok ? rig.value : null);
    if (!local) throw new Error("模型地面锚点尚未就绪");
    const times = ctx.canvasRuntime.worldAnimationPlayheads();
    const player = ctx.canvasRuntime.worldAnimationState();
    const selected = nodeSelectionStore.getSnapshot().nodeIds;
    const priority = (id: string) => player.playing && player.nodeId === id ? 2 : Number(selected.includes(id));
    const areas = [...canvas.document.nodes].sort((a, b) => priority(a.id) - priority(b.id)).flatMap(node => {
      const decoded = decodeSceneAreaData(canvas.nodeData[node.id]?.sceneArea);
      if (!decoded.ok || !decoded.value.animationScript) return [];
      const script = decoded.value.animationScript;
      const compiled = executeWorldAnimationScript(script.script, script);
      if (!compiled.ok) return [];
      return [{ nodeId: node.id, area: decoded.value, script, ir: compiled.ir }];
    });
    const motion: SampledInstanceMotion = Object.assign({}, ...areas.map(({ nodeId: areaNodeId, area: owner, ir }) =>
      sampleWorldAnimationInArea(ir, times.get(areaNodeId) ?? 0, sceneAreaAnimationOrigin(owner), owner.animationQuarterTurns)
        .instances.get(instance.value.instanceId)));
    const base = instance.value.transform;
    const effective = { ...base, ...motion, rotation: motion.rotation ? quatMul([...base.rotation], [...motion.rotation]) : base.rotation };
    const pivot = worldModelGroundAnchor(local, effective);
    const turned = rotateWorldTransformQuarterTurn(effective, pivot);
    const delta = { u: turned.position.u - effective.position.u, v: turned.position.v - effective.position.v };
    const next = { ...instance.value, transform: { ...base, rotation: rotateWorldQuarterTurn(base.rotation),
      position: { ...base.position, u: base.position.u + delta.u, v: base.position.v + delta.v } } };
    const before = canvas.nodeData[nodeId]!;
    const after = { ...before, sharedWorldInstance: next } as unknown as CanvasNodeData;
    const command = (from: CanvasNodeData, to: CanvasNodeData): CanvasCommand => ({
      type: "nodeData.patch", nodeId, value: { sharedWorldInstance: to.sharedWorldInstance }, expectedNodeData: { [nodeId]: from }
    });
    const forward = [command(before, after)], inverse = [command(after, before)];
    // Position tracks override the base position. Shift their local coordinates
    // by the same anchor compensation in the model's atomic command batch.
    for (const owner of areas) {
      if (Math.abs(delta.u) + Math.abs(delta.v) < 1e-12) break;
      const localDelta = rotateGroundQuarterTurns(delta, { u: 0, v: 0 }, -(owner.area.animationQuarterTurns ?? 0));
      let changed = false;
      const instanceTracks = owner.ir.instanceTracks.map(track => {
        if (track.targetId !== instance.value.instanceId || track.property !== "position") return track;
        changed = true;
        return { ...track, from: [track.from[0]! + localDelta.u, track.from[1]! + localDelta.v, track.from[2]!],
          to: [track.to[0]! + localDelta.u, track.to[1]! + localDelta.v, track.to[2]!] };
      });
      const walkTracks = owner.ir.walkTracks?.map(track => {
        if (track.targetId !== instance.value.instanceId) return track;
        changed = true;
        return { ...track, path: track.path.map(([u, v]) => [u + localDelta.u, v + localDelta.v] as [number, number]) };
      });
      if (!changed) continue;
      const source = canvas.nodeData[owner.nodeId]!;
      const sceneArea = { ...(source.sceneArea as unknown as Record<string, unknown>), animationScript: createWorldAnimationScript({
        script: serializeWorldAnimationScript({ ...owner.ir, instanceTracks, walkTracks }),
        duration: owner.script.duration, loop: owner.script.loop, revision: owner.script.revision + 1
      }) };
      const target = { ...source, sceneArea } as unknown as CanvasNodeData;
      forward.push({ type: "nodeData.patch", nodeId: owner.nodeId, value: { sceneArea: target.sceneArea }, expectedNodeData: { [owner.nodeId]: source } });
      inverse.push({ type: "nodeData.patch", nodeId: owner.nodeId, value: { sceneArea: source.sceneArea }, expectedNodeData: { [owner.nodeId]: target } });
    }
    const operationId = createHighEntropyId("world-model-rotate");
    const submitted = ctx.canvasSession.submitCommands(forward, operationId);
    if (!submitted.ok) throw new Error(submitted.reason);
    const settled = await submitted.handle.settled;
    if (settled.state !== "committed") throw new Error(settled.error ?? "旋转未保存");
    if (disposed || !read()) return;
    const recorded = ctx.canvasEdit.recordExternal({ id: operationId, label: "旋转模型 90°",
      undo: () => replay(inverse), redo: () => replay(forward) });
    if (!recorded.ok) throw new Error(`旋转已保存，但无法登记撤销：${recorded.reason}`);
  };
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length && !disposed) {
        await rotateOne(queue[0]!);
        queue.shift();
        preview(null);
        updatePreview();
        publish();
      }
    } catch (cause) {
      queue.length = 0;
      error = cause instanceof Error ? cause.message : "旋转未保存，请重试";
    } finally {
      running = false; prepared = null; preview(null); publish();
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    rotate(nodeId: string) {
      if (disposed || !ctx.canvasSession.isWritable() || queue.length >= 16) return;
      error = null; queue.push(nodeId); updatePreview(); publish(); void drain();
    },
    dispose() { disposed = true; queue.length = 0; abort.abort(); preview(null); listeners.clear(); }
  };
}

export type WorldRotationActions = ReturnType<typeof createWorldRotationActions>;
