import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { planCanvasEdit } from "./edit-plan.js";
import type { CanvasCommand } from "./commands.js";
import { SHARED_WORLD_VERSION as version } from "./shared-world.js";

function apply(canvas: ServerCanvas, commands: CanvasCommand[]) {
  const result = applyCanvasCommands(canvas, commands);
  if (!result.ok) throw new Error(result.rejection.message);
  return result.canvas;
}

function fixture() {
  return apply(createEmptyWoohaa3ServerCanvas("world"), Array.from({ length: 8 }, (_, i): CanvasCommand => ({
    type: "node.add", node: { id: `model-${i}`, type: "model3d" },
    nodeData: {
      modelScript: `// ${"large model source ".repeat(4000)}\nscene.box({ id: 'box' });`,
      modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2",
      modelContentVersion: { revision: 1, sourceHash: `source-${i}`, contentHash: `content-${i}` },
      modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      sharedWorldInstance: { kind: "world-instance", version, instanceId: `instance-${i}`,
        transform: { version, position: { u: i, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } }
    }
  })));
}

describe("world edit payload stability", () => {
  it("creating an area excludes unchanged models and supports undo/redo without changing their content", () => {
    const before = fixture();
    const plan = planCanvasEdit(before, [{ type: "node.add", node: { id: "area", type: "scene-area" },
      nodeData: { sceneArea: { kind: "scene-area", version, areaId: "area-id", scopeVersion: "scope-1",
        bounds: { min: { u: -1, v: -1 }, max: { u: 10, v: 10 } } } } }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.forward.operations.map(op => op.kind)).toEqual(["node-add"]);
    expect(JSON.stringify(plan.forward).length).toBeLessThan(1000);
    const payload = JSON.stringify(plan);
    const added = apply(before, [{ type: "edit.apply", ...plan.forward }]);
    const undone = apply(added, [{ type: "edit.apply", ...plan.inverse }]);
    const redone = apply(undone, [{ type: "edit.apply", ...plan.forward }]);
    expect(undone.nodeData).toEqual(before.nodeData);
    expect(redone.nodeData).toEqual(added.nodeData);
    expect(JSON.stringify(plan)).toBe(payload);
  });

  it("ignores reordered equivalent transform keys but records a real pose change without mutating the command", () => {
    const before = fixture();
    const instance = before.nodeData["model-0"]!.sharedWorldInstance! as Record<string, any>;
    const reordered: any = { ...instance, transform: { scale: 1, rotation: [0, 0, 0, 1],
      position: { h: 0, v: 0, u: 0 }, version } };
    expect(planCanvasEdit(before, [{ type: "nodeData.patch", nodeId: "model-0", value: { sharedWorldInstance: reordered } }]).ok).toBe(false);
    const commands: CanvasCommand[] = [{ type: "nodeData.patch", nodeId: "model-0",
      value: { sharedWorldInstance: { ...reordered, transform: { ...(reordered.transform as Record<string, any>), position: { u: 20, v: 0, h: 0 } } } } } as any];
    const original = JSON.stringify(commands);
    const plan = planCanvasEdit(before, commands);
    expect(plan.ok).toBe(true);
    expect(JSON.stringify(commands)).toBe(original);
    if (!plan.ok) return;
    expect(plan.forward.operations).toHaveLength(1);
    const payload = JSON.stringify(plan.forward);
    const moved = apply(before, [{ type: "edit.apply", ...plan.forward }]);
    expect((moved.nodeData["model-0"]!.sharedWorldInstance as any).transform.position.u).toBe(20);
    expect(moved.nodeData["model-0"]!.modelScript).toBe(before.nodeData["model-0"]!.modelScript);
    expect(JSON.stringify(plan.forward)).toBe(payload);
    const restored = apply(moved, [{ type: "edit.apply", ...plan.inverse }]);
    expect((restored.nodeData["model-0"]!.sharedWorldInstance as any).transform.position).toEqual({ u: 0, v: 0, h: 0 });
    expect(restored.nodeData["model-0"]!.modelScript).toBe(before.nodeData["model-0"]!.modelScript);
    const rejected: CanvasCommand[] = [...commands, { type: "nodeData.patch", nodeId: "missing", value: { title: "fail" } }];
    const rejectedPayload = JSON.stringify(rejected);
    expect(applyCanvasCommands(before, rejected).ok).toBe(false);
    expect(JSON.stringify(rejected)).toBe(rejectedPayload);
  });
});
