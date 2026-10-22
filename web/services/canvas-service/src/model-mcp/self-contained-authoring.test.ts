import { describe, expect, it } from "vitest";
import {
  filmSetNodeDataFields, createFilmSetSnapshot, createEmptyWoohaa3ServerCanvas,
  createModel3DNodeData, model3DNodeDataFields, resolveFilmSetClip, type CanvasNodeData, type FilmSetContent
} from "@woohaa3/contracts";
import { InMemoryYjsDocumentRepository } from "../sync/index.js";
import { CanvasRoom } from "../sync/room.js";
import { FilmSetNodeService } from "@woohaa3/extension-film-set/backend";
import { ModelMcpService, type ModelMcpServiceDependencies } from "./service.js";

const NOW = "2026-10-06T00:00:00.000Z";
const SOURCE = "scene.box({ id: 'body', size: [1, 2, 1] });";
const PLACEMENT = { offset: { x: 2, y: 3, z: 4 }, scale: 2, yaw: 0.5 };

async function fixture() {
  const canvasId = "self-contained-authoring";
  const room = new CanvasRoom({ canvasId, repository: new InMemoryYjsDocumentRepository(), now: () => NOW });
  const base = createEmptyWoohaa3ServerCanvas(canvasId, NOW);
  const model = { modelScript: SOURCE, modelScriptVersion: "woohaa-model-js-v2" as const, placement: PLACEMENT };
  const animation = createFilmSetSnapshot({
    title: "动画", model, modelItemId: "actor", motionScript: "motion.model.rotate('body', { speed: 1 });", timeline: { duration: 4, loop: true },
    initialCamera: { azimuth: 0.4, elevation: 0.5, distance: 12, aspect: "4:5", focusOffset: { x: 0, y: 1, z: 0 } }
  });
  await room.initialize({
    canvas: {
      ...base,
      document: { ...base.document, nodes: [
        { id: "model", type: "model3d", position: { x: 0, y: 0 } },
        { id: "animation", type: "composite-asset", position: { x: 100, y: 0 } },
        { id: "image", type: "image", position: { x: 200, y: 0 } }
      ] },
      nodeData: {
        model: model3DNodeDataFields(createModel3DNodeData({ title: "模型", model })) as CanvasNodeData,
        animation: filmSetNodeDataFields(animation) as CanvasNodeData
      }
    }, roomEpoch: "epoch", createdAt: NOW
  });
  const service = new ModelMcpService({ resolveRoom: async () => room, now: () => NOW });
  return { canvasId, room, service };
}

function dataOf(room: CanvasRoom, id: string) {
  const exported = room.exportCanvas();
  if (!exported.ok) throw new Error(exported.message);
  return exported.canvas.nodeData[id] as CanvasNodeData;
}

describe("model3d / 复合资产片场作者接口（items-only，D7/D8/D10）", () => {
  it("updates the actual film-set scene camera without changing content or clips", async () => {
    const { canvasId, room, service } = await fixture();
    const original = structuredClone(dataOf(room, "animation"));
    const result = await service.mutateCamerasBatch({ canvasId, nodeId: "animation", requestId: "scene-camera-adjust",
      mutations: [{ kind: "update", id: "scene-camera", distance: 17 }] });
    expect(result).toMatchObject({ ok: true, cameras: [{ id: "scene-camera", distance: 17 }] });
    const updated = dataOf(room, "animation");
    expect(updated.sceneCamera).toMatchObject({ distance: 17, azimuth: 0.4 });
    expect(updated.filmSetContent).toEqual(original.filmSetContent);
    expect(updated.filmSetAnimations).toEqual(original.filmSetAnimations);
    expect(updated.modelCameras).toBeUndefined();
    expect(await service.mutateCamerasBatch({ canvasId, nodeId: "animation", requestId: "scene-camera-scope",
      mutations: [{ kind: "update", id: "scene-camera", distance: 20 }, { kind: "create", azimuth: 0, distance: 2 }] })).toMatchObject({ ok: false });
    expect(dataOf(room, "animation").sceneCamera).toEqual(updated.sceneCamera);
  });
  it.each(["model", "animation"])("%s 支持完整镜头 CRUD、幂等重试和并发新增", async (nodeId) => {
    const { canvasId, room, service } = await fixture();
    const original = structuredClone(dataOf(room, nodeId));
    const create = { canvasId, nodeId, requestId: "create", mutation: { kind: "create" as const, azimuth: 0.2, distance: 4, aspect: "4:5" as const } };
    const first = await service.mutateCameras(create);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    expect(await service.mutateCameras(create)).toMatchObject({ ok: true, duplicate: true });
    const id = first.cameras[0]!.id;
    for (const [requestId, mutation] of [
      ["update", { kind: "update", id, distance: 7 }],
      ["rename", { kind: "rename", id, name: "主视角" }],
      ["reset", { kind: "reset", id, azimuth: 0, distance: 5 }]
    ] as const) {
      expect(await service.mutateCameras({ canvasId, nodeId, requestId, mutation })).toMatchObject({ ok: true });
    }
    await Promise.all(["a", "b"].map((requestId) => service.mutateCameras({
      ...create, requestId, mutation: { kind: "create", azimuth: 1, distance: 3 }
    })));
    const read = await service.getModelNode({ canvasId, nodeId });
    expect(read).toMatchObject({ ok: true, nodeType: nodeId === "model" ? "model3d" : "composite-asset" });
    if (!read.ok) throw new Error(read.message);
    expect(read.cameras).toHaveLength(nodeId === "model" ? 3 : 4);
    if (nodeId === "animation") expect(read.cameras[0]).toMatchObject({ id: "scene-camera", azimuth: 0.4 });
    expect(await service.mutateCameras({ canvasId, nodeId, requestId: "delete", mutation: { kind: "remove", id } })).toMatchObject({ ok: true });
    const updated = dataOf(room, nodeId);
    if (nodeId === "model") {
      expect(updated.modelScript).toBe(original.modelScript);
      expect(updated.modelContentVersion).toEqual(original.modelContentVersion);
    } else {
      // 片场不写顶层模型；共享 items 与片段集合保持。
      expect(updated.modelScript).toBeUndefined();
      expect(updated.filmSetContent).toEqual(original.filmSetContent);
      expect(updated.filmSetAnimations).toEqual(original.filmSetAnimations);
    }
    const list = await service.listModelNodes({ canvasId });
    expect(list.ok && list.nodes.find((node) => node.nodeId === nodeId)).toMatchObject({ cameraCount: nodeId === "model" ? 2 : 3 });
  });

  it("model3d 提交模型支持 precondition、重试和完整历史补登记", async () => {
    const { canvasId, room } = await fixture();
    const recorded: Array<Parameters<NonNullable<ModelMcpServiceDependencies["registerModelHistory"]>>[0]> = [];
    const service = new ModelMcpService({ resolveRoom: async () => room, registerModelHistory: async (input) => { recorded.push(input); } });
    const original = structuredClone(dataOf(room, "model"));
    const read = await service.getModelNode({ canvasId, nodeId: "model" });
    if (!read.ok) throw new Error(read.message);
    const input = { canvasId, nodeId: "model", source: "scene.box({ id: 'body', size: [2, 2, 2] });", version: "woohaa-model-js-v2" as const, requestId: "edit", expectedModelContentHash: read.modelContentVersion!.contentHash };
    expect(await service.submitScript({ ...input, requestId: "" })).toMatchObject({ ok: false, code: "malformed-request" });
    expect(await service.submitScript(input)).toMatchObject({ ok: true, idempotent: false });
    // 重试携带已经消费的旧 precondition，必须先查回执，再判断版本。
    expect(await service.submitScript(input)).toMatchObject({ ok: true, idempotent: true });
    expect(await service.submitScript({ ...input, requestId: "stale" })).toMatchObject({ ok: false, code: "stale-source" });
    const updated = dataOf(room, "model");
    expect(updated.modelScript).toBe(input.source);
    expect(updated.modelContentVersion).not.toEqual(original.modelContentVersion);
    expect(recorded[0]).toMatchObject({ placement: PLACEMENT, modelScript: input.source });
    expect(await service.reconcileModelHistory({ canvasId, nodeId: "model" })).toEqual({ ok: true, recorded: true });
  });

  it("片场节点级脚本提交被拒绝且内容保持不变（D8）", async () => {
    const { canvasId, room } = await fixture();
    const service = new ModelMcpService({ resolveRoom: async () => room, now: () => NOW });
    const original = structuredClone(dataOf(room, "animation"));
    const edit = await service.submitScript({
      canvasId, nodeId: "animation", requestId: "edit", version: "woohaa-model-js-v2",
      source: "scene.box({ id: 'body', size: [3, 3, 3] });"
    });
    expect(edit).toMatchObject({ ok: false, code: "film-set-top-level-model" });
    expect(dataOf(room, "animation").filmSetContent).toEqual(original.filmSetContent);
  });

  it("相同模型版本的并发提交只有一个成功", async () => {
    const { canvasId, service } = await fixture();
    const read = await service.getModelNode({ canvasId, nodeId: "model" });
    if (!read.ok) throw new Error(read.message);
    const results = await Promise.all([1, 2].map((size) => service.submitScript({
      canvasId, nodeId: "model", requestId: `edit-${size}`, version: "woohaa-model-js-v2",
      source: `scene.box({ id: 'body', size: [${size}, 1, 3] });`, expectedModelContentHash: read.modelContentVersion!.contentHash
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ code: "stale-source" });
  });

  it("从片场创建新片场复制其首个 model item 与来源 placement", async () => {
    const { canvasId, room } = await fixture();
    const service = new FilmSetNodeService({ resolveRoom: async () => room });
    const result = await service.createFilmSetFromNode({ canvasId, requestId: "copy", nodeId: "copy", sourceNodeId: "animation", position: { x: 300, y: 0 } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const item = result.animation.filmSetContent.items.find(entry => entry.kind === "model")!;
    if (item.kind !== "model") throw new Error("expected model item");
    expect(item.model.placement).toEqual(PLACEMENT);
    expect(item.model.modelScript).toBe(SOURCE);
  });

  it("图片节点仍拒绝镜头和模型脚本写入", async () => {
    const { canvasId, service } = await fixture();
    expect(await service.mutateCameras({ canvasId, nodeId: "image", requestId: "camera", mutation: { kind: "create", azimuth: 0, distance: 3 } })).toMatchObject({ ok: false, code: "invalid-node-type" });
    expect(await service.submitScript({ canvasId, nodeId: "image", source: SOURCE, requestId: "img" })).toMatchObject({ ok: false, code: "invalid-node-type" });
  });

  it("item 导入替换保留片场其他 items 与全部片段（D8/D9）", async () => {
    const { canvasId, room } = await fixture();
    const service = new FilmSetNodeService({ resolveRoom: async () => room, now: () => NOW });
    const before = dataOf(room, "animation");
    const beforeContent = structuredClone(before.filmSetContent) as FilmSetContent;
    const beforeAnimations = structuredClone(before.filmSetAnimations);
    const outcome = await service.importModel({
      canvasId, nodeId: "animation", itemId: "actor", requestId: "reimport", modelScriptVersion: "woohaa-model-js-v2",
      modelScript: "scene.box({ id: 'body', size: [3, 3, 3] });"
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    const after = dataOf(room, "animation");
    // 片段集合保持；其他 items（这里只有默认地面）保持；目标 item 模型更新。
    expect(after.filmSetAnimations).toEqual(beforeAnimations);
    const afterContent = after.filmSetContent as FilmSetContent;
    const ground = beforeContent.items.find(item => item.kind === "ground");
    if (ground) expect(afterContent.items.find(item => item.id === ground.id)).toEqual(ground);
    const actor = afterContent.items.find(item => item.kind === "model")!;
    if (actor.kind !== "model") throw new Error("expected model item");
    expect(actor.model.modelScript).toContain("[3, 3, 3]");
    // 片段视图仍可解析绑定。
    expect(resolveFilmSetClip(after as never, "clip-1")).toBeTruthy();
  });
});
