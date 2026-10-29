import { checkAnimationMotion, readFilmSetAnimationProjection, prepareFilmSetGroup } from "@woohaa3/contracts";
import { filmSetItemAdapterHash, resolveFilmSetClip } from "@woohaa3/contracts";
/**
 * 动画节点权威写入服务测试
 * （change: 2026-10-11-extract-film-set-extension，D7/D8/D9/D10 —— items-only）。
 *
 * 覆盖：创建快照并把来源模型复制为 model item、直接创建、导入替换指定 item 保留运动与旧适配版本、
 * snapshotHash 并发拒绝、commandId 幂等、来源只是说明（不改变数据所有权）。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  type CanvasNodeData
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { InMemoryYjsDocumentRepository } from "../../../services/canvas-service/src/sync/index.js";
import { CanvasRoom } from "../../../services/canvas-service/src/sync/room.js";
import { FilmSetNodeService, readFilmSet } from "../src/backend.js";

const NOW = "2026-10-05T00:00:00.000Z";
const SCRIPT = "scene.box({ id: 'torso', size: [1, 2, 0.5] });";
const MODEL_ITEM_ID = "model";

async function readyRoom(canvasId: string, nodes: Array<{ id: string; type: string }> = []): Promise<{ room: CanvasRoom }> {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId, repository, now: () => NOW });
  const base = createEmptyWoohaa3ServerCanvas(canvasId, NOW);
  await room.initialize({
    canvas: {
      ...base,
      document: {
        ...base.document,
        nodes: nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } }))
      },
      nodeData: nodes.reduce<Record<string, CanvasNodeData>>((acc, node) => {
        if (node.type === "model3d") {
          // 自包含 model3d 必须携带完整本地模型定义（命令边界校验要求）。
          acc[node.id] = {
            modelScript: SCRIPT,
            modelScriptLanguage: "javascript",
            modelScriptVersion: "woohaa-model-js-v2",
            modelContentVersion: { revision: 1, sourceHash: "src-from-model", contentHash: "content-from-model" },
            modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
          };
        }
        return acc;
      }, {})
    },
    roomEpoch: "epoch-1",
    createdAt: NOW
  });
  return { room };
}

function serviceFor(room: CanvasRoom | null): FilmSetNodeService {
  return new FilmSetNodeService({ resolveRoom: async () => room, now: () => NOW });
}

const MODEL = { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" as const };

/** 取片场默认片段的 clipId。 */
function defaultClipId(animation: { filmSetAnimations?: { defaultClipId: string | null } }): string {
  const clipId = animation.filmSetAnimations?.defaultClipId;
  if (!clipId) throw new Error("missing default clip");
  return clipId;
}

describe("FilmSetNodeService.createFilmSet（任务 2.1 / D8）", () => {
  it("从显式模型创建 items-only 片场，来源模型成为 model item 且动作只存 binding", async () => {
    const { room } = await readyRoom("canvas-create");
    const outcome = await serviceFor(room).createFilmSet({
      canvasId: "canvas-create",
      requestId: "req-1",
      nodeId: "anim-1",
      position: { x: 100, y: 50 },
      model: MODEL,
      motionScript: `motion.model.rotate("torso", { speed: 0.5 });`,
      timeline: { duration: 4, loop: false }
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    // 不写顶层模型；几何只在 model item。
    expect(outcome.animation.filmSetContent.items.find(item => item.id === MODEL_ITEM_ID)?.kind).toBe("model");
    const view = resolveFilmSetClip(outcome.animation, defaultClipId(outcome.animation));
    expect(view?.clip.bindings[0]?.itemId).toBe(MODEL_ITEM_ID);
    const item = outcome.animation.filmSetContent.items.find(item => item.id === MODEL_ITEM_ID)!;
    if (item.kind !== "model") throw new Error("expected model item");
    expect(view?.clip.bindings[0]?.motion?.basedOnModelVersion.contentHash).toBe(item.model.contentVersion.contentHash);
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.document.nodes.find((node) => node.id === "anim-1")?.type).toBe("group");
  });

  it("相同 requestId 重试幂等，不重复创建节点", async () => {
    const { room } = await readyRoom("canvas-idem");
    const service = serviceFor(room);
    const input = {
      canvasId: "canvas-idem",
      requestId: "req-2",
      nodeId: "anim-2",
      position: { x: 0, y: 0 },
      model: MODEL,
      timeline: { duration: 0, loop: false }
    };
    const first = await service.createFilmSet(input);
    const second = await service.createFilmSet(input);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.document.nodes.filter((node) => node.id === "anim-2")).toHaveLength(1);
    expect(exported.canvas.revision).toBe(1);
  });

  it("从模型节点创建时绑定当前来源，提交不持久化模型快照", async () => {
    const { room } = await readyRoom("canvas-from-model", [{ id: "model-1", type: "model3d" }]);
    const outcome = await serviceFor(room).createFilmSetFromNode({
      canvasId: "canvas-from-model",
      requestId: "req-3",
      nodeId: "anim-3",
      position: { x: 200, y: 0 },
      sourceNodeId: "model-1",
      timeline: { duration: 0, loop: false }
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.nodeData["anim-3"].filmSetGroup?.sceneBindings[0]?.sourceNodeId).toBe("model-1");
    expect(exported.canvas.nodeData["anim-3"].filmSetContent).toBeUndefined();
    const remaining = await serviceFor(room).commitFilmSet({
      canvasId: "canvas-from-model",
      requestId: "req-3b",
      nodeId: "anim-3",
      animation: outcome.animation
    });
    expect(remaining.ok).toBe(true);
    void exported;
  });

  it("重复节点 id 稳定拒绝", async () => {
    const { room } = await readyRoom("canvas-dup", [{ id: "anim-4", type: "composite-asset" }]);
    const outcome = await serviceFor(room).createFilmSet({
      canvasId: "canvas-dup",
      requestId: "req-4",
      nodeId: "anim-4",
      position: { x: 0, y: 0 },
      model: MODEL
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("duplicate-node");
  });
});

describe("FilmSetNodeService 导入与确认适配（任务 2.2 / 3.4 / D8/D10）", () => {
  async function createdAnimation(): Promise<{ room: CanvasRoom; animation: Awaited<ReturnType<FilmSetNodeService["createFilmSet"]>> }> {
    const { room } = await readyRoom("canvas-import");
    const animation = await serviceFor(room).createFilmSet({
      canvasId: "canvas-import",
      requestId: "req-5",
      nodeId: "anim-5",
      position: { x: 0, y: 0 },
      model: MODEL,
      motionScript: `motion.model.rotate("torso", { speed: 0.5 });`,
      timeline: { duration: 4, loop: false }
    });
    return { room, animation };
  }

  it("导入替换指定 model item 保留 binding 动作与旧适配版本并推进本地 revision", async () => {
    const { room, animation } = await createdAnimation();
    if (!animation.ok) throw new Error("create failed");
    const beforeView = resolveFilmSetClip(animation.animation, defaultClipId(animation.animation))!;
    const imported = await serviceFor(room).importModel({
      canvasId: "canvas-import",
      requestId: "req-6",
      nodeId: "anim-5",
      itemId: MODEL_ITEM_ID,
      modelScript: "scene.box({ id: 'torso', size: [2, 2, 0.5] });",
      modelScriptVersion: "woohaa-model-js-v2"
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const importedItem = imported.animation.filmSetContent.items.find(item => item.id === MODEL_ITEM_ID)!;
    if (importedItem.kind !== "model") throw new Error("expected model item");
    expect(importedItem.model.contentVersion.revision).toBe(2);
    const afterView = resolveFilmSetClip(imported.animation, defaultClipId(imported.animation))!;
    expect(afterView.clip.bindings[0]?.motion?.sourceHash).toBe(beforeView.clip.bindings[0]?.motion?.sourceHash);
    expect(afterView.clip.bindings[0]?.motion?.basedOnModelVersion.contentHash).toBe(
      beforeView.clip.bindings[0]?.motion?.basedOnModelVersion.contentHash
    );
    expect(afterView.clip.bindings[0]?.motion?.basedOnModelVersion.contentHash).not.toBe(
      importedItem.model.contentVersion.contentHash
    );
  });

  it("stale source precondition 阻止覆盖并发修改", async () => {
    const { room, animation } = await createdAnimation();
    if (!animation.ok) throw new Error("create failed");
    const stale = await serviceFor(room).importModel({
      canvasId: "canvas-import",
      requestId: "req-7",
      nodeId: "anim-5",
      itemId: MODEL_ITEM_ID,
      modelScript: SCRIPT,
      modelScriptVersion: "woohaa-model-js-v2",
      expectedSourceHash: "not-the-current-hash"
    });
    expect(!stale.ok && stale.code).toBe("stale-source");
  });

  it("确认适配把指定 binding 的关联对齐到当前 item 模型", async () => {
    const { room, animation } = await createdAnimation();
    if (!animation.ok) throw new Error("create failed");
    await serviceFor(room).importModel({
      canvasId: "canvas-import",
      requestId: "req-8",
      nodeId: "anim-5",
      itemId: MODEL_ITEM_ID,
      modelScript: "scene.box({});",
      modelScriptVersion: "woohaa-model-js-v2"
    });
    const read = await serviceFor(room).readNodeFilmSet({ canvasId: "canvas-import", nodeId: "anim-5" });
    if (!read.ok) throw new Error("read failed");
    const item = read.animation.filmSetContent.items.find(entry => entry.id === MODEL_ITEM_ID)!;
    if (item.kind !== "model") throw new Error("expected model item");
    const confirmed = await serviceFor(room).confirmAdaptation({
      canvasId: "canvas-import",
      requestId: "req-9",
      nodeId: "anim-5",
      clipId: defaultClipId(read.animation),
      itemId: MODEL_ITEM_ID,
      expectedAdapterHash: filmSetItemAdapterHash(item)
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    const view = resolveFilmSetClip(confirmed.animation, defaultClipId(confirmed.animation))!;
    const confirmedItem = confirmed.animation.filmSetContent.items.find(entry => entry.id === MODEL_ITEM_ID)!;
    if (confirmedItem.kind !== "model") throw new Error("expected model item");
    expect(view.clip.bindings[0]?.motion?.basedOnModelVersion.contentHash).toBe(
      confirmedItem.model.contentVersion.contentHash
    );
    expect(checkAnimationMotion(view).versionMatch).toBe("matched");
  });

  it("snapshotHash 不一致时 commit 被拒绝", async () => {
    const { room, animation } = await createdAnimation();
    if (!animation.ok) throw new Error("create failed");
    const rejected = await serviceFor(room).commitFilmSet({
      canvasId: "canvas-import",
      requestId: "req-10",
      nodeId: "anim-5",
      animation: animation.animation,
      expectedSnapshotHash: "different"
    });
    expect(!rejected.ok && rejected.code).toBe("stale-snapshot");
  });

  it("clip 指定但 hash 不匹配时 commit 被拒绝", async () => {
    const { room, animation } = await createdAnimation();
    if (!animation.ok) throw new Error("create failed");
    const rejected = await serviceFor(room).commitFilmSet({
      canvasId: "canvas-import",
      requestId: "req-10b",
      nodeId: "anim-5",
      animation: animation.animation,
      clipId: defaultClipId(animation.animation),
      expectedClipHash: "different"
    });
    expect(!rejected.ok && rejected.code).toBe("stale-clip");
  });

  it("导入可执行性非法或含旧动画的模型被拒绝（任务 1.3/R7）", async () => {
    const { room, animation } = await createdAnimation();
    if (!animation.ok) throw new Error("create failed");
    const invalid = await serviceFor(room).importModel({
      canvasId: "canvas-import",
      requestId: "req-invalid",
      nodeId: "anim-5",
      itemId: MODEL_ITEM_ID,
      modelScript: "scene.box(",
      modelScriptVersion: "woohaa-model-js-v2"
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.code.startsWith("model-script-")).toBe(true);

    const legacy = await serviceFor(room).importModel({
      canvasId: "canvas-import",
      requestId: "req-legacy",
      nodeId: "anim-5",
      itemId: MODEL_ITEM_ID,
      modelScript: `scene.box({ id: "b", size: [1,1,1] });\nscene.rotate("b", { axis: "y", speed: 1 });`,
      modelScriptVersion: "woohaa-model-js-v2"
    });
    expect(!legacy.ok && legacy.code).toBe("legacy-animation-in-model");
  });
});

describe("FilmSetNodeService.readFilmSet", () => {
  it("从权威画布读回结构化片场节点", async () => {
    const { room } = await readyRoom("canvas-read");
    await serviceFor(room).createFilmSet({
      canvasId: "canvas-read",
      requestId: "req-11",
      nodeId: "anim-11",
      position: { x: 0, y: 0 },
      model: MODEL,
      timeline: { duration: 0, loop: false }
    });
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    const read = readFilmSet(exported.canvas, "anim-11");
    expect(read.ok).toBe(true);
  });

  it("readNodeFilmSet 返回 items-only 定义与片段视图（生成层读取）", async () => {
    const { room } = await readyRoom("canvas-read-node");
    await serviceFor(room).createFilmSet({
      canvasId: "canvas-read-node",
      requestId: "req-read",
      nodeId: "anim-read",
      position: { x: 0, y: 0 },
      model: MODEL,
      motionScript: `motion.model.rotate("torso", { speed: 0.5 });`,
      timeline: { duration: 4, loop: false }
    });
    const read = await serviceFor(room).readNodeFilmSet({ canvasId: "canvas-read-node", nodeId: "anim-read" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const item = read.animation.filmSetContent.items.find(entry => entry.id === MODEL_ITEM_ID)!;
    if (item.kind !== "model") throw new Error("expected model item");
    expect(item.model.modelScript).toBe(SCRIPT);
    const view = resolveFilmSetClip(read.animation, defaultClipId(read.animation))!;
    expect(view.clip.bindings[0]?.motion?.motionScript).toContain("rotate");
    expect(view.timeline).toEqual({ duration: 4, loop: false });
  });

  it("readNodeFilmSet 对非动画/未知节点稳定拒绝", async () => {
    const { room } = await readyRoom("canvas-read-miss", [{ id: "model-r", type: "model3d" }]);
    const notAnim = await serviceFor(room).readNodeFilmSet({ canvasId: "canvas-read-miss", nodeId: "model-r" });
    expect(notAnim.ok).toBe(false);
    const missing = await serviceFor(room).readNodeFilmSet({ canvasId: "canvas-read-miss", nodeId: "nope" });
    expect(!missing.ok && missing.code).toBe("unknown-node");
  });
});

describe("group source lifecycle", () => {
  it("reads source changes live, preserves missing binding on deletion and never stores snapshots", async () => {
    const { room } = await readyRoom("canvas-e2e", [{ id: "model-src", type: "model3d" }]);
    const service = serviceFor(room);
    const created = await service.createFilmSetFromNode({ canvasId: "canvas-e2e", requestId: "create", nodeId: "film", position: { x: 0, y: 0 }, sourceNodeId: "model-src", timeline: { duration: 0, loop: false } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error(exported.message);
    const original = structuredClone(exported.canvas);
    const replacement = "scene.box({ id: 'torso', size: [3,2,1] });";
    const changed = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas-e2e", actorId: "test", commandId: "replace", baseRevision: exported.canvas.revision, commands: [{ type: "nodeData.patch", nodeId: "model-src", value: { modelScript: replacement } }] });
    expect(changed.ok).toBe(true);
    const latest = room.exportCanvas();
    if (!latest.ok) throw new Error(latest.message);
    expect(readFilmSetAnimationProjection(latest.canvas, "film")?.filmSetContent.items[0]).toMatchObject({ kind: "model", model: { modelScript: replacement } });
    expect(readFilmSetAnimationProjection(original, "film")?.filmSetContent.items[0]).toMatchObject({ model: { modelScript: SCRIPT } });
    expect(latest.canvas.nodeData.film.filmSetContent).toBeUndefined();
    const deleted = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas-e2e", actorId: "test", commandId: "delete", baseRevision: latest.canvas.revision, commands: [{ type: "node.remove", nodeIds: ["model-src"] }] });
    expect(deleted.ok).toBe(true);
    const missing = room.exportCanvas();
    if (!missing.ok) throw new Error(missing.message);
    expect(prepareFilmSetGroup(missing.canvas, "film")?.diagnostics[0]?.code).toBe("missing-source");
    expect(missing.canvas.nodeData.film.filmSetGroup?.sceneBindings[0]?.sourceNodeId).toBe("model-src");
  });
});
