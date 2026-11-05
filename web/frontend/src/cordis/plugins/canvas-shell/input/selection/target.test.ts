import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import type { HitTarget } from "../../hit-test.js";
import { cardPointerTarget, groundAreaCandidates, hasWorldObject, pickedWorldTarget } from "./target.js";

function canvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    document: {
      ...base.document,
      nodes: [
        { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
        { id: "image", type: "image", position: { x: 0, y: 0 }, width: 100, height: 100 },
        { id: "model", type: "model3d", position: { x: 0, y: 0 } }
      ]
    },
    nodeData: {
      area: {
        sceneArea: {
          kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1",
          bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
        }
      },
      model: {
        sharedWorldInstance: {
          kind: "world-instance", version: "shared-world-v1", instanceId: "i1",
          transform: { version: "shared-world-v1", position: { u: 2, v: 3, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
        }
      }
    }
  } as unknown as ServerCanvas;
}

const hit = (kind: "node" | "model-preview", nodeId: string): HitTarget => ({ kind, nodeId } as HitTarget);

describe("canvas pointer target", () => {
  it("classifies cards, model previews and shared world objects", () => {
    expect(cardPointerTarget(canvas(), hit("node", "image"))).toMatchObject({ kind: "card", nodeId: "image" });
    expect(cardPointerTarget(canvas(), hit("model-preview", "image"))).toMatchObject({ kind: "model-preview", nodeId: "image" });
    expect(cardPointerTarget(canvas(), hit("node", "model"))).toMatchObject({ kind: "world-object", via: "card", scopeId: "area" });
    expect(cardPointerTarget(canvas(), { kind: "port", nodeId: "image", side: "input" } as HitTarget)).toBeNull();
  });

  it("accepts only shared world objects from renderer picks", () => {
    expect(pickedWorldTarget(canvas(), "model")).toMatchObject({ kind: "world-object", via: "pick" });
    expect(pickedWorldTarget(canvas(), "image")).toBeNull();
    expect(pickedWorldTarget(canvas(), "missing")).toBeNull();
  });

  it("derives ground candidates and world-object presence from the same canvas", () => {
    expect(groundAreaCandidates(canvas(), { u: 4, v: 4 })).toEqual(["area"]);
    expect(groundAreaCandidates(canvas(), { u: 20, v: 20 })).toEqual([]);
    expect(hasWorldObject(canvas())).toBe(true);
    expect(hasWorldObject(createEmptyWoohaa3ServerCanvas("empty"))).toBe(false);
  });
});
