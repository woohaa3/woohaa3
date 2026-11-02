/**
 * Scene-area plan → canvas command mapping (T06).
 *
 * OC04 owns the pure plan. This module only translates its semantic commands into
 * ordinary canvas commands, attaches whole-nodeData preconditions so the reducer
 * rejects the whole batch when a source object changed, and records exactly what
 * must be restored for undo. It never recomputes membership.
 */
import {
  decodeWorldCamera,
  decodeWorldInstanceData,
  type CanvasCommand,
  type CanvasNodeData,
  type SceneAreaPlan,
  type SceneAreaPlanCommand,
  type SceneAreaPlanInverseCommand,
  type ServerCanvas,
  type Woohaa3CanvasSerializedNode,
  type WorldAuthoringNodeSnapshot,
  type WorldAuthoringSourceSnapshot,
  type WorldCameraData,
  type WorldObjectVersion,
} from "@woohaa3/contracts";
import {
  instanceContentVersion,
  instanceVersion,
  nextCameraSettingsVersion,
  nextSceneAreaScopeVersion,
  stableAuthorityVersion
} from "./authority.js";

type JsonRecord = Record<string, unknown>;

type NodeRef = {
  nodeId: string;
  node: Woohaa3CanvasSerializedNode;
  data: JsonRecord;
};

export type SceneAreaCommandResult =
  | {
      ok: true;
      commands: CanvasCommand[];
      source: WorldAuthoringSourceSnapshot;
      deleted: WorldAuthoringNodeSnapshot[];
      produced: { areaScopeVersion: string | null; targets: WorldObjectVersion[] };
    }
  | { ok: false; code: string; message: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nodeData(canvas: ServerCanvas, nodeId: string): JsonRecord | null {
  const raw = canvas.nodeData[nodeId];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as JsonRecord) : null;
}

/** The runtime payload is already validated by the canonical projection. */
function asNodeData(value: JsonRecord): CanvasNodeData {
  return value as unknown as CanvasNodeData;
}

function nodeRef(canvas: ServerCanvas, nodeId: string): NodeRef | null {
  const node = canvas.document.nodes.find(entry => entry.id === nodeId);
  const data = nodeData(canvas, nodeId);
  return node && data ? { nodeId, node, data } : null;
}

function findArea(canvas: ServerCanvas, areaId: string): NodeRef | null {
  for (const node of canvas.document.nodes) {
    if (node.type !== "scene-area") continue;
    const data = nodeData(canvas, node.id);
    const sceneArea = data?.sceneArea as JsonRecord | undefined;
    if (data && sceneArea && sceneArea.areaId === areaId) return { nodeId: node.id, node, data };
  }
  return null;
}

function findInstance(canvas: ServerCanvas, instanceId: string): NodeRef | null {
  for (const node of canvas.document.nodes) {
    const data = nodeData(canvas, node.id);
    const decoded = decodeWorldInstanceData(data?.sharedWorldInstance);
    if (data && decoded.ok && decoded.value.instanceId === instanceId) return { nodeId: node.id, node, data };
  }
  return null;
}

function findCamera(canvas: ServerCanvas, cameraId: string): NodeRef | null {
  for (const node of canvas.document.nodes) {
    const data = nodeData(canvas, node.id);
    const decoded = decodeWorldCamera(data?.worldCamera);
    if (data && decoded.ok && decoded.value.cameraId === cameraId) return { nodeId: node.id, node, data };
  }
  return null;
}

/** Whole-nodeData precondition, deep-cloned so later mutation cannot weaken it. */
function patch(node: NodeRef, value: CanvasNodeData): CanvasCommand {
  return {
    type: "nodeData.patch",
    nodeId: node.nodeId,
    value,
    expectedNodeData: { [node.nodeId]: clone(asNodeData(node.data)) }
  };
}

/** A no-op patch whose only purpose is the version precondition before removal. */
function guard(node: NodeRef): CanvasCommand {
  return patch(node, asNodeData(clone(node.data)));
}

function remove(node: NodeRef): CanvasCommand {
  return { type: "node.remove", nodeIds: [node.nodeId] };
}

function snapshotOf(node: NodeRef): WorldAuthoringNodeSnapshot {
  return { nodeId: node.nodeId, node: clone(node.node), nodeData: clone(node.data) };
}

function nodeAdd(snapshot: WorldAuthoringNodeSnapshot, created: string[]): CanvasCommand[] {
  if (created.includes(snapshot.nodeId)) return [];
  created.push(snapshot.nodeId);
  const source = snapshot.node as Partial<Woohaa3CanvasSerializedNode>;
  return [{
    type: "node.add",
    node: {
      id: snapshot.nodeId,
      type: typeof source.type === "string" ? source.type : "model3d",
      position: { x: source.position?.x ?? 0, y: source.position?.y ?? 0 },
      ...(typeof source.width === "number" ? { width: source.width } : {}),
      ...(typeof source.height === "number" ? { height: source.height } : {}),
      ...(typeof source.zIndex === "number" ? { zIndex: source.zIndex } : {}),
      ...(typeof source.parentId === "string" ? { parentId: source.parentId } : {})
    },
    nodeData: clone(snapshot.nodeData) as unknown as CanvasNodeData
  }];
}

function sourceFor(canvas: ServerCanvas, plan: SceneAreaPlan): SceneAreaCommandResult {
  const area = findArea(canvas, plan.source.area.areaId);
  if (!area) return { ok: false, code: "outside-scope", message: "场景区不存在" };
  const members: WorldAuthoringSourceSnapshot["members"] = [];
  for (const member of plan.source.members.instances) {
    const ref = findInstance(canvas, member.identity.instanceId);
    if (!ref) return { ok: false, code: "not-found", message: "实例不存在" };
    members.push({ ...snapshotOf(ref), identity: member.identity });
  }
  for (const member of plan.source.members.cameras) {
    const ref = findCamera(canvas, member.identity.cameraId);
    if (!ref) return { ok: false, code: "not-found", message: "镜头不存在" };
    members.push({ ...snapshotOf(ref), identity: member.identity });
  }
  return {
    ok: true,
    commands: [],
    source: { area: snapshotOf(area), members },
    deleted: [],
    produced: { areaScopeVersion: plan.source.area.scopeVersion, targets: [] }
  };
}

/** Plan forward commands; `frozenSource` reuses a receipt's source snapshots. */
export function buildForwardCommands(
  canvas: ServerCanvas,
  plan: SceneAreaPlan,
  options: { frozenSource?: WorldAuthoringSourceSnapshot; frozenDeleted?: WorldAuthoringNodeSnapshot[] } = {}
): SceneAreaCommandResult {
  const area = findArea(canvas, plan.source.area.areaId);
  if (!area) return { ok: false, code: "outside-scope", message: "场景区不存在" };
  const base = options.frozenSource
    ? { ok: true as const, source: options.frozenSource }
    : sourceFor(canvas, plan);
  if (!base.ok) return base;

  const commands: CanvasCommand[] = [];
  // Recompute from the current source state so a redo does not duplicate entries.
  const deleted: WorldAuthoringNodeSnapshot[] = [];
  const produced = new Map<string, WorldObjectVersion>();
  let areaScopeVersion: string | null = plan.source.area.scopeVersion;

  for (const command of plan.commands) {
    switch (command.kind) {
      case "set-scene-area-bounds": {
        const ref = findArea(canvas, command.areaId);
        if (!ref) return { ok: false, code: "not-found", message: "场景区不存在" };
        const scopeVersion = nextSceneAreaScopeVersion(command.areaId, command.bounds);
        const current = ref.data.sceneArea as JsonRecord;
        commands.push(patch(ref, asNodeData({
          ...ref.data,
          sceneArea: { ...current, bounds: clone(command.bounds), scopeVersion }
        })));
        areaScopeVersion = scopeVersion;
        break;
      }
      case "set-instance-transform": {
        const ref = findInstance(canvas, command.target.instanceId);
        if (!ref) return { ok: false, code: "not-found", message: "实例不存在" };
        const current = ref.data.sharedWorldInstance as JsonRecord;
        commands.push(patch(ref, asNodeData({
          ...ref.data,
          sharedWorldInstance: { ...current, transform: clone(command.transform) }
        })));
        const version = instanceVersion(
          command.target.instanceId,
          instanceContentVersion(ref.data),
          stableAuthorityVersion("world-pose", command.transform)
        );
        produced.set(JSON.stringify(["instance", command.target.instanceId]), {
          kind: "instance",
          instanceId: command.target.instanceId,
          version
        });
        break;
      }
      case "set-world-camera-pose": {
        const ref = findCamera(canvas, command.target.cameraId);
        if (!ref) return { ok: false, code: "not-found", message: "镜头不存在" };
        const current = ref.data.worldCamera as JsonRecord;
        const next: WorldCameraData = {
          ...(current as unknown as WorldCameraData),
          position: clone(command.position),
          rotation: [command.rotation[0], command.rotation[1], command.rotation[2], command.rotation[3]]
        };
        const settingsVersion = nextCameraSettingsVersion(next);
        commands.push(patch(ref, asNodeData({
          ...ref.data,
          worldCamera: { ...next, settingsVersion }
        })));
        produced.set(JSON.stringify(["camera", command.target.cameraId]), {
          kind: "camera",
          cameraId: command.target.cameraId,
          version: settingsVersion
        });
        break;
      }
      case "delete-instance": {
        const ref = findInstance(canvas, command.target.instanceId);
        if (!ref) return { ok: false, code: "not-found", message: "实例不存在" };
        commands.push(guard(ref), remove(ref));
        deleted.push(snapshotOf(ref));
        produced.set(JSON.stringify(["instance", command.target.instanceId]), {
          kind: "instance",
          instanceId: command.target.instanceId,
          version: "absent"
        });
        break;
      }
      case "delete-world-camera": {
        const ref = findCamera(canvas, command.target.cameraId);
        if (!ref) return { ok: false, code: "not-found", message: "镜头不存在" };
        commands.push(guard(ref), remove(ref));
        deleted.push(snapshotOf(ref));
        produced.set(JSON.stringify(["camera", command.target.cameraId]), {
          kind: "camera",
          cameraId: command.target.cameraId,
          version: "absent"
        });
        break;
      }
      case "delete-scene-area": {
        const ref = findArea(canvas, command.areaId);
        if (!ref) return { ok: false, code: "not-found", message: "场景区不存在" };
        commands.push(guard(ref), remove(ref));
        deleted.push(snapshotOf(ref));
        areaScopeVersion = null;
        break;
      }
    }
  }

  // Deleting a 2D group member must not leave a dangling member reference.
  // One aggregate patch per group keeps the whole batch atomic and preserves the
  // group's organizational scope version semantics.
  const deletedIds = new Set(deleted.map(snapshot => snapshot.nodeId));
  const groups: WorldAuthoringNodeSnapshot[] = [];
  for (const node of canvas.document.nodes) {
    if (node.type !== "workflow-group-2d") continue;
    const ref = nodeRef(canvas, node.id);
    if (!ref) continue;
    const group = ref.data.workflowGroup2d as JsonRecord | undefined;
    const memberNodeIds = group?.memberNodeIds;
    if (!Array.isArray(memberNodeIds)) continue;
    const remaining = memberNodeIds.filter((id): id is string => typeof id === "string" && !deletedIds.has(id));
    if (remaining.length === memberNodeIds.length) continue;
    groups.push(snapshotOf(ref));
    const scopeVersion = stableAuthorityVersion("workflow-group-scope", {
      groupId: group?.groupId ?? node.id,
      memberNodeIds: remaining
    });
    commands.push(patch(ref, asNodeData({
      ...ref.data,
      workflowGroup2d: { ...group, memberNodeIds: remaining, scopeVersion }
    })));
  }
  if (!options.frozenSource) base.source.groups = groups;

  for (const member of plan.source.members.instances) {
    const key = JSON.stringify(["instance", member.identity.instanceId]);
    if (!produced.has(key)) produced.set(key, { ...member.identity, version: member.version });
  }
  for (const member of plan.source.members.cameras) {
    const key = JSON.stringify(["camera", member.identity.cameraId]);
    if (!produced.has(key)) produced.set(key, { ...member.identity, version: member.version });
  }

  return {
    ok: true,
    commands,
    source: base.source,
    deleted,
    produced: { areaScopeVersion, targets: [...produced.values()] }
  };
}

/** Undo commands restore the exact frozen source snapshot (receipt-bound). */
export function buildInverseCommands(
  canvas: ServerCanvas,
  plan: SceneAreaPlan,
  source: WorldAuthoringSourceSnapshot,
  deleted: WorldAuthoringNodeSnapshot[]
): SceneAreaCommandResult {
  const commands: CanvasCommand[] = [];
  const created: string[] = [];
  let areaScopeVersion: string | null = null;
  const deletedById = new Map(deleted.map(snapshot => [snapshot.nodeId, snapshot]));
  const produced = new Map<string, WorldObjectVersion>();

  for (const command of plan.inverse) {
    switch (command.kind) {
      case "restore-scene-area-bounds": {
        const ref = findArea(canvas, command.areaId);
        if (!ref) return { ok: false, code: "not-found", message: "场景区不存在" };
        const current = ref.data.sceneArea as JsonRecord;
        commands.push(patch(ref, asNodeData({
          ...ref.data,
          sceneArea: { ...current, bounds: clone(command.bounds), scopeVersion: command.scopeVersion }
        })));
        areaScopeVersion = command.scopeVersion;
        break;
      }
      case "restore-scene-area": {
        const snapshot = deletedById.get(source.area.nodeId);
        if (snapshot) {
          commands.push(...nodeAdd(snapshot, created));
        } else {
          const ref = nodeRef(canvas, source.area.nodeId);
          if (!ref) return { ok: false, code: "not-found", message: "场景区不存在" };
          commands.push(patch(ref, clone(source.area.nodeData) as unknown as CanvasNodeData));
        }
        areaScopeVersion = command.scopeVersion;
        break;
      }
      case "restore-instance": {
        const sourceMember = source.members.find(member =>
          member.identity.kind === "instance" && member.identity.instanceId === command.target.instanceId);
        if (!sourceMember) return { ok: false, code: "invalid-data", message: "撤销缺少实例快照" };
        const snapshot = deletedById.get(sourceMember.nodeId);
        if (snapshot) {
          commands.push(...nodeAdd(snapshot, created));
        } else {
          const ref = findInstance(canvas, command.target.instanceId);
          if (!ref) return { ok: false, code: "not-found", message: "实例不存在" };
          commands.push(patch(ref, clone(sourceMember.nodeData) as unknown as CanvasNodeData));
        }
        produced.set(JSON.stringify(["instance", command.target.instanceId]), {
          kind: "instance",
          instanceId: command.target.instanceId,
          version: command.version
        });
        break;
      }
      case "restore-world-camera": {
        const sourceMember = source.members.find(member =>
          member.identity.kind === "camera" && member.identity.cameraId === command.target.cameraId);
        if (!sourceMember) return { ok: false, code: "invalid-data", message: "撤销缺少镜头快照" };
        const snapshot = deletedById.get(sourceMember.nodeId);
        if (snapshot) {
          commands.push(...nodeAdd(snapshot, created));
        } else {
          const ref = findCamera(canvas, command.target.cameraId);
          if (!ref) return { ok: false, code: "not-found", message: "镜头不存在" };
          commands.push(patch(ref, clone(sourceMember.nodeData) as unknown as CanvasNodeData));
        }
        produced.set(JSON.stringify(["camera", command.target.cameraId]), {
          kind: "camera",
          cameraId: command.target.cameraId,
          version: command.version
        });
        break;
      }
    }
  }

  for (const group of source.groups ?? []) {
    const ref = nodeRef(canvas, group.nodeId);
    if (!ref) return { ok: false, code: "not-found", message: "2D 组不存在" };
    commands.push(patch(ref, clone(group.nodeData) as unknown as CanvasNodeData));
  }

  return {
    ok: true,
    commands,
    source,
    deleted: clone(deleted),
    produced: { areaScopeVersion, targets: [...produced.values()] }
  };
}

export type { SceneAreaPlanCommand, SceneAreaPlanInverseCommand };
