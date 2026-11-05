import { describe, expect, it } from "vitest";
import {
  ASSISTANT_WORLD_TOOL,
  assistantWorldSourceCapability,
  assistantWorldToolsForScope,
  decodeAssistantWorldModelContent,
  decodeAssistantWorldScope,
  decodeAssistantWorldWriteOperation
} from "./assistant-world-authority.js";

const transform = {
  version: "shared-world-v1" as const,
  position: { u: 1, v: 2, h: 0.5 },
  rotation: [0, 0, 0, 1] as const,
  scale: 1.25
};

describe("assistant world scope", () => {
  it("accepts exactly one typed scope identity", () => {
    expect(decodeAssistantWorldScope({ kind: "scene-area", areaId: "area-1" })).toEqual({
      ok: true,
      value: { kind: "scene-area", areaId: "area-1" }
    });
    expect(decodeAssistantWorldScope({ kind: "workflow-group-2d", groupId: "group-1" })).toEqual({
      ok: true,
      value: { kind: "workflow-group-2d", groupId: "group-1" }
    });
    expect(decodeAssistantWorldScope({ kind: "scene-area", areaId: "area-1", groupId: "extra" }).ok).toBe(false);
    expect(decodeAssistantWorldScope({ kind: "workflow-group-2d", groupId: "" }).ok).toBe(false);
  });

  it("never grants world writes to a 2D group", () => {
    expect(assistantWorldToolsForScope({ kind: "workflow-group-2d", groupId: "g" })).toEqual([ASSISTANT_WORLD_TOOL.readContext]);
    expect(assistantWorldToolsForScope({ kind: "scene-area", areaId: "a" })).toContain(ASSISTANT_WORLD_TOOL.setCamera);
    const capability = assistantWorldSourceCapability({ targets: ["workflow-group-2d"] });
    expect(capability.tools).toEqual([ASSISTANT_WORLD_TOOL.readContext]);
    expect(capability.completion).toBe(false);
  });
});

describe("assistant world write decoding", () => {
  it("accepts a typed create operation and rejects unknown fields", () => {
    const operation = decodeAssistantWorldWriteOperation({
      kind: "create-model",
      operationId: "op-1",
      nodeId: "node-1",
      content: { modelScript: "scene.box({});" },
      transform
    });
    expect(operation.ok).toBe(true);
    expect(operation.ok && operation.value.kind).toBe("create-model");
    expect(decodeAssistantWorldWriteOperation({
      kind: "create-model",
      operationId: "op-1",
      nodeId: "node-1",
      content: { modelScript: "scene.box({});" },
      transform,
      selfGrantedScope: "everything"
    }).ok).toBe(false);
  });

  it("rejects non-finite transforms and old-identity camera writes", () => {
    expect(decodeAssistantWorldWriteOperation({
      kind: "set-model-transform",
      operationId: "op-2",
      instanceId: "instance-1",
      expectedVersion: "v1",
      transform: { ...transform, scale: Number.NaN }
    }).ok).toBe(false);
    expect(decodeAssistantWorldWriteOperation({
      kind: "set-world-camera",
      operationId: "op-3",
      cameraId: "camera-1",
      expectedSettingsVersion: "s1",
      settings: {
        position: { u: 0, v: 0, h: 0 },
        rotation: [0, 0, 0, 1],
        projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
        captureMode: { kind: "static" },
        aspect: { width: 16, height: 9 },
        boundInstanceId: null
      }
    }).ok).toBe(true);
    // 创建镜头：身份由宿主派生，设置与 set 共用校验，卡片位置可选。
    expect(decodeAssistantWorldWriteOperation({
      kind: "create-world-camera",
      operationId: "op-4",
      nodeId: "asset-camera-node-1",
      cameraId: "asset-camera-1",
      settings: {
        position: { u: 1, v: 2, h: 3 },
        rotation: [0, 0, 0, 1],
        projection: { kind: "isometric", verticalSizeMeters: 8, nearMeters: 0.1, farMeters: 100 },
        captureMode: { kind: "static" },
        aspect: { width: 16, height: 9 },
        boundInstanceId: "instance-1"
      },
      cardPosition: { x: 10, y: 20 }
    })).toEqual({
      ok: true,
      value: {
        kind: "create-world-camera",
        operationId: "op-4",
        nodeId: "asset-camera-node-1",
        cameraId: "asset-camera-1",
        settings: {
          position: { u: 1, v: 2, h: 3 },
          rotation: [0, 0, 0, 1],
          projection: { kind: "isometric", verticalSizeMeters: 8, nearMeters: 0.1, farMeters: 100 },
          captureMode: { kind: "static" },
          aspect: { width: 16, height: 9 },
          boundInstanceId: "instance-1"
        },
        cardPosition: { x: 10, y: 20 }
      }
    });
    expect(decodeAssistantWorldWriteOperation({
      kind: "create-world-camera",
      operationId: "op-5",
      nodeId: "asset-camera-node-2",
      cameraId: "asset-camera-2",
      settings: {
        position: { u: 0, v: 0, h: 0 },
        rotation: [0, 0, 0, 1],
        projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
        captureMode: { kind: "static" },
        aspect: { width: 16, height: 9 },
        boundInstanceId: null
      },
      unexpected: true
    }).ok).toBe(false);
  });

  it("requires non-empty model script but keeps card layout optional", () => {
    expect(decodeAssistantWorldModelContent({ modelScript: " ", cardPosition: { x: 0, y: 0 } }).ok).toBe(false);
    expect(decodeAssistantWorldModelContent({ modelScript: "scene.box({});" })).toEqual({
      ok: true,
      value: { modelScript: "scene.box({});" }
    });
  });
});

it("decodes a camera scope strictly and grants only camera adjustments", () => {
  const scope = { kind: "world-camera" as const, cameraId: "camera-a" };
  expect(decodeAssistantWorldScope(scope)).toEqual({ ok: true, value: scope });
  expect(decodeAssistantWorldScope({ ...scope, areaId: "area" }).ok).toBe(false);
  expect(decodeAssistantWorldScope({ ...scope, cameraId: "" }).ok).toBe(false);
  expect(assistantWorldToolsForScope(scope)).toEqual(["get_world_context", "set_world_camera", "complete_world_camera"]);
  expect(assistantWorldSourceCapability({ targets: ["world-camera"] })).toMatchObject({ targets: ["world-camera"], tools: ["get_world_context", "set_world_camera", "complete_world_camera"], completion: true });
});

it("grants rig reads and scene samples only to a director area", () => {
  for (const name of ["get_world_model_rig", "sample_scene_animation"]) {
    expect(assistantWorldToolsForScope({kind:"scene-area",areaId:"a"})).toContain(name);
    expect(assistantWorldToolsForScope({kind:"world-camera",cameraId:"c"})).not.toContain(name);
    expect(assistantWorldToolsForScope({kind:"workflow-group-2d",groupId:"g"})).not.toContain(name);
  }
});
