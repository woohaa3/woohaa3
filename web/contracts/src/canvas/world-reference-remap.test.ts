import { describe, expect, it } from "vitest";
import {
  remapWorldCopyReferences,
  type WorldCopySourceNode,
  type WorldReferenceRemapEntry,
  type WorldReferenceRemapResult
} from "./world-reference-remap.js";
import { SHARED_WORLD_NODE_DATA_KEYS, SHARED_WORLD_VERSION, type SceneAreaData } from "./shared-world.js";
import { executeWorldAnimationScript } from "./world-animation-script.js";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function expectOk(result: WorldReferenceRemapResult): readonly WorldReferenceRemapEntry[] {
  if (!result.ok) throw new Error(`expected a remapped batch, got ${result.code}`);
  return result.nodes;
}

function expectFailed(
  result: WorldReferenceRemapResult,
  code: "unsupported-version" | "invalid-data" | "unmapped-identity" | "binding-unavailable"
): Extract<WorldReferenceRemapResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure");
  expect(result.code).toBe(code);
  return result;
}

function transform(): Record<string, unknown> {
  return {
    version: SHARED_WORLD_VERSION,
    position: { u: 1, v: 2, h: 3 },
    rotation: [0, 0, 0, 1],
    scale: 1.5
  };
}

function instance(instanceId: string): Record<string, unknown> {
  return {
    kind: "world-instance",
    version: SHARED_WORLD_VERSION,
    instanceId,
    transform: transform()
  };
}

function camera(cameraId: string, boundInstanceId: string | null): Record<string, unknown> {
  return {
    kind: "world-camera",
    version: SHARED_WORLD_VERSION,
    cameraId,
    settingsVersion: "settings-1",
    position: { u: -2, v: 4, h: 1.7 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 0.1, farMeters: 80 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId
  };
}

function group(groupId: string, memberNodeIds: readonly string[], scopeVersion = "scope-1"): Record<string, unknown> {
  return {
    kind: "workflow-group-2d",
    version: SHARED_WORLD_VERSION,
    groupId,
    scopeVersion,
    memberNodeIds: [...memberNodeIds]
  };
}

function area(areaId: string, scopeVersion = "scope-2"): Record<string, unknown> {
  return {
    kind: "scene-area",
    version: SHARED_WORLD_VERSION,
    areaId,
    scopeVersion,
    bounds: { min: { u: -4, v: -4 }, max: { u: 4, v: 4 } }
  };
}

function node(nodeId: string, nodeData: Record<string, unknown>): WorldCopySourceNode {
  return { nodeId, nodeData };
}

function bySource(nodes: readonly WorldReferenceRemapEntry[], sourceNodeId: string): WorldReferenceRemapEntry {
  const entry = nodes.find(candidate => candidate.sourceNodeId === sourceNodeId);
  if (!entry) throw new Error(`missing entry ${sourceNodeId}`);
  return entry;
}

describe("world copy reference remapping", () => {
  it("preserves the animation script and remaps every target to copied instances without aliasing its source", () => {
    const animationScript = {
      script: [
        'motion.instance.tween("instance-1", { property: "position", startTime: 0, endTime: 5, from: [1, 2, 3], to: [4, 5, 6], easing: "easeOut" });',
        'motion.instance.tween("instance-1", { property: "rotation", startTime: 0, endTime: 5, from: [0, 0, 0], to: [0, 90, 0], easing: "linear" });',
        'motion.instance.tween("instance-2", { property: "scale", startTime: 0, endTime: 5, from: [1], to: [2], easing: "linear" });',
        'motion.part.tween("instance-1", "LeftUpperLeg", { property: "rotation", startTime: 0, endTime: 5, from: [-30,0,0], to: [30,0,0] });',
        'motion.part.cycle("instance-2","RightUpperLeg",{property:"rotation",startTime:0,endTime:5,period:1,keyframes:[{time:0,value:[-20,0,0]},{time:0.5,value:[20,0,0]},{time:1,value:[-20,0,0]}]});'
      ].join("\n"),
      scriptLanguage: "javascript",
      scriptVersion: "woohaa-world-animation-js-v2",
      revision: 1,
      sourceHash: "hash-script",
      duration: 5,
      loop: true
    };
    const input = deepFreeze({
      nodes: [
        node("node-area", { sceneArea: { ...area("area-1"), animationScript } }),
        node("node-model-1", { sharedWorldInstance: instance("instance-1") }),
        node("node-model-2", { sharedWorldInstance: instance("instance-2") })
      ],
      ids: {
        nodeIds: { "node-area": "copy-area", "node-model-1": "copy-model-1", "node-model-2": "copy-model-2" },
        instanceIds: { "instance-1": "copy-instance-1", "instance-2": "copy-instance-2" },
        areaIds: { "area-1": "copy-area-id" }
      }
    });
    const before = JSON.parse(JSON.stringify(input));
    const result = expectOk(remapWorldCopyReferences(input));
    const copied = bySource(result, "node-area").nodeData.sceneArea as SceneAreaData;
    expect(copied.animationScript).toBeDefined();
    const compiled = executeWorldAnimationScript(copied.animationScript!.script, { duration: 5, loop: true });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.ir.instanceTracks.map(track => `${track.targetId}:${track.property}`).sort()).toEqual([
      "copy-instance-1:position",
      "copy-instance-1:rotation",
      "copy-instance-2:scale"
    ]);
    expect(compiled.ir.partTracks?.map(t => [t.targetId, t.partId])).toEqual([["copy-instance-1", "LeftUpperLeg"],["copy-instance-2","RightUpperLeg"]]);
    expect(compiled.ir.partTracks?.[1]?.cycle?.keyframes).toHaveLength(3);
    expect(input).toEqual(before);
  });

  it("rejects an animation script targeting an instance outside the collection even if its id mapping is supplied", () => {
    const failure = expectFailed(remapWorldCopyReferences({
      nodes: [node("node-area", { sceneArea: { ...area("area-1"), animationScript: {
        script: 'motion.instance.tween("external-instance", { property: "position", startTime: 0, endTime: 5, from: [0, 0, 0], to: [1, 0, 0], easing: "linear" });',
        scriptLanguage: "javascript",
        scriptVersion: "woohaa-world-animation-js-v2",
        revision: 1,
        sourceHash: "hash-external",
        duration: 5,
        loop: false
      } } })],
      ids: { nodeIds: { "node-area": "copy-area" }, areaIds: { "area-1": "copy-area-id" }, instanceIds: { "external-instance": "guessed-copy" } }
    }), "binding-unavailable");
    expect(failure.field).toBe("animationScript.instanceTracks");
    expect(failure.reference).toEqual({ relation: "instance", id: "external-instance" });
    expect(failure).not.toHaveProperty("nodes");
  });

  it("rewrites a copied camera to the copied instance and leaves the source collection untouched", () => {
    const input = deepFreeze({
      nodes: [
        node("node-model", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-1"), mediaContent: { kind: "image", mediaId: "m1" } }),
        node("node-camera", { [SHARED_WORLD_NODE_DATA_KEYS.camera]: camera("camera-1", "instance-1") })
      ],
      ids: {
        nodeIds: { "node-model": "copy-model", "node-camera": "copy-camera" },
        instanceIds: { "instance-1": "copy-instance" },
        cameraIds: { "camera-1": "copy-camera" }
      }
    });
    const snapshot = JSON.parse(JSON.stringify(input));

    const nodes = expectOk(remapWorldCopyReferences(input));

    expect(nodes.map(entry => entry.sourceNodeId)).toEqual(["node-model", "node-camera"]);
    expect(nodes.map(entry => entry.nodeId)).toEqual(["copy-model", "copy-camera"]);
    expect(nodes.map(entry => entry.worldKind)).toEqual(["world-instance", "world-camera"]);

    const model = bySource(nodes, "node-model").nodeData;
    expect((model[SHARED_WORLD_NODE_DATA_KEYS.instance] as { instanceId: string }).instanceId).toBe("copy-instance");
    expect(model.mediaContent).toEqual({ kind: "image", mediaId: "m1" });

    const copiedCamera = bySource(nodes, "node-camera").nodeData[SHARED_WORLD_NODE_DATA_KEYS.camera] as {
      cameraId: string;
      boundInstanceId: string | null;
    };
    expect(copiedCamera.cameraId).toBe("copy-camera");
    expect(copiedCamera.boundInstanceId).toBe("copy-instance");

    // The frozen source is neither mutated nor aliased by the result.
    expect(input).toEqual(snapshot);
    const sourceModelData = input.nodes[0]!.nodeData as Record<string, unknown>;
    expect(nodes[0]!.nodeData).not.toBe(sourceModelData);
    expect(bySource(nodes, "node-model").nodeData.mediaContent).not.toBe(sourceModelData.mediaContent);
  });

  it("is deterministic for the same input and returns fresh values on every run", () => {
    const input = deepFreeze({
      nodes: [
        node("node-model", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-1") }),
        node("node-camera", { [SHARED_WORLD_NODE_DATA_KEYS.camera]: camera("camera-1", "instance-1") })
      ],
      ids: {
        nodeIds: { "node-model": "copy-model", "node-camera": "copy-camera" },
        instanceIds: { "instance-1": "copy-instance" },
        cameraIds: { "camera-1": "copy-camera" }
      }
    });
    const first = expectOk(remapWorldCopyReferences(input));
    const second = expectOk(remapWorldCopyReferences(input));
    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.nodeData).not.toBe(first[0]!.nodeData);
  });

  it("keeps an intentionally unbound camera unbound", () => {
    const nodes = expectOk(remapWorldCopyReferences({
      nodes: [node("node-camera", { [SHARED_WORLD_NODE_DATA_KEYS.camera]: camera("camera-1", null) })],
      ids: { nodeIds: { "node-camera": "copy-camera" }, cameraIds: { "camera-1": "copy-camera" } }
    }));
    expect((nodes[0]!.nodeData[SHARED_WORLD_NODE_DATA_KEYS.camera] as { boundInstanceId: unknown }).boundInstanceId).toBeNull();
  });

  it("reports an explicit unavailable state for a binding outside the copied collection", () => {
    const input = deepFreeze({
      nodes: [node("node-camera", { [SHARED_WORLD_NODE_DATA_KEYS.camera]: camera("camera-1", "instance-outside") })],
      ids: {
        nodeIds: { "node-camera": "copy-camera" },
        instanceIds: { "instance-outside": "copy-outside" },
        cameraIds: { "camera-1": "copy-camera" }
      }
    });
    const failure = expectFailed(remapWorldCopyReferences(input), "binding-unavailable");
    expect(failure.sourceNodeId).toBe("node-camera");
    expect(failure.field).toBe("boundInstanceId");
    expect(failure.reference).toEqual({ relation: "instance", id: "instance-outside" });
    // No silent unbinding, no guessed instance and no whole-world fallback is produced.
    expect(failure).not.toHaveProperty("nodes");
  });

  it("does not bind to a different copied instance", () => {
    const failure = expectFailed(remapWorldCopyReferences({
      nodes: [
        node("node-model", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-1") }),
        node("node-camera", { [SHARED_WORLD_NODE_DATA_KEYS.camera]: camera("camera-1", "instance-removed") })
      ],
      ids: {
        nodeIds: { "node-model": "copy-model", "node-camera": "copy-camera" },
        instanceIds: { "instance-1": "copy-instance", "instance-removed": "copy-removed" },
        cameraIds: { "camera-1": "copy-camera" }
      }
    }), "binding-unavailable");
    expect(failure.reference).toEqual({ relation: "instance", id: "instance-removed" });
  });

  it("rewrites 2D group members to the new structural node ids", () => {
    const nodes = expectOk(remapWorldCopyReferences({
      nodes: [
        node("node-group", { [SHARED_WORLD_NODE_DATA_KEYS.group]: group("group-1", ["node-b", "node-a"]) }),
        node("node-a", { prompt: "a" }),
        node("node-b", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-b") })
      ],
      ids: {
        nodeIds: { "node-group": "copy-group-node", "node-a": "copy-a", "node-b": "copy-b" },
        groupIds: { "group-1": "copy-group" },
        instanceIds: { "instance-b": "copy-instance-b" }
      }
    }));
    const copiedGroup = nodes[0]!.nodeData[SHARED_WORLD_NODE_DATA_KEYS.group] as {
      groupId: string;
      scopeVersion: string;
      memberNodeIds: string[];
    };
    expect(copiedGroup.groupId).toBe("copy-group");
    expect(copiedGroup.scopeVersion).toBe("scope-1");
    expect(copiedGroup.memberNodeIds).toEqual(["copy-b", "copy-a"]);
    expect(bySource(nodes, "node-a").nodeData).toEqual({ prompt: "a" });
    expect(bySource(nodes, "node-a").worldKind).toBeNull();
  });

  it("refuses a member reference outside the copied collection instead of leaving a dangling member", () => {
    const failure = expectFailed(remapWorldCopyReferences({
      nodes: [
        node("node-group", { [SHARED_WORLD_NODE_DATA_KEYS.group]: group("group-1", ["node-a", "node-external"]) }),
        node("node-a", { prompt: "a" })
      ],
      ids: {
        nodeIds: { "node-group": "copy-group-node", "node-a": "copy-a" },
        groupIds: { "group-1": "copy-group" }
      }
    }), "binding-unavailable");
    expect(failure.sourceNodeId).toBe("node-group");
    expect(failure.field).toBe("memberNodeIds");
    expect(failure.reference).toEqual({ relation: "node", id: "node-external" });
  });

  it("keeps group and area id namespaces separate even when the source string is equal", () => {
    const nodes = expectOk(remapWorldCopyReferences({
      nodes: [
        node("node-group", { [SHARED_WORLD_NODE_DATA_KEYS.group]: group("shared-id", ["node-group"]) }),
        node("node-area", { [SHARED_WORLD_NODE_DATA_KEYS.area]: area("shared-id") })
      ],
      ids: {
        nodeIds: { "node-group": "copy-group-node", "node-area": "copy-area-node" },
        groupIds: { "shared-id": "copy-group-id" },
        areaIds: { "shared-id": "copy-area-id" }
      }
    }));
    expect((nodes[0]!.nodeData[SHARED_WORLD_NODE_DATA_KEYS.group] as { groupId: string }).groupId).toBe("copy-group-id");
    expect((nodes[1]!.nodeData[SHARED_WORLD_NODE_DATA_KEYS.area] as { areaId: string }).areaId).toBe("copy-area-id");
  });

  it("requires caller-assigned identities for every copied node and world object", () => {
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-model", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-1") })],
      ids: { nodeIds: {}, instanceIds: { "instance-1": "copy-instance" } }
    }), "unmapped-identity");

    const missingInstance = expectFailed(remapWorldCopyReferences({
      nodes: [node("node-model", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-1") })],
      ids: { nodeIds: { "node-model": "copy-model" } }
    }), "unmapped-identity");
    expect(missingInstance.field).toBe("instanceId");
    expect(missingInstance.reference).toEqual({ relation: "instance", id: "instance-1" });

    const reusedNodeId = expectFailed(remapWorldCopyReferences({
      nodes: [node("node-a", { prompt: "a" })],
      ids: { nodeIds: { "node-a": "node-a" } }
    }), "unmapped-identity");
    expect(reusedNodeId.reference).toEqual({ relation: "node", id: "node-a" });
  });

  it("accepts Map and record identity tables with the same result", () => {
    const nodes: WorldCopySourceNode[] = [
      node("node-area", { [SHARED_WORLD_NODE_DATA_KEYS.area]: area("area-1") })
    ];
    const record = expectOk(remapWorldCopyReferences({
      nodes,
      ids: { nodeIds: { "node-area": "copy-node" }, areaIds: { "area-1": "copy-area" } }
    }));
    const mapped = expectOk(remapWorldCopyReferences({
      nodes,
      ids: {
        nodeIds: new Map([["node-area", "copy-node"]]),
        areaIds: new Map([["area-1", "copy-area"]])
      }
    }));
    expect(mapped).toEqual(record);
  });

  it("does not emit transient runtime or occupancy fields from the copy input", () => {
    const source = {
      nodeId: "node-model",
      nodeData: { [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-1") },
      lease: { canvasId: "c", runId: "r", epoch: 3, target: { kind: "instance", instanceId: "instance-1" } },
      locks: [{ id: "lock-1" }],
      epoch: 7,
      completionId: "completion-1",
      gpuHandle: { native: 1 },
      runtime: { matrix: [1, 0, 0, 0] }
    } as unknown as WorldCopySourceNode;
    const nodes = expectOk(remapWorldCopyReferences({
      nodes: [source],
      ids: { nodeIds: { "node-model": "copy-model" }, instanceIds: { "instance-1": "copy-instance" } }
    }));
    expect(Object.keys(nodes[0]!).sort()).toEqual(["nodeData", "nodeId", "sourceNodeId", "worldKind"]);
    expect(Object.keys(nodes[0]!.nodeData[SHARED_WORLD_NODE_DATA_KEYS.instance] as object).sort()).toEqual([
      "instanceId", "kind", "transform", "version"
    ]);
    const serialized = JSON.stringify(nodes);
    for (const transient of ["lease", "locks", "epoch", "completionId", "gpuHandle", "runtime", "matrix"]) {
      expect(serialized).not.toContain(transient);
    }
  });

  it("copies opaque non-world nodeData as fresh JSON and tolerates absent nodeData", () => {
    const input = deepFreeze({
      nodes: [
        node("node-text", { prompt: "hello", nested: { list: [1, 2, { deep: true }] } }),
        { nodeId: "node-empty" }
      ],
      ids: { nodeIds: { "node-text": "copy-text", "node-empty": "copy-empty" } }
    });
    const nodes = expectOk(remapWorldCopyReferences(input));
    expect(nodes[0]!.nodeData).toEqual({ prompt: "hello", nested: { list: [1, 2, { deep: true }] } });
    expect(nodes[1]!.nodeData).toEqual({});
    expect(nodes[0]!.nodeData.nested).not.toBe((input.nodes[0]!.nodeData as Record<string, unknown>).nested);
  });

  it("rejects nodeData that cannot be persisted as JSON", () => {
    for (const bad of [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: () => 1 },
      { value: new Date(0) },
      { value: undefined }
    ]) {
      expectFailed(remapWorldCopyReferences({
        nodes: [node("node-a", bad)],
        ids: { nodeIds: { "node-a": "copy-a" } }
      }), "invalid-data");
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-a", cyclic)],
      ids: { nodeIds: { "node-a": "copy-a" } }
    }), "invalid-data");
  });

  it("rejects duplicate source identities and duplicate new identities", () => {
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-a", {}), node("node-a", {})],
      ids: { nodeIds: { "node-a": "copy-a" } }
    }), "invalid-data");

    expectFailed(remapWorldCopyReferences({
      nodes: [
        node("node-a", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-1") }),
        node("node-b", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-1") })
      ],
      ids: {
        nodeIds: { "node-a": "copy-a", "node-b": "copy-b" },
        instanceIds: { "instance-1": "copy-instance" }
      }
    }), "invalid-data");

    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-a", {}), node("node-b", {})],
      ids: { nodeIds: { "node-a": "copy-a", "node-b": "copy-a" } }
    }), "invalid-data");

    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-a", {})],
      ids: { nodeIds: { "node-a": "" } }
    }), "invalid-data");
  });

  it("follows the OC01 rejection boundary for unknown versions and unknown fields", () => {
    const future = instance("instance-1");
    future.version = "shared-world-v2";
    const futureFailure = expectFailed(remapWorldCopyReferences({
      nodes: [node("node-model", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: future })],
      ids: { nodeIds: { "node-model": "copy-model" }, instanceIds: { "instance-1": "copy-instance" } }
    }), "unsupported-version");
    expect(futureFailure.field).toBe(SHARED_WORLD_NODE_DATA_KEYS.instance);

    const extra = instance("instance-1");
    extra.gpuHandle = {};
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-model", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: extra })],
      ids: { nodeIds: { "node-model": "copy-model" }, instanceIds: { "instance-1": "copy-instance" } }
    }), "invalid-data");

    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-model", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: { ...instance("instance-1"), kind: "scene-area" } })],
      ids: { nodeIds: { "node-model": "copy-model" }, instanceIds: { "instance-1": "copy-instance" } }
    }), "invalid-data");

    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-mixed", {
        [SHARED_WORLD_NODE_DATA_KEYS.instance]: instance("instance-1"),
        [SHARED_WORLD_NODE_DATA_KEYS.area]: area("area-1")
      })],
      ids: {
        nodeIds: { "node-mixed": "copy-mixed" },
        instanceIds: { "instance-1": "copy-instance" },
        areaIds: { "area-1": "copy-area" }
      }
    }), "invalid-data");

    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-model", { [SHARED_WORLD_NODE_DATA_KEYS.instance]: null })],
      ids: { nodeIds: { "node-model": "copy-model" } }
    }), "invalid-data");
  });

  it("validates camera structure without inventing runtime fields", () => {
    for (const projection of [
      { kind: "perspective", verticalFovRadians: 0, nearMeters: 0.1, farMeters: 10 },
      { kind: "perspective", verticalFovRadians: Math.PI, nearMeters: 0.1, farMeters: 10 },
      { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 10, farMeters: 10 },
      { kind: "isometric", verticalSizeMeters: 0, nearMeters: 0.1, farMeters: 10 },
      { kind: "fisheye", nearMeters: 0.1, farMeters: 10 }
    ]) {
      expectFailed(remapWorldCopyReferences({
        nodes: [node("node-camera", { [SHARED_WORLD_NODE_DATA_KEYS.camera]: { ...camera("camera-1", null), projection } })],
        ids: { nodeIds: { "node-camera": "copy-camera" }, cameraIds: { "camera-1": "copy-camera" } }
      }), "invalid-data");
    }
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-camera", {
        [SHARED_WORLD_NODE_DATA_KEYS.camera]: { ...camera("camera-1", null), aspect: { width: 16, height: 0 } }
      })],
      ids: { nodeIds: { "node-camera": "copy-camera" }, cameraIds: { "camera-1": "copy-camera" } }
    }), "invalid-data");
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-camera", {
        [SHARED_WORLD_NODE_DATA_KEYS.camera]: { ...camera("camera-1", null), captureMode: { kind: "video" } }
      })],
      ids: { nodeIds: { "node-camera": "copy-camera" }, cameraIds: { "camera-1": "copy-camera" } }
    }), "invalid-data");
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-camera", {
        [SHARED_WORLD_NODE_DATA_KEYS.camera]: { ...camera("camera-1", null), boundInstanceId: undefined }
      })],
      ids: { nodeIds: { "node-camera": "copy-camera" }, cameraIds: { "camera-1": "copy-camera" } }
    }), "invalid-data");
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-camera", {
        [SHARED_WORLD_NODE_DATA_KEYS.camera]: { ...camera("camera-1", null), lease: {} }
      })],
      ids: { nodeIds: { "node-camera": "copy-camera" }, cameraIds: { "camera-1": "copy-camera" } }
    }), "invalid-data");
  });

  it("rejects malformed batches and malformed identity tables", () => {
    expectFailed(remapWorldCopyReferences(null as unknown as never), "invalid-data");
    expectFailed(remapWorldCopyReferences({} as never), "invalid-data");
    expectFailed(remapWorldCopyReferences({ nodes: [], ids: {} } as never), "invalid-data");
    expectFailed(remapWorldCopyReferences({
      nodes: [{ nodeData: {} } as unknown as WorldCopySourceNode],
      ids: { nodeIds: {} }
    }), "invalid-data");
    expectFailed(remapWorldCopyReferences({
      nodes: [{ nodeId: "node-a", nodeData: [] } as unknown as WorldCopySourceNode],
      ids: { nodeIds: { "node-a": "copy-a" } }
    }), "invalid-data");
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-a", {})],
      ids: { nodeIds: new Map([[1, "copy-a"]]) as unknown as Record<string, string> }
    }), "invalid-data");
    expectFailed(remapWorldCopyReferences({
      nodes: [node("node-a", {})],
      ids: { nodeIds: "nope" as unknown as Record<string, string> }
    }), "invalid-data");
  });

  it("returns an empty successful batch for an empty collection", () => {
    expect(expectOk(remapWorldCopyReferences({ nodes: [], ids: { nodeIds: {} } }))).toEqual([]);
  });
});
