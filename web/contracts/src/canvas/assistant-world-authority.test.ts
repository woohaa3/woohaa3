import { describe, expect, it } from "vitest";
import {
  ASSISTANT_WORLD_CAMERA_TOOLS,
  ASSISTANT_WORLD_TOOL,
  appendWorldModelChunk,
  assistantWorldSourceCapability,
  assistantWorldToolsForScope,
  decodeAssistantWorldModelContent,
  decodeAssistantWorldScope,
  decodeAssistantWorldWriteOperation,
  planWorldModelScriptPatch
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
    expect(decodeAssistantWorldScope({ kind: "scene-area", areaId: "area-1", groupId: "extra" }).ok).toBe(false);
    expect(decodeAssistantWorldScope({ kind: "workflow-group-2d", groupId: "g" }).ok).toBe(false);
  });

  it("grants the scene-area and camera tool surfaces", () => {
    expect(assistantWorldToolsForScope({ kind: "scene-area", areaId: "a" })).toContain(ASSISTANT_WORLD_TOOL.setCamera);
    expect(assistantWorldToolsForScope({ kind: "world-camera", cameraId: "c" })).toEqual([...ASSISTANT_WORLD_CAMERA_TOOLS]);
    const capability = assistantWorldSourceCapability({ targets: ["world-camera"] });
    expect(capability.tools).toEqual([...ASSISTANT_WORLD_CAMERA_TOOLS]);
    expect(capability.completion).toBe(true);
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

  it("allows an empty skeleton script but keeps card layout optional", () => {
    // 空脚本 = 骨架：身份与版本照常派生，内容在追加前不参与渲染。
    expect(decodeAssistantWorldModelContent({ modelScript: "", cardPosition: { x: 0, y: 0 } })).toEqual({
      ok: true,
      value: { modelScript: "", cardPosition: { x: 0, y: 0 } }
    });
    expect(decodeAssistantWorldModelContent({ modelScript: "scene.box({});" })).toEqual({
      ok: true,
      value: { modelScript: "scene.box({});" }
    });
    expect(decodeAssistantWorldModelContent({ modelScript: undefined }).ok).toBe(false);
  });
});

describe("chunked script authoring helpers", () => {
  const script = "scene.box({ id: 'roof', color: 'red' });\nscene.box({ id: 'wall', color: 'gray' });";

  it("appends chunks by plain tail concatenation", () => {
    expect(appendWorldModelChunk("", "a")).toBe("a");
    expect(appendWorldModelChunk(script, "scene.sphere({});")).toBe(`${script}scene.sphere({});`);
  });

  it("plans an exact-text patch that occurs once", () => {
    expect(planWorldModelScriptPatch(script, "'red'", "'blue'")).toEqual({
      ok: true,
      script: script.replace("'red'", "'blue'"),
      replaced: 1
    });
  });

  it("reports patch-not-found with a closest excerpt and the script length", () => {
    const planned = planWorldModelScriptPatch(script, "color: 'green'", "'x'");
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.code).toBe("patch-not-found");
    expect(planned.diagnostic.occurrences).toBe(0);
    expect(planned.diagnostic.scriptLength).toBe(script.length);
    expect(planned.diagnostic.closest?.line).toBe(1);
    expect(planned.diagnostic.closest?.excerpt).toContain("scene.box");
  });

  it("reports patch-ambiguous with every occurrence line", () => {
    const planned = planWorldModelScriptPatch(script, "color", "'x'");
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.code).toBe("patch-ambiguous");
    expect(planned.diagnostic.occurrences).toBe(2);
    expect(planned.diagnostic.matches?.map(match => match.line)).toEqual([1, 2]);
  });

  it("reports patch-noop without a replacement", () => {
    expect(planWorldModelScriptPatch(script, "'red'", "'red'")).toEqual({
      ok: false,
      code: "patch-noop",
      diagnostic: { occurrences: 1, scriptLength: script.length }
    });
  });
});

describe("chunked write operation decoding", () => {
  it("accepts append and patch operations", () => {
    expect(decodeAssistantWorldWriteOperation({
      kind: "append-model-script",
      operationId: "op-append",
      instanceId: "instance-1",
      expectedVersion: "v1",
      chunk: "scene.box({});"
    })).toEqual({
      ok: true,
      value: { kind: "append-model-script", operationId: "op-append", instanceId: "instance-1", expectedVersion: "v1", chunk: "scene.box({});" }
    });
    expect(decodeAssistantWorldWriteOperation({
      kind: "patch-model-script",
      operationId: "op-patch",
      instanceId: "instance-1",
      expectedVersion: "v1",
      oldString: "a",
      newString: "b"
    }).ok).toBe(true);
  });

  it("rejects empty chunks, empty oldString and unknown fields", () => {
    const base = { operationId: "op", instanceId: "instance-1", expectedVersion: "v1" };
    expect(decodeAssistantWorldWriteOperation({ kind: "append-model-script", ...base, chunk: "" }).ok).toBe(false);
    expect(decodeAssistantWorldWriteOperation({ kind: "append-model-script", ...base, chunk: "x", extra: 1 }).ok).toBe(false);
    expect(decodeAssistantWorldWriteOperation({ kind: "patch-model-script", ...base, oldString: "", newString: "b" }).ok).toBe(false);
  });

  it("keeps the new tools in the scene-area surface only", () => {
    // 写入口只在导演区；2D 组与镜头范围都拿不到。
    for (const name of [ASSISTANT_WORLD_TOOL.appendModelScript, ASSISTANT_WORLD_TOOL.patchModelScript]) {
      expect(assistantWorldToolsForScope({ kind: "scene-area", areaId: "a" }), name).toContain(name);
      expect(assistantWorldToolsForScope({ kind: "world-camera", cameraId: "c" }), name).not.toContain(name);
    }
    // 读取入口随导演区读写面提供，镜头范围没有脚本编辑能力。
    expect(assistantWorldToolsForScope({ kind: "scene-area", areaId: "a" })).toContain(ASSISTANT_WORLD_TOOL.readModelScript);
    expect(assistantWorldToolsForScope({ kind: "world-camera", cameraId: "c" })).not.toContain(ASSISTANT_WORLD_TOOL.readModelScript);
    expect(assistantWorldSourceCapability({ targets: ["scene-area"] }).tools).toEqual(expect.arrayContaining([
      ASSISTANT_WORLD_TOOL.readModelScript,
      ASSISTANT_WORLD_TOOL.appendModelScript,
      ASSISTANT_WORLD_TOOL.patchModelScript
    ]));
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
  }
});
