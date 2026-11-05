import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createWorldAnimationScript,
  executeWorldAnimationScript,
  sampleWorldAnimation,
  type CanvasCommand,
  type SceneAreaPlan,
  type ServerCanvas
} from "@woohaa3/contracts";
import { buildForwardCommands, buildInverseCommands } from "./scene-area-command-mapping.js";

const now = "2026-01-01T00:00:00Z";
const areaId = "area-main";

function instanceNodeData(instanceId: string, u: number, v: number) {
  return {
    sharedWorldInstance: {
      kind: "world-instance",
      version: "shared-world-v1",
      instanceId,
      transform: {
        version: "shared-world-v1",
        position: { u, v, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    },
    modelScript: "scene.box({ id: 'body', size: [2, 2, 2] });",
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" }
  };
}

function canvasWithAnimation(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-mapping", now);
  const animationScript = createWorldAnimationScript({
    script: 'motion.instance.tween("solo-a", { property: "position", startTime: 0, endTime: 4, from: [1, 1, 0], to: [2, 2, 0], easing: "linear" });',
    duration: 4,
    loop: false
  });
  canvas.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "solo", type: "model3d", position: { x: 0, y: 0 } }
  );
  canvas.nodeData.area = {
    sceneArea: {
      kind: "scene-area",
      version: "shared-world-v1",
      areaId,
      scopeVersion: "scope-1",
      bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } },
      animationScript
    }
  };
  canvas.nodeData.solo = instanceNodeData("solo-a", 1, 1);
  return canvas;
}

function movePlan(canvas: ServerCanvas): SceneAreaPlan {
  const bounds = { min: { u: 2, v: 3 }, max: { u: 12, v: 13 } };
  return {
    contractVersion: "scene-area-plan-v1",
    canvasId: canvas.id,
    operationId: "move-1",
    intent: "move",
    source: {
      area: {
        areaId,
        scopeVersion: "scope-1",
        bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
      },
      members: {
        instances: [{
          identity: { kind: "instance", instanceId: "solo-a" },
          version: "instance-v1",
          transform: {
            version: "shared-world-v1",
            position: { u: 1, v: 1, h: 0 },
            rotation: [0, 0, 0, 1],
            scale: 1
          }
        }],
        cameras: []
      }
    },
    commands: [
      {
        kind: "set-scene-area-bounds",
        areaId,
        expectedScopeVersion: "scope-1",
        bounds
      },
      {
        kind: "set-instance-transform",
        target: { kind: "instance", instanceId: "solo-a" },
        expectedVersion: "instance-v1",
        transform: {
          version: "shared-world-v1",
          position: { u: 3, v: 4, h: 0 },
          rotation: [0, 0, 0, 1],
          scale: 1
        }
      }
    ],
    inverse: [
      {
        kind: "restore-scene-area-bounds",
        areaId,
        scopeVersion: "scope-1",
        bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
      },
      {
        kind: "restore-instance",
        target: { kind: "instance", instanceId: "solo-a" },
        version: "instance-v1",
        transform: {
          version: "shared-world-v1",
          position: { u: 1, v: 1, h: 0 },
          rotation: [0, 0, 0, 1],
          scale: 1
        }
      }
    ]
  };
}

type AreaPatch = {
  type: "nodeData.patch";
  nodeId: string;
  value: { sceneArea?: { animationScript?: { script: string } } };
};

function areaCommand(commands: CanvasCommand[]): AreaPatch {
  const command = commands.find(candidate => {
    if (candidate.type !== "nodeData.patch" || candidate.nodeId !== "area") return false;
    const value = candidate.value as { sceneArea?: { animationScript?: unknown } };
    return value.sceneArea?.animationScript !== undefined;
  });
  if (!command) throw new Error("missing animation area patch");
  return command as unknown as AreaPatch;
}

function sampledPosition(script: string): { u: number; v: number } {
  const executed = executeWorldAnimationScript(script, { duration: 4, loop: false });
  if (!executed.ok) throw new Error(executed.message);
  const sample = sampleWorldAnimation(executed.ir, 0).instances.get("solo-a");
  if (!sample?.position) throw new Error("missing animation sample");
  return { u: sample.position.u, v: sample.position.v };
}

describe("scene-area command mapping animation shifts", () => {
  it("translates the moved area's own animation position tracks and restores them on undo", () => {
    const canvas = canvasWithAnimation();
    const plan = movePlan(canvas);
    const forward = buildForwardCommands(canvas, plan);
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;

    const shifted = areaCommand(forward.commands).value.sceneArea?.animationScript?.script;
    expect(shifted).toBeDefined();
    expect(sampledPosition(shifted!)).toEqual({ u: 3, v: 4 });

    const inverse = buildInverseCommands(canvas, plan, forward.source, forward.deleted);
    expect(inverse.ok).toBe(true);
    if (!inverse.ok) return;
    const restored = areaCommand(inverse.commands).value.sceneArea?.animationScript?.script;
    expect(restored).toBeDefined();
    expect(sampledPosition(restored!)).toEqual({ u: 1, v: 1 });
  });

  it("leaves the animation script untouched for a resize", () => {
    const canvas = canvasWithAnimation();
    const plan = movePlan(canvas);
    const resize: SceneAreaPlan = {
      ...plan,
      intent: "resize",
      commands: [plan.commands[0]!],
      inverse: [plan.inverse[0]!]
    };
    const forward = buildForwardCommands(canvas, resize);
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    const script = areaCommand(forward.commands).value.sceneArea?.animationScript?.script;
    expect(script).toBeDefined();
    expect(sampledPosition(script!)).toEqual({ u: 1, v: 1 });
  });
});

it("translates camera position tracks for a moved camera member", () => {
  const canvas = canvasWithAnimation();
  const camera = {
    kind: "world-camera",
    version: "shared-world-v1",
    cameraId: "camera-1",
    settingsVersion: "camera-v1",
    position: { u: 2, v: 2, h: 1 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: null
  };
  canvas.document.nodes.push({ id: "camera", type: "world-camera", position: { x: 0, y: 0 } });
  canvas.nodeData.camera = { worldCamera: camera };
  const area = canvas.nodeData.area!.sceneArea as { animationScript?: unknown };
  area.animationScript = createWorldAnimationScript({
    script: 'motion.camera.tween({ cameraId: "camera-1", property: "position", startTime: 0, endTime: 4, from: [2, 2, 1], to: [3, 3, 1], easing: "linear" });',
    duration: 4,
    loop: false
  });

  const plan = movePlan(canvas);
  plan.commands = [
    plan.commands[0]!,
    {
      kind: "set-world-camera-pose",
      target: { kind: "camera", cameraId: "camera-1" },
      expectedVersion: "camera-v1",
      position: { u: 4, v: 5, h: 1 },
      rotation: [0, 0, 0, 1]
    }
  ];
  plan.inverse = [plan.inverse[0]!];
  plan.source.members.cameras = [{
    identity: { kind: "camera", cameraId: "camera-1" },
    version: "camera-v1",
    camera: camera as never
  }];

  const forward = buildForwardCommands(canvas, plan);
  expect(forward.ok).toBe(true);
  if (!forward.ok) return;
  const script = areaCommand(forward.commands).value.sceneArea?.animationScript?.script;
  expect(script).toBeDefined();
  const executed = executeWorldAnimationScript(script!, { duration: 4, loop: false });
  if (!executed.ok) throw new Error(executed.message);
  expect(sampleWorldAnimation(executed.ir, 0).cameras.get("camera-1")?.position).toEqual({ u: 4, v: 5, h: 1 });
});

it("moves animation tracks whose target is not in the writable member set with the owning area", () => {
  const canvas = canvasWithAnimation();
  const camera = {
    kind: "world-camera",
    version: "shared-world-v1",
    cameraId: "camera-1",
    settingsVersion: "camera-v1",
    position: { u: 40, v: 40, h: 1 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: null
  };
  canvas.document.nodes.push({ id: "camera", type: "world-camera", position: { x: 0, y: 0 } });
  canvas.nodeData.camera = { worldCamera: camera };
  const area = canvas.nodeData.area!.sceneArea as { animationScript?: unknown };
  area.animationScript = createWorldAnimationScript({
    script: 'motion.camera.tween({ cameraId: "camera-1", property: "position", startTime: 0, endTime: 4, from: [2, 2, 1], to: [3, 3, 1], easing: "linear" });',
    duration: 4,
    loop: false
  });

  const forward = buildForwardCommands(canvas, movePlan(canvas));
  expect(forward.ok).toBe(true);
  if (!forward.ok) return;
  const script = areaCommand(forward.commands).value.sceneArea?.animationScript?.script;
  expect(script).toBeDefined();
  const executed = executeWorldAnimationScript(script!, { duration: 4, loop: false });
  if (!executed.ok) throw new Error(executed.message);
  expect(sampleWorldAnimation(executed.ir, 0).cameras.get("camera-1")?.position).toEqual({ u: 4, v: 5, h: 1 });
});
