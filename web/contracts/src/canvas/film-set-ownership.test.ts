/**
 * 片场 owner 的命令/编辑边界（change: 2026-10-28-generic-extension-content-ownership，任务 3.3/3.4）。
 *
 * 覆盖：
 * - 旧持久化命令只在 owner `legacyTypes` 窗口解码；
 * - 未知 owner / 伪造 kind 在副作用前拒绝；
 * - owner 编辑 forward/inverse 与过期前置条件；
 * - canonical 命令联合类型不再包含业务字面量。
 */
import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
import { createFilmSetSnapshot, createModelSnapshot } from "./animation-snapshot.js";
import { canonicalFilmSetFields } from "./film-set-clip-view.js";
import { decodeFilmSetNodeData, type FilmSetNodeData } from "./canvas-node-model.js";
import { filmSetItemEditHash } from "./film-set-item-edit.js";
import { readFilmSetGroupMarker } from "./film-set-group.js";
import { CANVAS_COMMAND_TYPES } from "./commands.js";
import { isEditApplyCommand } from "./edit-command.js";

const NOW = "2026-10-29T00:00:00.000Z";

/** 旧 composite 片场：一个对象 A，默认片段绑定 A。 */
function legacyCanvas(): ServerCanvas {
  const base = createFilmSetSnapshot({
    title: "跑酷",
    model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: "",
    timeline: { duration: 5, loop: false }
  });
  const model = createModelSnapshot({ modelScript: `scene.box({id:"a"});`, modelScriptVersion: "woohaa-model-js-v2" });
  const animation: FilmSetNodeData = {
    ...base,
    filmSetContent: {
      schemaVersion: 4 as const,
      items: [{ id: "A", kind: "model" as const, name: "A", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, model }]
    },
    filmSetAnimations: {
      schemaVersion: 3 as const,
      defaultClipId: "default",
      clips: [{
        id: "default",
        name: "default",
        kind: "dynamic" as const,
        timeline: { duration: 5, loop: false },
        initialCamera: base.sceneCamera,
        cameraMotion: { motionScript: "", motionScriptLanguage: "javascript", motionScriptVersion: "woohaa-motion-js-v1", revision: 1, sourceHash: "camera", basedOnModelVersion: { revision: 1, contentHash: "camera" } },
        bindings: [{ itemId: "A", playback: { startTime: 0, duration: 2, timeScale: 1, loop: false } }]
      }]
    }
  };
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push({ id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 } });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  return canvas;
}

function itemOf(canvas: ServerCanvas) {
  const decoded = decodeFilmSetNodeData(canvas.nodeData.film);
  if (!decoded.ok) throw new Error(decoded.reason);
  const item = decoded.value.filmSetContent.items.find((entry) => entry.id === "A");
  if (!item) throw new Error("missing item A");
  return item;
}

describe("片场 owner 命令窗口", () => {
  it("旧 group 命令经 owner legacyTypes 解码并应用", () => {
    const group = migrateFilmSetFixture(legacyCanvas(), "film");
    const bindingId = readFilmSetGroupMarker(group.nodeData.film)!.sceneBindings[0]!.bindingId;
    const applied = applyCanvasCommands(group, [{
      type: "filmSetGroup.bindingPatch",
      groupId: "film",
      bindingId,
      patch: { visibility: false }
    } as never]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(readFilmSetGroupMarker(applied.canvas.nodeData.film)!.sceneBindings[0]!.visibility).toBe(false);
  });

  it("未知 owner 与伪造业务 kind 在副作用前拒绝", () => {
    const canvas = legacyCanvas();
    const snapshot = structuredClone(canvas);
    const unknown = applyCanvasCommands(canvas, [{
      type: "extension.command",
      extensionId: "unknown-owner",
      nodeId: "film",
      kind: "clip.patch",
      payload: {}
    }]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.rejection.code).toBe("content-owner-unavailable");

    const forged = applyCanvasCommands(canvas, [{
      type: "extension.command",
      extensionId: "film-set",
      nodeId: "film",
      kind: "filmSet.clipPatch",
      payload: { clipId: "default", expectedHash: "x", op: { kind: "not-a-real-op" } }
    }]);
    expect(forged.ok).toBe(false);
    expect(canvas).toEqual(snapshot);
  });
});

describe("片场 owner 受保护编辑", () => {
  it("forward/inverse 只写目标对象，过期前置条件整次拒绝", () => {
    const canvas = legacyCanvas();
    const original = itemOf(canvas);
    const moved = { ...original.localTransform, offset: { x: 3, y: 1, z: 0 }, yaw: 0.5 };
    const forward = applyCanvasCommands(canvas, [{
      type: "extension.edit",
      extensionId: "film-set",
      direction: "forward",
      edit: { operations: [{ kind: "film-set-item-transform", nodeId: "film", itemId: "A", localTransform: moved, expectedLocalTransform: original.localTransform }] },
      preconditions: [{ kind: "film-set-item-state", nodeId: "film", itemId: "A", contentHash: filmSetItemEditHash(original) }]
    }]);
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    expect(itemOf(forward.canvas).localTransform).toEqual(moved);
    const movedItem = itemOf(forward.canvas);

    const inverse = applyCanvasCommands(forward.canvas, [{
      type: "extension.edit",
      extensionId: "film-set",
      direction: "inverse",
      edit: { operations: [{ kind: "film-set-item-transform", nodeId: "film", itemId: "A", localTransform: original.localTransform, expectedLocalTransform: moved }] },
      preconditions: [{ kind: "film-set-item-state", nodeId: "film", itemId: "A", contentHash: filmSetItemEditHash(movedItem) }]
    }]);
    expect(inverse.ok).toBe(true);
    if (inverse.ok) expect(itemOf(inverse.canvas).localTransform).toEqual(original.localTransform);

    const stale = structuredClone(forward.canvas);
    const result = applyCanvasCommands(stale, [{
      type: "extension.edit",
      extensionId: "film-set",
      direction: "inverse",
      edit: { operations: [{ kind: "film-set-item-transform", nodeId: "film", itemId: "A", localTransform: original.localTransform }] },
      preconditions: [{ kind: "film-set-item-state", nodeId: "film", itemId: "A", contentHash: "stale-hash" }]
    }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("content-command-rejected");
    expect(stale).toEqual(forward.canvas);
  });
});

describe("canonical 联合类型", () => {
  it("不再包含片场业务命令或业务编辑操作", () => {
    expect(CANVAS_COMMAND_TYPES.some((type) => /filmSet/i.test(type))).toBe(false);
    expect(isEditApplyCommand({
      type: "edit.apply",
      preconditions: [],
      operations: [{ kind: "film-set-item-transform", nodeId: "film", itemId: "A", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } }]
    })).toBe(false);
  });
});
