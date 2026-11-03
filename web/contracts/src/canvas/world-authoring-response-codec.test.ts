import { describe, expect, it } from "vitest";
import {
  SCENE_AREA_PLAN_FIXTURES,
  type SceneAreaPlan
} from "./scene-area-plan-contract.js";
import {
  decodeWorldAuthoringFailure,
  decodeWorldAuthoringResponse,
  type WorldAuthoringResponseRoute
} from "./world-authoring-response-codec.js";

const bounds = { min: { u: 0, v: 0 }, max: { u: 4, v: 4 } };
const area = { areaId: "area", scopeVersion: "area-v1", bounds };
const instanceTransform = {
  version: "shared-world-v1",
  position: { u: 1, v: 2, h: 0 },
  rotation: [0, 0, 0, 1],
  scale: 1
};
const instanceMember = {
  identity: { kind: "instance", instanceId: "i1" },
  version: "i1-v1",
  transform: instanceTransform
};
const camera = {
  kind: "world-camera",
  version: "shared-world-v1",
  cameraId: "cam",
  settingsVersion: "cam-v1",
  position: { u: 0, v: 0, h: 1 },
  rotation: [0, 0, 0, 1],
  projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 },
  captureMode: { kind: "static" },
  aspect: { width: 16, height: 9 },
  boundInstanceId: null
};
const cameraMember = { identity: { kind: "camera", cameraId: "cam" }, version: "cam-v1", camera };
const members = { instances: [instanceMember], cameras: [cameraMember] };
const plan = {
  contractVersion: "scene-area-plan-v1",
  canvasId: "c",
  operationId: "op",
  intent: "move",
  source: { area, members },
  commands: [
    { kind: "set-scene-area-bounds", areaId: "area", expectedScopeVersion: "area-v1", bounds: { min: { u: 1, v: 1 }, max: { u: 5, v: 5 } } },
    { kind: "set-instance-transform", target: { kind: "instance", instanceId: "i1" }, expectedVersion: "i1-v1", transform: { ...instanceTransform, position: { u: 2, v: 3, h: 0 } } },
    { kind: "set-world-camera-pose", target: { kind: "camera", cameraId: "cam" }, expectedVersion: "cam-v1", position: { u: 1, v: 1, h: 1 }, rotation: [0, 0, 0, 1] }
  ],
  inverse: [
    { kind: "restore-scene-area-bounds", areaId: "area", scopeVersion: "area-v1", bounds },
    { kind: "restore-instance", target: { kind: "instance", instanceId: "i1" }, version: "i1-v1", transform: instanceTransform },
    { kind: "restore-world-camera", target: { kind: "camera", cameraId: "cam" }, version: "cam-v1", camera }
  ]
};
const nodeSnapshot = {
  nodeId: "area-node",
  node: { id: "area-node", type: "scene-area", x: 0, y: 0, width: 100, height: 100 },
  nodeData: { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "area", scopeVersion: "area-v1", bounds } }
};
const memberSnapshot = {
  nodeId: "i1-node",
  node: { id: "i1-node", type: "model", x: 0, y: 0, width: 100, height: 100 },
  nodeData: { sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: "i1", transform: instanceTransform } },
  identity: { kind: "instance", instanceId: "i1" },
  edges: [{ id: "edge-1", source: "a", target: "b", sourceHandle: null, targetHandle: null, data: {} }]
};
const receipt = {
  version: "world-authoring-receipt-v1",
  canvasId: "c",
  operationId: "op",
  intent: "move",
  direction: "forward",
  intentHash: "hash",
  previousCommandId: null,
  plan,
  source: { area: nodeSnapshot, members: [memberSnapshot] },
  deletedNodes: [],
  produced: {
    areaScopeVersion: "area-v2",
    targets: [{ kind: "instance", instanceId: "i1", version: "i1-v2" }]
  },
  revision: 2,
  createdAt: "2026-01-01T00:00:00.000Z"
};
const prepare = {
  ok: true,
  snapshot: {
    version: "world-authoring-v1",
    canvasId: "c",
    revision: 1,
    scope: { scope: { kind: "scene-area", areaId: "area" }, scopeVersion: "area-v1" },
    areaNodeId: "area-node",
    area,
    bounds,
    writable: [{ kind: "instance", instanceId: "i1", version: "i1-v1" }],
    readOnly: [],
    members,
    objects: [{
      identity: { kind: "instance", instanceId: "i1" },
      nodeId: "i1-node",
      version: "i1-v1",
      containment: "writable",
      contentVersion: "content-v1",
      transformVersion: "transform-v1"
    }],
    occupancy: {
      version: "world-scope-occupancy-v1",
      scope: { scope: { kind: "scene-area", areaId: "area" }, scopeVersion: "area-v1" },
      state: "occupied",
      locks: [{ target: { kind: "instance", instanceId: "i1" }, runId: "run-1", epoch: 2, state: "active" }]
    }
  }
};
const commit = {
  ok: true, canvasId: "c", operationId: "op", commandId: "cmd",
  revision: 2, duplicate: false, plan, receipt
};
const issue = {
  ok: true,
  context: {
    contextId: "ctx",
    canvasId: "c",
    runId: "run",
    epoch: 1,
    scope: { scope: { kind: "scene-area", areaId: "area" }, scopeVersion: "area-v1" },
    writableTargets: [{
      target: { kind: "instance", instanceId: "i1", version: "i1-v1" },
      lease: { canvasId: "c", runId: "run", epoch: 1, target: { kind: "instance", instanceId: "i1" } }
    }],
    readOnlyReferences: [{ kind: "camera", cameraId: "cam", version: "cam-v1" }]
  },
  run: { canvasId: "c", requestId: "req", runId: "run", executionId: "exec", epoch: 1, state: "active" },
  retry: false
};
const save = {
  ok: true, canvasId: "c", cameraId: "cam", commandId: "cmd",
  revision: 2, duplicate: false, camera, settingsVersion: "cam-v1"
};
const historyEntry = {
  completionKey: "key",
  canvasId: "c",
  cameraId: "cam",
  runId: "run",
  completionId: "done",
  settingsVersion: "cam-v1",
  createdAt: "2026-01-01T00:00:00.000Z",
  snapshot: {
    version: "world-camera-history-v1",
    completion: { canvasId: "c", runId: "run", completionId: "done", cameraId: "cam", settingsVersion: "cam-v1" },
    camera
  }
};
const restore = { ...save, history: historyEntry };
const historyList = { ok: true, canvasId: "c", cameraId: "cam", entries: [historyEntry] };

const validCases: Array<{ route: WorldAuthoringResponseRoute; value: unknown }> = [
  { route: "scene-area-prepare", value: prepare },
  { route: "scene-area-commit", value: commit },
  { route: "scene-area-undo", value: { ...commit, direction: "undo", receipt: { ...receipt, direction: "undo" } } },
  { route: "scene-area-redo", value: { ...commit, direction: "redo", receipt: { ...receipt, direction: "redo" } } },
  { route: "world-tool-context", value: issue },
  { route: "world-tool-context-revoke", value: { ok: true } },
  { route: "world-camera-save", value: save },
  { route: "world-camera-restore", value: restore },
  { route: "world-camera-history", value: historyList }
];

type NegativeCase = {
  name: string;
  route: WorldAuthoringResponseRoute;
  base: unknown;
  mutate: (value: any) => void;
  code?: "invalid-data" | "unsupported-version";
};

const negativeCases: NegativeCase[] = [
  {
    name: "prepare rejects an empty snapshot",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot = {}; }
  },
  {
    name: "prepare rejects an empty nested area",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.area = {}; }
  },
  {
    name: "prepare rejects an empty nested member set",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.members = {}; }
  },
  {
    name: "prepare rejects an instance member carrying a camera identity",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.members.instances[0].identity = { kind: "camera", cameraId: "cam" }; }
  },
  {
    name: "prepare rejects a camera member carrying an instance identity",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.members.cameras[0].identity = { kind: "instance", instanceId: "i1" }; }
  },
  {
    name: "prepare rejects an unknown transform version",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.members.instances[0].transform.version = "shared-world-v0"; },
    code: "unsupported-version"
  },
  {
    name: "prepare rejects a zero scale",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.members.instances[0].transform.scale = 0; }
  },
  {
    name: "prepare rejects a non-unit quaternion",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.members.instances[0].transform.rotation = [0, 0, 0, 2]; }
  },
  {
    name: "prepare rejects a camera whose identity and payload disagree",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.members.cameras[0].identity.cameraId = "other"; }
  },
  {
    name: "prepare rejects an empty occupancy view",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy = {}; }
  },
  {
    name: "prepare rejects an unknown occupancy version",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.version = "world-scope-occupancy-v0"; },
    code: "unsupported-version"
  },
  {
    name: "prepare rejects an occupancy scope that disagrees with the snapshot",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.scope.scopeVersion = "area-v2"; }
  },
  {
    name: "prepare rejects an unknown occupancy state",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.state = "free"; }
  },
  {
    name: "prepare rejects an unknown occupancy that still reports locks",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.state = "unknown"; value.snapshot.occupancy.reason = "store-unavailable"; }
  },
  {
    name: "prepare rejects idle occupancy that still reports locks",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.state = "idle"; }
  },
  {
    name: "prepare rejects occupied occupancy without a lock",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks = []; }
  },
  {
    name: "prepare rejects a negative lock epoch",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks[0].epoch = -1; }
  },
  {
    name: "prepare rejects a fractional lock epoch",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks[0].epoch = 1.5; }
  },
  {
    name: "prepare rejects a string lock epoch",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks[0].epoch = "1"; }
  },
  {
    name: "prepare rejects a lock without a run identity",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks[0].runId = ""; }
  },
  {
    name: "prepare rejects a lock for an object outside the snapshot scope",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks[0].target = { kind: "camera", cameraId: "cam" }; }
  },
  {
    name: "prepare rejects duplicate lock identities",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks.push(structuredClone(value.snapshot.occupancy.locks[0])); }
  },
  {
    name: "prepare rejects a stopped lock state",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks[0].state = "stopped"; }
  },
  {
    name: "prepare rejects a reason on a non-unknown occupancy state",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.reason = "store-unavailable"; }
  },
  {
    name: "prepare rejects explicit unknown occupancy without a reason",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy = { ...value.snapshot.occupancy, state: "unknown", locks: [] }; }
  },
  {
    name: "prepare rejects an unsupported occupancy reason",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy = { ...value.snapshot.occupancy, state: "unknown", locks: [], reason: "maybe" }; }
  },
  {
    name: "prepare rejects extra occupancy lock fields",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks[0].executionId = "leak"; }
  },
  {
    name: "prepare rejects a kind-mismatched lock identity",
    route: "scene-area-prepare",
    base: prepare,
    mutate: value => { value.snapshot.occupancy.locks[0].target = { kind: "camera", instanceId: "i1" }; }
  },
  {
    name: "commit rejects an empty plan",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan = {}; }
  },
  {
    name: "commit rejects an empty plan source",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.source = {}; }
  },
  {
    name: "commit rejects an empty plan source member set",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.source.members = {}; }
  },
  {
    name: "commit rejects an instance plan member carrying a camera identity",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.source.members.instances[0].identity = { kind: "camera", cameraId: "cam" }; }
  },
  {
    name: "commit rejects a camera plan member carrying an instance identity",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.source.members.cameras[0].identity = { kind: "instance", instanceId: "i1" }; }
  },
  {
    name: "commit rejects an unknown plan member transform version",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.source.members.instances[0].transform.version = "shared-world-v0"; },
    code: "unsupported-version"
  },
  {
    name: "commit rejects a zero plan member scale",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.source.members.instances[0].transform.scale = 0; }
  },
  {
    name: "commit rejects a command with only a kind",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.commands = [{ kind: "delete-scene-area" }]; }
  },
  {
    name: "commit rejects a command with an empty bounds object",
    route: "scene-area-commit",
    base: commit,
    mutate: value => {
      value.plan.commands = [{ kind: "set-scene-area-bounds", areaId: "area", expectedScopeVersion: "area-v1", bounds: {} }];
    }
  },
  {
    name: "commit rejects an instance transform command targeting a camera",
    route: "scene-area-commit",
    base: commit,
    mutate: value => {
      value.plan.commands = [{
        kind: "set-instance-transform",
        target: { kind: "camera", cameraId: "cam" },
        expectedVersion: "v",
        transform: instanceTransform
      }];
    }
  },
  {
    name: "commit rejects a camera pose command targeting an instance",
    route: "scene-area-commit",
    base: commit,
    mutate: value => {
      value.plan.commands = [{
        kind: "set-world-camera-pose",
        target: { kind: "instance", instanceId: "i1" },
        expectedVersion: "v",
        position: { u: 0, v: 0, h: 0 },
        rotation: [0, 0, 0, 1]
      }];
    }
  },
  {
    name: "commit rejects a camera pose command with a non-unit rotation",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.commands[2].rotation = [0, 0, 0, 3]; }
  },
  {
    name: "commit rejects an inverse command with only a kind",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.inverse = [{ kind: "restore-instance" }]; }
  },
  {
    name: "commit rejects an inverse camera restore with a mismatched identity",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.inverse[2].target = { kind: "instance", instanceId: "i1" }; }
  },
  {
    name: "commit rejects a camera member whose version disagrees with its payload",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.plan.source.members.cameras[0].version = "cam-v2"; }
  },
  {
    name: "commit rejects an empty receipt",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt = {}; }
  },
  {
    name: "commit rejects an empty receipt source",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.source = {}; }
  },
  {
    name: "commit rejects an empty receipt node snapshot",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.source.area = {}; }
  },
  {
    name: "commit rejects an empty receipt node row",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.source.area.node = {}; }
  },
  {
    name: "commit rejects an empty receipt member snapshot",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.source.members = [{}]; }
  },
  {
    name: "commit rejects an empty receipt member nodeData",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.source.members[0].nodeData = []; }
  },
  {
    name: "commit rejects an empty object receipt nodeData",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.source.members[0].nodeData = {}; }
  },
  {
    name: "commit rejects an empty receipt produced block",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.produced = {}; }
  },
  {
    name: "commit rejects a malformed produced target identity",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.produced.targets = [{ kind: "camera", instanceId: "i1", version: "v" }]; }
  },
  {
    name: "commit rejects a malformed receipt edge snapshot",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.source.members[0].edges = [{ id: "edge-1" }]; }
  },
  {
    name: "commit rejects an unknown receipt version",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.version = "world-authoring-receipt-v0"; },
    code: "unsupported-version"
  },
  {
    name: "commit rejects an unknown receipt direction",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.direction = "sideways"; }
  },
  {
    name: "commit rejects a receipt plan with a camera member carrying an instance identity",
    route: "scene-area-commit",
    base: commit,
    mutate: value => {
      value.receipt.plan.source.members.cameras[0].identity = { kind: "instance", instanceId: "i1" };
    }
  },
  {
    name: "commit rejects a receipt plan with an empty source member set",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.plan.source.members = {}; }
  },
  {
    name: "commit rejects a receipt plan with an unknown transform version",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.plan.source.members.instances[0].transform.version = "shared-world-v0"; },
    code: "unsupported-version"
  },
  {
    name: "commit rejects a receipt plan with a zero scale",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.plan.source.members.instances[0].transform.scale = 0; }
  },
  {
    name: "commit rejects a receipt plan with an inverse command with only a kind",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.plan.inverse = [{ kind: "restore-world-camera" }]; }
  },
  {
    name: "commit rejects a receipt that is not a forward receipt",
    route: "scene-area-commit",
    base: commit,
    mutate: value => { value.receipt.direction = "undo"; }
  },
  {
    name: "undo rejects a receipt that still says forward",
    route: "scene-area-undo",
    base: { ...commit, direction: "undo", receipt: { ...receipt, direction: "undo" } },
    mutate: value => { value.receipt.direction = "forward"; }
  },
  {
    name: "undo rejects a commit-shaped payload without direction",
    route: "scene-area-undo",
    base: { ...commit, direction: "undo", receipt: { ...receipt, direction: "undo" } },
    mutate: value => { delete value.direction; }
  },
  {
    name: "undo rejects a redo direction",
    route: "scene-area-undo",
    base: { ...commit, direction: "undo", receipt: { ...receipt, direction: "undo" } },
    mutate: value => { value.direction = "redo"; }
  },
  {
    name: "redo rejects a malformed nested receipt plan",
    route: "scene-area-redo",
    base: { ...commit, direction: "redo", receipt: { ...receipt, direction: "redo" } },
    mutate: value => { value.receipt.plan.source.members.cameras[0].identity = { kind: "instance", instanceId: "i1" }; }
  },
  {
    name: "context rejects an empty context",
    route: "world-tool-context",
    base: issue,
    mutate: value => { value.context = {}; }
  },
  {
    name: "context rejects an empty run",
    route: "world-tool-context",
    base: issue,
    mutate: value => { value.run = {}; }
  },
  {
    name: "context rejects a non-boolean retry",
    route: "world-tool-context",
    base: issue,
    mutate: value => { value.retry = "false"; }
  },
  {
    name: "context rejects a writable target carrying a camera identity in an instance slot",
    route: "world-tool-context",
    base: issue,
    mutate: value => { value.context.writableTargets[0].target = { kind: "camera", instanceId: "i1", version: "v" }; }
  },
  {
    name: "context rejects a lease target that disagrees with its writable target",
    route: "world-tool-context",
    base: issue,
    mutate: value => { value.context.writableTargets[0].lease.target = { kind: "camera", cameraId: "cam" }; }
  },
  {
    name: "context rejects a lease owned by another run",
    route: "world-tool-context",
    base: issue,
    mutate: value => { value.context.writableTargets[0].lease.runId = "other"; }
  },
  {
    name: "context rejects a context epoch that disagrees with its lease",
    route: "world-tool-context",
    base: issue,
    mutate: value => { value.context.writableTargets[0].lease.epoch = 2; }
  },
  {
    name: "context rejects an unknown run state",
    route: "world-tool-context",
    base: issue,
    mutate: value => { value.run.state = "running"; }
  },
  {
    name: "context rejects a malformed scope",
    route: "world-tool-context",
    base: issue,
    mutate: value => { value.context.scope = {}; }
  },
  {
    name: "revoke rejects a boolean string success",
    route: "world-tool-context-revoke",
    base: { ok: true },
    mutate: value => { value.ok = "true"; }
  },
  {
    name: "camera save rejects an empty camera",
    route: "world-camera-save",
    base: save,
    mutate: value => { value.camera = {}; }
  },
  {
    name: "camera save rejects a camera identity mismatch",
    route: "world-camera-save",
    base: save,
    mutate: value => { value.camera.cameraId = "other"; }
  },
  {
    name: "camera save rejects a settings version mismatch",
    route: "world-camera-save",
    base: save,
    mutate: value => { value.settingsVersion = "cam-v2"; }
  },
  {
    name: "camera save rejects an unknown camera version",
    route: "world-camera-save",
    base: save,
    mutate: value => { value.camera.version = "shared-world-v0"; },
    code: "unsupported-version"
  },
  {
    name: "camera save rejects a non-unit camera rotation",
    route: "world-camera-save",
    base: save,
    mutate: value => { value.camera.rotation = [0, 0, 0, 2]; }
  },
  {
    name: "camera save rejects a non-positive aspect",
    route: "world-camera-save",
    base: save,
    mutate: value => { value.camera.aspect.width = 0; }
  },
  {
    name: "camera save rejects a projection range with near >= far",
    route: "world-camera-save",
    base: save,
    mutate: value => { value.camera.projection.farMeters = 0.1; }
  },
  {
    name: "camera restore rejects an empty history entry",
    route: "world-camera-restore",
    base: restore,
    mutate: value => { value.history = {}; }
  },
  {
    name: "camera restore rejects an empty history snapshot",
    route: "world-camera-restore",
    base: restore,
    mutate: value => { value.history.snapshot = {}; }
  },
  {
    name: "camera restore rejects a history camera that disagrees with the entry",
    route: "world-camera-restore",
    base: restore,
    mutate: value => { value.history.snapshot.camera.cameraId = "other"; }
  },
  {
    name: "camera restore rejects a history entry for another camera",
    route: "world-camera-restore",
    base: restore,
    mutate: value => { value.history.cameraId = "other"; }
  },
  {
    name: "camera history rejects an empty entry",
    route: "world-camera-history",
    base: historyList,
    mutate: value => { value.entries = [{}]; }
  },
  {
    name: "camera history rejects an empty nested snapshot",
    route: "world-camera-history",
    base: historyList,
    mutate: value => { value.entries[0].snapshot = {}; }
  },
  {
    name: "camera history rejects a nested camera with only a kind",
    route: "world-camera-history",
    base: historyList,
    mutate: value => { value.entries[0].snapshot.camera = { kind: "world-camera" }; }
  },
  {
    name: "camera history rejects entries from another canvas",
    route: "world-camera-history",
    base: historyList,
    mutate: value => { value.entries[0].canvasId = "other"; }
  }
];

describe("world authoring response codec", () => {
  it.each(validCases)("accepts the valid $route success envelope", ({ route, value }) => {
    expect(decodeWorldAuthoringResponse(route, value)).toEqual({ ok: true, value });
  });

  it.each(negativeCases)("$name", ({ route, base, mutate, code }) => {
    const value = structuredClone(base);
    mutate(value);
    const decoded = decodeWorldAuthoringResponse(route, value);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.code).toBe(code ?? "invalid-data");
  });

  it("maps a legacy prepare without occupancy to explicit unknown, never idle", () => {
    const legacy = structuredClone(prepare) as any;
    delete legacy.snapshot.occupancy;
    const decoded = decodeWorldAuthoringResponse("scene-area-prepare", legacy);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect((decoded.value as any).snapshot.occupancy).toEqual({
      version: "world-scope-occupancy-v1",
      scope: legacy.snapshot.scope,
      state: "unknown",
      locks: [],
      reason: "not-reported"
    });
  });

  it("accepts explicit unknown and idle occupancy", () => {
    for (const occupancy of [
      { version: "world-scope-occupancy-v1", scope: (prepare.snapshot as any).scope, state: "idle", locks: [] },
      { version: "world-scope-occupancy-v1", scope: (prepare.snapshot as any).scope, state: "unknown", locks: [], reason: "store-unavailable" }
    ]) {
      const value = { ok: true, snapshot: { ...(prepare.snapshot as any), occupancy } };
      const decoded = decodeWorldAuthoringResponse("scene-area-prepare", value);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect((decoded.value as any).snapshot.occupancy).toEqual(occupancy);
    }
  });

  it("accepts the production plan fixture used by the authority planner tests", () => {
    const fixture = SCENE_AREA_PLAN_FIXTURES.find(entry => entry.expected.kind === "plan");
    expect(fixture).toBeDefined();
    if (!fixture || fixture.expected.kind !== "plan") return;
    const productionPlan: SceneAreaPlan = {
      contractVersion: "scene-area-plan-v1",
      canvasId: fixture.request.canvasId,
      operationId: fixture.request.operationId,
      intent: fixture.request.intent,
      source: { area: fixture.request.area, members: fixture.request.members },
      commands: fixture.expected.commands,
      inverse: fixture.expected.inverse
    };
    const productionReceipt = {
      ...receipt,
      canvasId: productionPlan.canvasId,
      operationId: productionPlan.operationId,
      intent: productionPlan.intent,
      plan: productionPlan,
      source: { area: nodeSnapshot, members: [memberSnapshot] }
    };
    const decoded = decodeWorldAuthoringResponse("scene-area-commit", {
      ...commit,
      canvasId: productionPlan.canvasId,
      operationId: productionPlan.operationId,
      plan: productionPlan,
      receipt: productionReceipt
    });
    expect(decoded.ok).toBe(true);
  });

  it("preserves valid domain failures and rejects malformed conflicts", () => {
    expect(decodeWorldAuthoringFailure({ ok: false, code: "version-conflict", message: "stale" })).toEqual({
      ok: true,
      value: { ok: false, code: "version-conflict", message: "stale" }
    });
    const conflict = {
      ok: false,
      code: "lease-conflict",
      message: "occupied",
      conflicts: [{
        target: { kind: "camera", cameraId: "cam" },
        version: "cam-v1",
        runId: "run",
        epoch: 1
      }]
    };
    expect(decodeWorldAuthoringFailure(conflict).ok).toBe(true);
    expect(decodeWorldAuthoringFailure({ ...conflict, conflicts: [{ target: { kind: "camera" } }] }).ok).toBe(false);
    expect(decodeWorldAuthoringFailure({ ok: false, code: "", message: "x" }).ok).toBe(false);
  });
});
