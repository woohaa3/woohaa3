import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createWorldAnimationScript,
  decodeSceneAreaData,
  executeWorldAnimationScript,
  sampleWorldAnimation,
  sampleWorldAnimationInArea,
  sceneAreaAnimationOrigin,
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
  value: { sceneArea?: Record<string, unknown> };
};

function areaCommand(commands: CanvasCommand[]): AreaPatch {
  const command = commands.find(candidate => {
    if (candidate.type !== "nodeData.patch" || candidate.nodeId !== "area") return false;
    const value = candidate.value as { sceneArea?: unknown };
    return value.sceneArea !== undefined;
  });
  if (!command) throw new Error("missing area patch");
  return command as unknown as AreaPatch;
}

function worldPosition(sceneArea: unknown): { u: number; v: number } {
  const decoded = decodeSceneAreaData(sceneArea);
  if (!decoded.ok || !decoded.value.animationScript) throw new Error("missing animation");
  const executed = executeWorldAnimationScript(decoded.value.animationScript.script, {
    duration: decoded.value.animationScript.duration,
    loop: decoded.value.animationScript.loop
  });
  if (!executed.ok) throw new Error(executed.message);
  const sample = sampleWorldAnimationInArea(
    executed.ir,
    0,
    sceneAreaAnimationOrigin(decoded.value)
  ).instances.get("solo-a");
  if (!sample?.position) throw new Error("missing sample");
  return { u: sample.position.u, v: sample.position.v };
}

describe("scene-area command mapping animation origin", () => {
  it("moves the origin with a translated area and restores it on undo without rewriting the script", () => {
    const canvas = canvasWithAnimation();
    const plan = movePlan(canvas);
    const forward = buildForwardCommands(canvas, plan);
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;

    const sceneArea = areaCommand(forward.commands).value.sceneArea!;
    expect(sceneArea.animationOrigin).toEqual({ u: 7, v: 8 });
    const rawScript = executeWorldAnimationScript(
      (sceneArea.animationScript as { script: string }).script,
      { duration: 4, loop: false }
    );
    expect(rawScript.ok).toBe(true);
    if (rawScript.ok) {
      // The authored track stays relative; only the origin moved.
      expect(sampleWorldAnimation(rawScript.ir, 0).instances.get("solo-a")?.position)
        .toEqual({ u: 1, v: 1, h: 0 });
    }
    expect(worldPosition(sceneArea)).toEqual({ u: 8, v: 9 });

    const inverse = buildInverseCommands(canvas, plan, forward.source, forward.deleted);
    expect(inverse.ok).toBe(true);
    if (!inverse.ok) return;
    const restored = areaCommand(inverse.commands).value.sceneArea!;
    expect(restored.animationOrigin).toBeUndefined();
    expect(worldPosition(restored)).toEqual({ u: 6, v: 6 });
  });

  it("keeps the stable origin on resize", () => {
    const canvas = canvasWithAnimation();
    const plan = movePlan(canvas);
    const resize: SceneAreaPlan = {
      ...plan,
      intent: "resize",
      commands: [{
        kind: "set-scene-area-bounds",
        areaId,
        expectedScopeVersion: "scope-1",
        bounds: { min: { u: 0, v: 0 }, max: { u: 11, v: 10 } }
      }],
      inverse: [plan.inverse[0]!]
    };
    const forward = buildForwardCommands(canvas, resize);
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    const sceneArea = areaCommand(forward.commands).value.sceneArea!;
    expect(sceneArea.animationOrigin).toEqual({ u: 5, v: 5 });
    expect(worldPosition(sceneArea)).toEqual({ u: 6, v: 6 });
  });

  it("carries camera position tracks with the area origin", () => {
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

    const forward = buildForwardCommands(canvas, movePlan(canvas));
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    const sceneArea = areaCommand(forward.commands).value.sceneArea!;
    expect(sceneArea.animationOrigin).toEqual({ u: 7, v: 8 });
    const decoded = decodeSceneAreaData(sceneArea);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || !decoded.value.animationScript) return;
    const executed = executeWorldAnimationScript(decoded.value.animationScript.script, {
      duration: decoded.value.animationScript.duration,
      loop: decoded.value.animationScript.loop
    });
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(sampleWorldAnimationInArea(executed.ir, 0, sceneAreaAnimationOrigin(decoded.value))
      .cameras.get("camera-1")?.position).toEqual({ u: 9, v: 10, h: 1 });
  });
});
