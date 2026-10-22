/**
 * ModelMcpService 权威提交测试
 * （change: integrate-origin-master-after-web-split；
 *  change: replace-godot-canvas-runtime-with-bevy 更新为版本化 JavaScript；
 *  change: 2026-10-07-remove-legacy-node-type-compat 移除旧 GDScript 迁移）。
 *
 * 覆盖 spec「模型脚本使用版本化 JavaScript」：
 * - 合法 JavaScript 脚本在权威 room 中以稳定 commandId 提交；
 * - 重复提交幂等；
 * - 非版本化脚本直接写入被拒绝；
 * - 非法脚本（空/超长/非模型节点/不可执行）在写入前失败且不改节点状态。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, modelSourceHash, filmSetNodeDataFields, createFilmSetSnapshot, type CanvasNodeData } from "@woohaa3/contracts";
import { InMemoryYjsDocumentRepository } from "../sync/index.js";
import { CanvasRoom } from "../sync/room.js";
import { filmSetFrameRuntime } from "@woohaa3/extension-film-set/backend";
import { ModelMcpService } from "./service.js";

const NOW = "2026-09-24T00:00:00.000Z";

/** 受支持的 woohaa-model-js-v2 脚本。 */
const VALID_SCRIPT = "scene.box({ id: 'body', size: [1, 2, 1], color: '#ff0000' });";

/** 自包含 model3d 节点的默认合法定义（新建模型节点必须携带完整本地模型）。 */
const BASE_MODEL_NODE_DATA: CanvasNodeData = {
  title: "模型",
  modelScript: VALID_SCRIPT,
  modelScriptLanguage: "javascript",
  modelScriptVersion: "woohaa-model-js-v2",
  modelContentVersion: {
    revision: 1,
    sourceHash: modelSourceHash(VALID_SCRIPT),
    contentHash: "base-content"
  },
  modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
};

async function readyRoom(canvasId: string, nodeData: Record<string, CanvasNodeData> = {}): Promise<{ room: CanvasRoom; repository: InMemoryYjsDocumentRepository }> {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId, repository, now: () => NOW });
  const base = createEmptyWoohaa3ServerCanvas(canvasId, NOW);
  await room.initialize({
    canvas: {
      ...base,
      document: {
        ...base.document,
        nodes: [
          { id: "model-1", type: "model3d", position: { x: 0, y: 0 } },
          { id: "image-1", type: "image", position: { x: 160, y: 0 } }
        ]
      },
      nodeData: {
        "model-1": { ...BASE_MODEL_NODE_DATA, ...(nodeData["model-1"] ?? {}) },
        ...Object.fromEntries(Object.entries(nodeData).filter(([id]) => id !== "model-1"))
      }
    },
    roomEpoch: "epoch-1",
    createdAt: NOW
  });
  return { room, repository };
}

function serviceFor(room: CanvasRoom | null): ModelMcpService {
  return new ModelMcpService({ resolveRoom: async () => room, now: () => NOW });
}

/** 带前序参考（图片 + 文本）的画布 room，用于验证 MCP 读取 references。 */
async function readyRoomWithReferences(canvasId: string, storageKey: string): Promise<{ room: CanvasRoom }> {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId, repository, now: () => NOW });
  const base = createEmptyWoohaa3ServerCanvas(canvasId, NOW);
  const canvas = {
    ...base,
    document: {
      ...base.document,
      nodes: [
        { id: "model-1", type: "model3d" as const, position: { x: 0, y: 0 } },
        { id: "img-1", type: "image" as const, position: { x: 200, y: 0 } },
        { id: "txt-1", type: "text" as const, position: { x: 400, y: 0 } }
      ],
      edges: [
        { id: "e-img", source: "img-1", target: "model-1", data: {} },
        { id: "e-txt", source: "txt-1", target: "model-1", data: {} }
      ]
    },
    nodeData: {
      "model-1": {
        inputMapping: [
          { slotId: "slot-img", sourceNodeId: "img-1", role: "reference_image", sortKey: "0" },
          { slotId: "slot-txt", sourceNodeId: "txt-1", role: "text_prompt", sortKey: "1" }
        ]
      },
      "img-1": { outputAssetId: "asset-img" },
      "txt-1": { prompt: "银色铠甲骑士" }
    } as Record<string, CanvasNodeData>,
    assets: [
      {
        id: "asset-img",
        title: "参考图",
        mediaKind: "image" as const,
        source: "generated" as const,
        status: "ready" as const,
        createdAt: NOW,
        metadata: { storageKey, checksum: "c".repeat(64), contentType: "image/png", size: 4 }
      }
    ]
  };
  await room.initialize({ canvas, roomEpoch: "epoch-1", createdAt: NOW });
  return { room };
}

describe("ModelMcpService.applyCommands（change: split-model-mcp-into-mcp-service）", () => {
  it("以注入的 actorId 提交语义命令并落库", async () => {
    const { room } = await readyRoom("canvas-apply");
    const service = new ModelMcpService({
      resolveRoom: async () => room,
      now: () => NOW,
      actorId: "mcp-service"
    });
    const outcome = await service.applyCommands({
      canvasId: "canvas-apply",
      commandId: "intent-1",
      baseRevision: 0,
      commands: [
        { type: "node.add", node: { id: "new-1", type: "text", position: { x: 10, y: 20 } } },
        { type: "nodeData.patch", nodeId: "new-1", value: { prompt: "hi" } }
      ]
    });
    expect(outcome.ok).toBe(true);
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export failed");
    expect(exported.canvas.document.nodes.some((node) => node.id === "new-1")).toBe(true);
    expect((exported.canvas.nodeData["new-1"] as CanvasNodeData | undefined)?.prompt).toBe("hi");
  });

  it("相同 commandId 与 payload 重试幂等", async () => {
    const { room } = await readyRoom("canvas-apply-idem");
    const service = serviceFor(room);
    const input = {
      canvasId: "canvas-apply-idem",
      commandId: "intent-2",
      baseRevision: 0,
      commands: [{ type: "canvas.setTitle" as const, title: "T" }]
    };
    const first = await service.applyCommands(input);
    const second = await service.applyCommands(input);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export failed");
    expect(exported.canvas.revision).toBe(1);
  });

  it("画布不存在时返回 canvas-not-found", async () => {
    const service = serviceFor(null);
    const outcome = await service.applyCommands({
      canvasId: "missing",
      commandId: "intent-3",
      baseRevision: 0,
      commands: [{ type: "canvas.setTitle", title: "T" }]
    });
    expect(outcome).toMatchObject({ ok: false, code: "canvas-not-found" });
  });
});

describe("ModelMcpService.submitScript", () => {
  it("读取 model3d 节点当前的权威 scripting model", async () => {
    const { room } = await readyRoom("canvas-model", {
      "model-1": {
        title: "银色骑士",
        prompt: "持剑站立",
        modelScript: VALID_SCRIPT,
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        modelScriptStatus: "ok"
      }
    });
    const service = serviceFor(room);
    const outcome = await service.getModelNode({ canvasId: "canvas-model", nodeId: "model-1" });
    expect(outcome).toMatchObject({
      ok: true,
      canvasId: "canvas-model",
      nodeId: "model-1",
      title: "银色骑士",
      prompt: "持剑站立",
      source: VALID_SCRIPT,
      language: "javascript",
      version: "woohaa-model-js-v2",
      status: "ok"
    });
    if (outcome.ok) expect(Array.isArray(outcome.references)).toBe(true);
  });

  it("为已存在的 model3d 节点提交版本化 JavaScript 并写入权威 nodeData", async () => {
    const { room } = await readyRoom("canvas-model");
    const service = serviceFor(room);
    const outcome = await service.submitScript({
      canvasId: "canvas-model",
      nodeId: "model-1",
      source: VALID_SCRIPT,
      requestId: "req-submit-1"
    });
    expect(outcome.ok).toBe(true);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const data = exported.canvas.nodeData["model-1"] as CanvasNodeData;
    expect(data.modelScript).toBe(VALID_SCRIPT);
    expect(data.modelScriptLanguage).toBe("javascript");
    // 省略 version 时默认使用首选版本 V2（spec「新脚本使用 V2」）。
    expect(data.modelScriptVersion).toBe("woohaa-model-js-v2");
  });

  it("支持为 model3d 节点提交脚本并归一化内容版本（change: 2026-10-06-fix-animation3d...，任务 5.2）", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({ canvasId: "canvas-model3d", repository, now: () => NOW });
    const base = createEmptyWoohaa3ServerCanvas("canvas-model3d", NOW);
    await room.initialize({
      canvas: {
        ...base,
        document: { ...base.document, nodes: [{ id: "m3d-1", type: "model3d", position: { x: 0, y: 0 } }] },
        nodeData: {
          "m3d-1": {
            title: "3D 模型",
            modelScript: "scene.box({ id: 'old', size: [1, 1, 1] });",
            modelScriptLanguage: "javascript",
            modelScriptVersion: "woohaa-model-js-v2",
            modelContentVersion: { revision: 1, sourceHash: "s1", contentHash: "c1" },
            modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
          } as unknown as CanvasNodeData
        }
      },
      roomEpoch: "epoch-1",
      createdAt: NOW
    });
    const service = new ModelMcpService({ resolveRoom: async () => room });

    // 缺少 requestId：在写入前拒绝。
    expect(await service.submitScript({ canvasId: "canvas-model3d", nodeId: "m3d-1", source: VALID_SCRIPT, requestId: "" }))
      .toMatchObject({ ok: false, code: "malformed-request" });

    // 内容 precondition 不匹配：拒绝并发覆盖。
    expect(
      await service.submitScript({
        canvasId: "canvas-model3d",
        nodeId: "m3d-1",
        source: VALID_SCRIPT,
        requestId: "req-1",
        expectedModelContentHash: "stale"
      })
    ).toMatchObject({ ok: false, code: "stale-source" });

    // 合法提交：写入脚本并由 canonical 归一化内容版本。
    const outcome = await service.submitScript({
      canvasId: "canvas-model3d",
      nodeId: "m3d-1",
      source: VALID_SCRIPT,
      requestId: "req-1"
    });
    expect(outcome.ok).toBe(true);
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    const data = exported.canvas.nodeData["m3d-1"] as CanvasNodeData;
    expect(data.modelScript).toBe(VALID_SCRIPT);
    expect((data.modelContentVersion as { contentHash: string }).contentHash).not.toBe("c1");

    // 相同 requestId 重试：稳定幂等（不重复推进 revision）。
    const retry = await service.submitScript({
      canvasId: "canvas-model3d",
      nodeId: "m3d-1",
      source: VALID_SCRIPT,
      requestId: "req-1"
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.idempotent).toBe(true);
  });

  it("拒绝已下线的 V1 版本（V2-only）", async () => {
    const { room } = await readyRoom("canvas-model");
    const service = serviceFor(room);
    const outcome = await service.submitScript({
      canvasId: "canvas-model",
      nodeId: "model-1",
      source: VALID_SCRIPT,
      version: "woohaa-model-js-v1" as never,
      requestId: "req-v1"
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unsupported-version");
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    // 拒绝发生在写入前：权威数据未变化。
    expect(exported.canvas.revision).toBe(0);
  });

  it("拒绝未知脚本版本且不写 Y.Doc", async () => {
    const { room } = await readyRoom("canvas-model");
    const service = serviceFor(room);
    const outcome = await service.submitScript({
      canvasId: "canvas-model",
      nodeId: "model-1",
      source: VALID_SCRIPT,
      version: "woohaa-model-js-v9" as never,
      requestId: "req-unknown"
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unsupported-version");
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(0);
  });

  it("拒绝把旧 GDScript 当作模型脚本写入", async () => {
    const { room } = await readyRoom("canvas-model");
    const service = serviceFor(room);
    const gdscript = "extends RefCounted\nfunc build(scene):\n\treturn {}";
    const outcome = await service.submitScript({
      canvasId: "canvas-model", nodeId: "model-1", source: gdscript, requestId: "req-gd"
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code.startsWith("model-script-")).toBe(true);
  });

  it("重复提交相同脚本是幂等的（稳定 commandId）", async () => {
    const { room } = await readyRoom("canvas-model");
    const service = serviceFor(room);
    const first = await service.submitScript({
      canvasId: "canvas-model", nodeId: "model-1", source: VALID_SCRIPT, requestId: "req-idem"
    });
    const second = await service.submitScript({
      canvasId: "canvas-model", nodeId: "model-1", source: VALID_SCRIPT, requestId: "req-idem"
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.commandId).toBe(second.commandId);
    expect(second.idempotent).toBe(true);
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(1);
  });

  it("以 source hash 幂等登记模型历史（同 source 不产生重复版本）", async () => {
    const { room } = await readyRoom("canvas-model");
    const recorded: string[] = [];
    const service = new ModelMcpService({
      resolveRoom: async () => room,
      now: () => NOW,
      registerModelHistory: async (input) => { recorded.push(`${input.sourceHash}:${input.version}`); }
    });
    await service.submitScript({ canvasId: "canvas-model", nodeId: "model-1", source: VALID_SCRIPT, requestId: "req-h1" });
    await service.submitScript({ canvasId: "canvas-model", nodeId: "model-1", source: VALID_SCRIPT, requestId: "req-h2" });
    // 两次提交都登记：服务层用稳定 identity 幂等，repository 侧去重为单一版本。
    expect(recorded).toHaveLength(2);
    expect(new Set(recorded).size).toBe(1);
  });

  it("reconcileModelHistory 从权威脚本补齐并幂等", async () => {
    const { room } = await readyRoom("canvas-model");
    let recorded = 0;
    const service = new ModelMcpService({
      resolveRoom: async () => room,
      now: () => NOW,
      registerModelHistory: async () => { recorded += 1; }
    });
    await service.submitScript({ canvasId: "canvas-model", nodeId: "model-1", source: VALID_SCRIPT, requestId: "req-r1" });
    const outcome = await service.reconcileModelHistory({ canvasId: "canvas-model", nodeId: "model-1" });
    expect(outcome).toEqual({ ok: true, recorded: true });
    expect(recorded).toBe(2);
  });

  it("nodeId 为空 / 脚本为空 / 超长 / 不可执行 都在写入前失败", async () => {
    const { room } = await readyRoom("canvas-model");
    const service = serviceFor(room);
    const cases = [
      { nodeId: "model-1", source: "   ", code: "malformed-request", requestId: "req-c0" },
      { nodeId: "model-1", source: `scene.box({ id: 'x' });${"/*pad*/".repeat(30_000)}`, code: "limit-exceeded", requestId: "req-c1" },
      { nodeId: "model-1", source: "scene.box(this is not valid js", code: "model-script-compile", requestId: "req-c2" }
    ];
    for (const entry of cases) {
      const outcome = await service.submitScript({
        canvasId: "canvas-model", nodeId: entry.nodeId, source: entry.source, requestId: entry.requestId
      });
      expect(outcome.ok, JSON.stringify(entry)).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe(entry.code);
    }
    // 缺 nodeId 在任何写入前即以 malformed-request 失败。
    const emptyNode = await service.submitScript({
      canvasId: "canvas-model", nodeId: "", source: VALID_SCRIPT, requestId: "req-c3"
    });
    expect(emptyNode).toMatchObject({ ok: false, code: "malformed-request" });
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(0);
    expect((exported.canvas.nodeData["model-1"] as CanvasNodeData | undefined)?.modelScript).toBe(VALID_SCRIPT);
  });

  it("非模型节点被拒绝且不改变状态", async () => {
    const { room } = await readyRoom("canvas-model");
    const service = serviceFor(room);
    const outcome = await service.submitScript({
      canvasId: "canvas-model", nodeId: "image-1", source: VALID_SCRIPT, requestId: "req-img"
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("invalid-node-type");
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(0);
  });

  it("getModelNode 接受片场并返回 items-only 完整定义与片段（D7/D8/D10）", async () => {
    const animationData = filmSetNodeDataFields(createFilmSetSnapshot({
      title: "片场",
      model: { modelScript: "scene.box({ id: 'torso', size: [1,1,1] });", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor",
      motionScript: "motion.model.rotate('torso', { speed: 1 });",
      timeline: { duration: 4, loop: true },
      initialCamera: { azimuth: 0.25, elevation: 0.5, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 1, z: 0 } }
    }));
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({ canvasId: "canvas-anim-read", repository, now: () => NOW });
    const base = createEmptyWoohaa3ServerCanvas("canvas-anim-read", NOW);
    await room.initialize({
      canvas: {
        ...base,
        document: { ...base.document, nodes: [
          { id: "anim-1", type: "composite-asset", position: { x: 0, y: 0 } },
          { id: "image-1", type: "image", position: { x: 1, y: 0 } }
        ] },
        nodeData: { "anim-1": animationData as unknown as CanvasNodeData }
      },
      roomEpoch: "epoch-1",
      createdAt: NOW
    });
    const service = new ModelMcpService({ resolveRoom: async () => room });
    const outcome = await service.getModelNode({ canvasId: "canvas-anim-read", nodeId: "anim-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.nodeType).toBe("composite-asset");
    expect(outcome.animation?.filmSetContent.items.some(item => item.id === "actor" && item.kind === "model")).toBe(true);
    expect(outcome.animation?.filmSetAnimations.defaultClipId).toBe("clip-1");
    expect(outcome.animation?.timeline).toEqual({ duration: 4, loop: true });
    expect(outcome.animation?.initialCamera).toMatchObject({ distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 1, z: 0 } });
    // 非 3D 节点仍拒绝。
    expect(await service.getModelNode({ canvasId: "canvas-anim-read", nodeId: "image-1" }))
      .toMatchObject({ ok: false, code: "invalid-node-type" });
  });

  it("画布不存在返回 canvas-not-found", async () => {
    const service = serviceFor(null);
    const outcome = await service.submitScript({ canvasId: "missing", nodeId: "model-1", source: VALID_SCRIPT, requestId: "req-missing" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("canvas-not-found");
  });

  it("getModelNode 返回前序参考输入（文本 + 图片稳定引用）", async () => {
    const storageKey = `sha256-${"c".repeat(64)}.png`;
    const { room } = await readyRoomWithReferences("canvas-refs", storageKey);
    const service = serviceFor(room);
    const outcome = await service.getModelNode({ canvasId: "canvas-refs", nodeId: "model-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const kinds = outcome.references.map((reference) => reference.kind).sort();
    expect(kinds).toEqual(["image", "text"]);
    const image = outcome.references.find((reference) => reference.kind === "image")!;
    expect(image.asset).toMatchObject({ assetId: "asset-img", storageKey });
    expect(image.asset!.url.startsWith("/api/media/")).toBe(true);
    const text = outcome.references.find((reference) => reference.kind === "text")!;
    expect(text.text).toBe("银色铠甲骑士");
  });

  it("reportScript failed 写入稳定失败状态，ok 写入成功状态", async () => {
    const { room } = await readyRoom("canvas-model");
    const service = serviceFor(room);
    const failed = await service.reportScript({
      canvasId: "canvas-model",
      nodeId: "model-1",
      status: "failed",
      message: "fail:reload"
    });
    expect(failed.ok).toBe(true);
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    const data = exported.canvas.nodeData["model-1"] as CanvasNodeData;
    expect(data.modelScriptStatus).toBe("failed");
    expect(data.modelScriptError).toBe("fail:reload");

    const ok = await service.reportScript({ canvasId: "canvas-model", nodeId: "model-1", status: "ok" });
    expect(ok.ok).toBe(true);
    const after = room.exportCanvas();
    if (!after.ok) return;
    expect((after.canvas.nodeData["model-1"] as CanvasNodeData).modelScriptStatus).toBe("ok");
  });
});

describe("ModelMcpService.listModelNodes（change: replace-model-mcp-board-with-canvas-subscription）", () => {
  it("从权威画布列出 model3d 节点及其参考与状态", async () => {
    const storageKey = `sha256-${"e".repeat(64)}.png`;
    const { room } = await readyRoomWithReferences("canvas-list", storageKey);
    const service = serviceFor(room);
    const outcome = await service.listModelNodes({ canvasId: "canvas-list" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.nodes).toHaveLength(1);
    const node = outcome.nodes[0]!;
    expect(node.nodeId).toBe("model-1");
    expect(node.hasScript).toBe(false);
    expect(node.pending).toBe(true);
    expect(node.references.map((reference) => reference.kind).sort()).toEqual(["image", "text"]);
  });

  it("已提交且状态 ok 的节点标记为非 pending", async () => {
    const { room } = await readyRoom("canvas-list2", {
      "model-1": {
        modelScript: VALID_SCRIPT,
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        modelScriptStatus: "ok"
      }
    });
    const service = serviceFor(room);
    const outcome = await service.listModelNodes({ canvasId: "canvas-list2" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.nodes[0]).toMatchObject({ nodeId: "model-1", hasScript: true, status: "ok", pending: false });
  });

  it("应用失败的节点仍标记为 pending", async () => {
    const { room } = await readyRoom("canvas-list3", {
      "model-1": { modelScript: VALID_SCRIPT, modelScriptStatus: "failed" }
    });
    const outcome = await serviceFor(room).listModelNodes({ canvasId: "canvas-list3" });
    expect(outcome.ok && outcome.nodes[0]!.pending).toBe(true);
  });

  it("canvasId 为空返回 malformed-request", async () => {
    const outcome = await serviceFor(null).listModelNodes({ canvasId: "" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("malformed-request");
  });
});

describe("ModelMcpService.renderPreview（change: enhance-model-scene-authoring-api）", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  /** 记录调用的假 renderer client。 */
  function fakeRenderer(result?: { ok: true; png: Buffer } | { ok: false; code: string; message: string }) {
    const calls: unknown[] = [];
    const success = { ok: true as const, png: PNG, renderVersion: "woohaa-model-render-v1" };
    const response = result ? (result.ok ? { ...result, renderVersion: "woohaa-model-render-v1" } : result) : success;
    return {
      calls,
      client: {
        available: () => true,
        close: async () => undefined,
        render: async (request: unknown) => {
          calls.push(request);
          return response;
        }
      }
    };
  }

  const V2 = `const m = scene.material({ id: "m", baseColor: "#26343a" });
scene.segment({ id: "arm", from: [0,0,0], to: [0,1,0], width: 0.3, material: m });`;

  it("从权威脚本生成 PNG 并返回防陈旧元数据", async () => {
    const { room } = await readyRoom("canvas-preview", {
      "model-1": { modelScript: V2, modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2" }
    });
    const fake = fakeRenderer();
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fake.client });
    const outcome = await service.renderPreview({ canvasId: "canvas-preview", nodeId: "model-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Buffer.from(outcome.pngBase64, "base64").subarray(0, 8)).toEqual(PNG.subarray(0, 8));
    expect(outcome.metadata).toMatchObject({
      canvasId: "canvas-preview",
      nodeId: "model-1",
      sceneVersion: "woohaa-model-scene-ir-v2",
      renderVersion: "woohaa-model-render-v1",
      width: 512,
      height: 512,
      background: "transparent",
      cameraPreset: "dimetric"
    });
    expect(outcome.metadata.sourceHash).toBeTruthy();
    // renderer 只收到规范化 Scene IR，没有 JavaScript 源码。
    expect(JSON.stringify(fake.calls[0])).not.toContain("scene.material");
  });

  it("不在 Y.Doc 写入 PNG/Scene IR（预览是可丢弃结果）", async () => {
    const { room } = await readyRoom("canvas-preview2", {
      "model-1": { modelScript: V2, modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2" }
    });
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fakeRenderer().client });
    await service.renderPreview({ canvasId: "canvas-preview2", nodeId: "model-1" });
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    const data = exported.canvas.nodeData["model-1"] as Record<string, unknown>;
    expect(data.modelScript).toBe(V2);
    expect(JSON.stringify(exported.canvas)).not.toContain("pngBase64");
    expect(exported.canvas.revision).toBe(0);
  });

  it("节点不存在 / 非模型 / 无脚本返回稳定错误", async () => {
    const { room } = await readyRoom("canvas-preview3", { "model-1": { modelScript: "" } as CanvasNodeData });
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fakeRenderer().client });
    expect(await service.renderPreview({ canvasId: "canvas-preview3", nodeId: "ghost" })).toMatchObject({ ok: false, code: "unknown-node" });
    expect(await service.renderPreview({ canvasId: "canvas-preview3", nodeId: "image-1" })).toMatchObject({ ok: false, code: "invalid-node-type" });
    expect(await service.renderPreview({ canvasId: "canvas-preview3", nodeId: "model-1" })).toMatchObject({ ok: false, code: "no-source" });
  });

  it("未配置 renderer 返回 renderer-unavailable", async () => {
    const { room } = await readyRoom("canvas-preview4", {
      "model-1": { modelScript: V2, modelScriptVersion: "woohaa-model-js-v2" }
    });
    const service = new ModelMcpService({ resolveRoom: async () => room });
    expect(await service.renderPreview({ canvasId: "canvas-preview4", nodeId: "model-1" }))
      .toMatchObject({ ok: false, code: "renderer-unavailable" });
  });

  it("支持片场：默认 initial 镜头、指定时刻并返回动画身份（任务 3.1-3.3 / D8/D10）", async () => {
    const animationData = filmSetNodeDataFields(createFilmSetSnapshot({
      title: "片场",
      model: { modelScript: "scene.box({ id: 'torso', size: [1,1,1] });", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor",
      motionScript: "motion.model.rotate('torso', { speed: 1 });",
      timeline: { duration: 4, loop: false },
      initialCamera: { azimuth: 0, elevation: 0.5, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } }
    }));
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({ canvasId: "canvas-anim-preview", repository, now: () => NOW });
    const base = createEmptyWoohaa3ServerCanvas("canvas-anim-preview", NOW);
    await room.initialize({
      canvas: {
        ...base,
        document: { ...base.document, nodes: [{ id: "anim-1", type: "composite-asset", position: { x: 0, y: 0 } }] },
        nodeData: { "anim-1": animationData as unknown as CanvasNodeData }
      },
      roomEpoch: "epoch-1",
      createdAt: NOW
    });
    const fake = fakeRenderer();
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fake.client, contentFrames: filmSetFrameRuntime });
    const outcome = await service.renderPreview({ canvasId: "canvas-anim-preview", nodeId: "anim-1", timeSeconds: 2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.metadata.cameraPreset).toBe("initial");
    expect(outcome.metadata.animation).toMatchObject({
      clipId: "clip-1",
      timeSeconds: 2,
      duration: 4,
      loop: false
    });
    expect(outcome.metadata.animation?.snapshotHash).toBeTruthy();
    expect(outcome.metadata.animation?.contentHash).toBeTruthy();

    // 越界时刻稳定拒绝。
    expect(await service.renderPreview({ canvasId: "canvas-anim-preview", nodeId: "anim-1", timeSeconds: 9 }))
      .toMatchObject({ ok: false, code: "malformed-request" });
  });

  it("片场原生预览组合内部对象并按固定 T 烘焙动作；媒体帧不可用时明确失败（任务 6.3 / D8/D10）", async () => {
    const filmSetData = filmSetNodeDataFields(createFilmSetSnapshot({
      title: "片场",
      model: { modelScript: "scene.box({ id: 'body', size: [1,1,1] });", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "obj-a",
      // 对象动作只经片段 binding（items-only）。
      motionScript: "motion.model.move('body', { speed: 1, range: [0,2] });",
      timeline: { duration: 4, loop: false },
      filmSetContent: {
        schemaVersion: 3,
        items: [
          { id: "g", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } }
        ]
      }
    }));
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({ canvasId: "canvas-film-preview", repository, now: () => NOW });
    const base = createEmptyWoohaa3ServerCanvas("canvas-film-preview", NOW);
    await room.initialize({
      canvas: {
        ...base,
        document: { ...base.document, nodes: [{ id: "film-1", type: "composite-asset", position: { x: 0, y: 0 } }] },
        nodeData: { "film-1": filmSetData as unknown as CanvasNodeData }
      },
      roomEpoch: "epoch-1",
      createdAt: NOW
    });
    const fake = fakeRenderer();
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fake.client, contentFrames: filmSetFrameRuntime });
    const outcome = await service.renderPreview({ canvasId: "canvas-film-preview", nodeId: "film-1", timeSeconds: 2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 组合 ops 含内部模型与地面（不止顶层空源码）。
    const lastRequest = fake.calls.at(-1) as { ops: unknown[]; motion?: { objects: unknown[] } };
    expect(lastRequest.ops.length).toBeGreaterThanOrEqual(2);
    expect(lastRequest.motion?.objects.length).toBeGreaterThanOrEqual(1);
    // 媒体对象（无真实帧准备）明确失败，不用占位冒充。
    const mediaData = filmSetNodeDataFields(createFilmSetSnapshot({
      title: "媒体片场",
      timeline: { duration: 0, loop: false },
      filmSetContent: {
        schemaVersion: 3,
        items: [{ id: "img", kind: "image", name: "图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "a1", aspectRatio: 1 }]
      }
    }));
    const room2 = new CanvasRoom({ canvasId: "canvas-film-media", repository: new InMemoryYjsDocumentRepository(), now: () => NOW });
    const base2 = createEmptyWoohaa3ServerCanvas("canvas-film-media", NOW);
    await room2.initialize({
      canvas: { ...base2, document: { ...base2.document, nodes: [{ id: "film-m", type: "composite-asset", position: { x: 0, y: 0 } }] }, nodeData: { "film-m": mediaData as unknown as CanvasNodeData } },
      roomEpoch: "epoch-1",
      createdAt: NOW
    });
    const service2 = new ModelMcpService({ resolveRoom: async () => room2, rendererClient: fakeRenderer().client, contentFrames: filmSetFrameRuntime });
    expect(await service2.renderPreview({ canvasId: "canvas-film-media", nodeId: "film-m", timeSeconds: 0 }))
      .toMatchObject({ ok: false, code: "native-media-unavailable" });
  });

  it("未装配内容端口时片场预览明确回落，不冒充渲染（change: 2026-10-17-decouple-film-set-from-canvas-service）", async () => {
    const data = filmSetNodeDataFields(createFilmSetSnapshot({ title: "片场", timeline: { duration: 4, loop: false } }));
    const room = new CanvasRoom({ canvasId: "canvas-no-content-runtime", repository: new InMemoryYjsDocumentRepository(), now: () => NOW });
    const base = createEmptyWoohaa3ServerCanvas("canvas-no-content-runtime", NOW);
    await room.initialize({
      canvas: {
        ...base,
        document: { ...base.document, nodes: [{ id: "film-x", type: "composite-asset", position: { x: 0, y: 0 } }] },
        nodeData: { "film-x": data as unknown as CanvasNodeData }
      },
      roomEpoch: "epoch-1",
      createdAt: NOW
    });
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fakeRenderer().client });
    expect(await service.renderPreview({ canvasId: "canvas-no-content-runtime", nodeId: "film-x", timeSeconds: 0 }))
      .toMatchObject({ ok: false, code: "content-runtime-unavailable" });
  });

  it("静态 model3d 节点非零时刻被拒绝（任务 3.1）", async () => {
    const { room } = await readyRoom("canvas-static-preview", {
      "model-1": { modelScript: V2, modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2" }
    });
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fakeRenderer().client });
    // model3d 视作静态：非零时刻拒绝。
    expect(await service.renderPreview({ canvasId: "canvas-static-preview", nodeId: "model-1", timeSeconds: 1 }))
      .toMatchObject({ ok: false, code: "malformed-request" });
  });

  it("renderer 失败时透传稳定错误码", async () => {
    const { room } = await readyRoom("canvas-preview5", {
      "model-1": { modelScript: V2, modelScriptVersion: "woohaa-model-js-v2" }
    });
    const service = new ModelMcpService({
      resolveRoom: async () => room,
      rendererClient: fakeRenderer({ ok: false, code: "render-timeout", message: "超时" }).client
    });
    expect(await service.renderPreview({ canvasId: "canvas-preview5", nodeId: "model-1" }))
      .toMatchObject({ ok: false, code: "render-timeout" });
  });

  it("重复预览命中缓存（同一 source/scene/render/capture）", async () => {
    const { room } = await readyRoom("canvas-preview6", {
      "model-1": { modelScript: V2, modelScriptVersion: "woohaa-model-js-v2" }
    });
    const fake = fakeRenderer();
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fake.client });
    const first = await service.renderPreview({ canvasId: "canvas-preview6", nodeId: "model-1" });
    const second = await service.renderPreview({ canvasId: "canvas-preview6", nodeId: "model-1" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("脚本执行失败不调用 renderer", async () => {
    const { room } = await readyRoom("canvas-preview7", {
      "model-1": { modelScript: "scene.box({ id: 'x', color: 'not-a-color' });", modelScriptVersion: "woohaa-model-js-v2" }
    });
    const fake = fakeRenderer();
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fake.client });
    const outcome = await service.renderPreview({ canvasId: "canvas-preview7", nodeId: "model-1" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code.startsWith("model-script-")).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  // ---- 任务 4.4：缓存命中与渲染完成后比较完整权威身份 ----

  /**
   * 在 renderer 渲染期间并发修改权威节点，验证返回前重新检查身份并拒绝陈旧结果（D6）。
   * `mutate` 收到当前动画定义，返回写回后的 nodeData。
   */
  async function previewWithConcurrentMutation(
    canvasId: string,
    mutate: (base: Record<string, unknown>) => Record<string, unknown>
  ): Promise<{ outcome: Awaited<ReturnType<ModelMcpService["renderPreview"]>>; fake: ReturnType<typeof fakeRenderer> }> {
    const base = filmSetNodeDataFields(createFilmSetSnapshot({
      title: "片场",
      model: { modelScript: "scene.box({ id: 'torso', size: [1, 1, 1] });", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor",
      motionScript: "motion.model.rotate('torso', { speed: 1 });",
      timeline: { duration: 4, loop: false },
      initialCamera: { azimuth: 0, elevation: 0.5, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } }
    }));
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({ canvasId, repository, now: () => NOW });
    const empty = createEmptyWoohaa3ServerCanvas(canvasId, NOW);
    await room.initialize({
      canvas: {
        ...empty,
        document: { ...empty.document, nodes: [{ id: "anim-1", type: "composite-asset", position: { x: 0, y: 0 } }] },
        nodeData: { "anim-1": base as unknown as CanvasNodeData }
      },
      roomEpoch: "epoch-1",
      createdAt: NOW
    });
    const calls: unknown[] = [];
    const client = {
      available: () => true,
      close: async () => undefined,
      render: async (request: unknown) => {
        calls.push(request);
        // 渲染期间并发修改权威节点。
        await room.submit({
          protocolVersion: 1,
          canvasId,
          commandId: `concurrent-${calls.length}`,
          baseRevision: room.currentRevision,
          actorId: "concurrent-test",
          commands: [{ type: "nodeData.patch", nodeId: "anim-1", value: mutate(structuredClone(base)) as never }]
        } as never);
        return { ok: true as const, png: PNG, renderVersion: "woohaa-model-render-v1" };
      }
    };
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: client, contentFrames: filmSetFrameRuntime });
    const outcome = await service.renderPreview({ canvasId, nodeId: "anim-1", timeSeconds: 2 });
    return { outcome, fake: { calls, client } };
  }

  it("motion-only 并发修改 → stale-source", async () => {
    const { outcome } = await previewWithConcurrentMutation("canvas-stale-motion", (base) => {
      const animations = structuredClone(base.filmSetAnimations) as { clips: Array<{ bindings: Array<{ motion?: { sourceHash: string } }> }> };
      animations.clips[0]!.bindings[0]!.motion!.sourceHash = "m2";
      return { ...base, filmSetAnimations: animations };
    });
    expect(outcome).toMatchObject({ ok: false, code: "stale-source" });
  });

  it("camera-only 并发修改 → stale-source", async () => {
    const { outcome } = await previewWithConcurrentMutation("canvas-stale-camera", (base) => {
      const animations = structuredClone(base.filmSetAnimations) as { clips: Array<{ initialCamera: { azimuth: number } }> };
      animations.clips[0]!.initialCamera.azimuth = 1;
      return { ...base, filmSetAnimations: animations };
    });
    expect(outcome).toMatchObject({ ok: false, code: "stale-source" });
  });

  it("placement-only 并发修改 → stale-source", async () => {
    const { outcome } = await previewWithConcurrentMutation("canvas-stale-placement", (base) => {
      const content = structuredClone(base.filmSetContent) as { items: Array<{ kind: string; model?: { placement: { offset: { x: number } } } }> };
      const model = content.items.find(item => item.kind === "model")!;
      model.model!.placement.offset.x = 1;
      return { ...base, filmSetContent: content };
    });
    expect(outcome).toMatchObject({ ok: false, code: "stale-source" });
  });

  it("timeline-only 并发修改 → stale-source", async () => {
    const { outcome } = await previewWithConcurrentMutation("canvas-stale-timeline", (base) => {
      const animations = structuredClone(base.filmSetAnimations) as { clips: Array<{ timeline: { duration: number; loop: boolean } }> };
      animations.clips[0]!.timeline = { duration: 8, loop: true };
      return { ...base, filmSetAnimations: animations };
    });
    expect(outcome).toMatchObject({ ok: false, code: "stale-source" });
  });

  it("节点删除 → stale-source", async () => {
    const { outcome } = await previewWithConcurrentMutation("canvas-stale-delete", () => null as unknown as Record<string, unknown>);
    expect(outcome).toMatchObject({ ok: false, code: "stale-source" });
  });

  it("无并发修改时缓存命中，且命中不重复调用 renderer", async () => {
    const { room } = await readyRoom("canvas-stale-clean", {
      "model-1": { modelScript: V2, modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2" }
    });
    const fake = fakeRenderer();
    const service = new ModelMcpService({ resolveRoom: async () => room, rendererClient: fake.client });
    const first = await service.renderPreview({ canvasId: "canvas-stale-clean", nodeId: "model-1" });
    const second = await service.renderPreview({ canvasId: "canvas-stale-clean", nodeId: "model-1" });
    expect(first.ok && second.ok && second.cached).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("ModelMcpService 读取镜头（change: add-model-camera-mcp-crud）", () => {
  const CAMERAS = [
    { id: "cam-a", name: "正面", order: 0, azimuth: 0, elevation: 0, distance: 3, aspect: "16:9" as const },
    { id: "cam-b", name: "右侧", order: 1, azimuth: 1.5, elevation: 0, distance: 5, aspect: "1:1" as const, focusOffset: { x: 1, y: 0, z: 0 } }
  ];

  it("getModelNode 按稳定顺序返回规范化镜头，且读取不推进 revision", async () => {
    const { room } = await readyRoom("canvas-cam-read", { "model-1": { modelCameras: CAMERAS } as CanvasNodeData });
    const before = room.currentRevision;
    const outcome = await serviceFor(room).getModelNode({ canvasId: "canvas-cam-read", nodeId: "model-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cameras.map((camera) => camera.id)).toEqual(["cam-a", "cam-b"]);
    expect(outcome.cameras[1]!.focusOffset).toEqual({ x: 1, y: 0, z: 0 });
    expect(room.currentRevision).toBe(before);
  });

  it("无镜头或非法镜头时返回空集合", async () => {
    const empty = await readyRoom("canvas-cam-empty");
    const emptyOutcome = await serviceFor(empty.room).getModelNode({ canvasId: "canvas-cam-empty", nodeId: "model-1" });
    expect(emptyOutcome.ok && emptyOutcome.cameras).toEqual([]);

    const bad = await readyRoom("canvas-cam-bad", { "model-1": { modelCameras: [{ id: "x" }] } as CanvasNodeData });
    const badOutcome = await serviceFor(bad.room).getModelNode({ canvasId: "canvas-cam-bad", nodeId: "model-1" });
    expect(badOutcome.ok && badOutcome.cameras).toEqual([]);
  });

  it("listModelNodes 暴露镜头数量", async () => {
    const { room } = await readyRoom("canvas-cam-count", { "model-1": { modelCameras: CAMERAS } as CanvasNodeData });
    const outcome = await serviceFor(room).listModelNodes({ canvasId: "canvas-cam-count" });
    expect(outcome.ok && outcome.nodes[0]!.cameraCount).toBe(2);
  });
});

describe("ModelMcpService.mutateCameras（change: add-model-camera-mcp-crud）", () => {
  function camerasOf(room: CanvasRoom): Array<{ id: string; name: string; order: number; distance: number; aspect: string }> {
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export failed");
    const data = exported.canvas.nodeData["model-1"] as CanvasNodeData | undefined;
    return (data?.modelCameras ?? []) as never;
  }

  it("create 派生稳定 id/默认名称/连续 order，并保留 aspect/focusOffset", async () => {
    const { room } = await readyRoom("canvas-cam-create", {
      "model-1": {
        modelCameras: [{ id: "cam-a", name: "正面", order: 0, azimuth: 0, elevation: 0, distance: 3, aspect: "16:9" }]
      } as CanvasNodeData
    });
    const outcome = await serviceFor(room).mutateCameras({
      canvasId: "canvas-cam-create",
      nodeId: "model-1",
      requestId: "r1",
      mutation: { kind: "create", azimuth: 1, distance: 4, aspect: "4:5", focusOffset: { x: 0, y: 1, z: 0 } }
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cameras).toHaveLength(2);
    const created = outcome.cameras[1]!;
    expect(created.name).toBe("镜头 2");
    expect(created.order).toBe(1);
    expect(created.aspect).toBe("4:5");
    expect(created.focusOffset).toEqual({ x: 0, y: 1, z: 0 });
    expect(created.id.startsWith("cam-")).toBe(true);
    expect(camerasOf(room)).toHaveLength(2);
  });

  it("update 只改匹配镜头并保留其它字段与镜头", async () => {
    const { room } = await readyRoom("canvas-cam-update", {
      "model-1": {
        modelCameras: [
          { id: "cam-a", name: "正面", order: 0, azimuth: 0, elevation: 0, distance: 3, aspect: "16:9" },
          { id: "cam-b", name: "右侧", order: 1, azimuth: 1.5, elevation: 0, distance: 5, aspect: "1:1" }
        ]
      } as CanvasNodeData
    });
    const outcome = await serviceFor(room).mutateCameras({
      canvasId: "canvas-cam-update",
      nodeId: "model-1",
      requestId: "r1",
      mutation: { kind: "update", id: "cam-b", distance: 8 }
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const updated = outcome.cameras.find((camera) => camera.id === "cam-b")!;
    expect(updated.distance).toBe(8);
    expect(updated.azimuth).toBe(1.5);
    expect(updated.aspect).toBe("1:1");
    expect(outcome.cameras.find((camera) => camera.id === "cam-a")!.distance).toBe(3);
  });

  it("remove/rename/reset 单条镜头", async () => {
    const { room } = await readyRoom("canvas-cam-ops", {
      "model-1": {
        modelCameras: [
          { id: "cam-a", name: "正面", order: 0, azimuth: 0.2, elevation: 0, distance: 3, aspect: "16:9", focusOffset: { x: 9, y: 9, z: 9 } }
        ]
      } as CanvasNodeData
    });
    const service = serviceFor(room);
    const renamed = await service.mutateCameras({
      canvasId: "canvas-cam-ops", nodeId: "model-1", requestId: "rn", mutation: { kind: "rename", id: "cam-a", name: "主视角" }
    });
    expect(renamed.ok && renamed.cameras[0]!.name).toBe("主视角");

    const reset = await service.mutateCameras({
      canvasId: "canvas-cam-ops", nodeId: "model-1", requestId: "rr", mutation: { kind: "reset", id: "cam-a", azimuth: 0, distance: 2 }
    });
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.cameras[0]!.azimuth).toBe(0);
    expect(reset.cameras[0]!.distance).toBe(2);
    expect(reset.cameras[0]!.focusOffset).toBeUndefined();

    const removed = await service.mutateCameras({
      canvasId: "canvas-cam-ops", nodeId: "model-1", requestId: "rm", mutation: { kind: "remove", id: "cam-a" }
    });
    expect(removed.ok && removed.cameras).toEqual([]);
  });

  it("未知 id 与非法数值在写入前稳定拒绝", async () => {
    const { room } = await readyRoom("canvas-cam-reject", {
      "model-1": { modelCameras: [{ id: "cam-a", name: "正面", order: 0, azimuth: 0, elevation: 0, distance: 3, aspect: "16:9" }] } as CanvasNodeData
    });
    const service = serviceFor(room);
    const unknown = await service.mutateCameras({
      canvasId: "canvas-cam-reject", nodeId: "model-1", requestId: "r1", mutation: { kind: "update", id: "nope", distance: 1 }
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("unknown-camera");

    const bad = await service.mutateCameras({
      canvasId: "canvas-cam-reject", nodeId: "model-1", requestId: "r2", mutation: { kind: "update", id: "cam-a", distance: -1 }
    });
    expect(bad.ok).toBe(false);
    expect(camerasOf(room)).toHaveLength(1);
  });

  it("相同 requestId 重试幂等，且并发单条写入不互相覆盖", async () => {
    const { room } = await readyRoom("canvas-cam-idem", {
      "model-1": { modelCameras: [] } as CanvasNodeData
    });
    const service = serviceFor(room);
    // 同一 requestId 重试：第二次返回 duplicate，不新增镜头。
    const first = await service.mutateCameras({
      canvasId: "canvas-cam-idem", nodeId: "model-1", requestId: "same", mutation: { kind: "create", azimuth: 0, distance: 3 }
    });
    const retry = await service.mutateCameras({
      canvasId: "canvas-cam-idem", nodeId: "model-1", requestId: "same", mutation: { kind: "create", azimuth: 0, distance: 3 }
    });
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.duplicate).toBe(true);
      expect(retry.cameras).toHaveLength(1);
    }

    // 不同 requestId 并发：基于权威集合读改写，两个镜头都保留。
    await Promise.all([
      service.mutateCameras({ canvasId: "canvas-cam-idem", nodeId: "model-1", requestId: "c2", mutation: { kind: "create", azimuth: 1, distance: 4 } }),
      service.mutateCameras({ canvasId: "canvas-cam-idem", nodeId: "model-1", requestId: "c3", mutation: { kind: "create", azimuth: 2, distance: 5 } })
    ]);
    expect(camerasOf(room)).toHaveLength(3);
  });

  it("非模型节点返回 invalid-node-type", async () => {
    const { room } = await readyRoom("canvas-cam-type");
    const outcome = await serviceFor(room).mutateCameras({
      canvasId: "canvas-cam-type", nodeId: "image-1", requestId: "r", mutation: { kind: "create", azimuth: 0, distance: 1 }
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("invalid-node-type");
  });
});

describe("ModelMcpService.mutateCamerasBatch（change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 4.4）", () => {
  function camerasOf(room: CanvasRoom): Array<{ id: string; distance: number }> {
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export failed");
    const data = exported.canvas.nodeData["model-1"] as CanvasNodeData | undefined;
    return (data?.modelCameras ?? []) as never;
  }

  it("整批原子提交受约束变更", async () => {
    const { room } = await readyRoom("canvas-cam-batch", {
      "model-1": {
        modelCameras: [
          { id: "cam-a", name: "正面", order: 0, azimuth: 0, elevation: 0, distance: 3, aspect: "16:9" },
          { id: "cam-b", name: "右侧", order: 1, azimuth: 1, elevation: 0, distance: 4, aspect: "16:9" }
        ]
      } as CanvasNodeData
    });
    const outcome = await serviceFor(room).mutateCamerasBatch({
      canvasId: "canvas-cam-batch",
      nodeId: "model-1",
      requestId: "b1",
      mutations: [
        { kind: "update", id: "cam-a", distance: 9 },
        { kind: "remove", id: "cam-b" }
      ]
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cameras).toHaveLength(1);
    expect(outcome.cameras[0]!.distance).toBe(9);
    expect(camerasOf(room)).toHaveLength(1);
  });

  it("批量含非法条目不部分写入", async () => {
    const { room } = await readyRoom("canvas-cam-batch-bad", {
      "model-1": { modelCameras: [{ id: "cam-a", name: "正面", order: 0, azimuth: 0, elevation: 0, distance: 3, aspect: "16:9" }] } as CanvasNodeData
    });
    const outcome = await serviceFor(room).mutateCamerasBatch({
      canvasId: "canvas-cam-batch-bad",
      nodeId: "model-1",
      requestId: "b2",
      mutations: [
        { kind: "update", id: "cam-a", distance: 12 },
        { kind: "remove", id: "missing" }
      ]
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unknown-camera");
    // 合法部分不得写入。
    expect(camerasOf(room)[0]!.distance).toBe(3);
  });

  it("相同 requestId 重试幂等", async () => {
    const { room } = await readyRoom("canvas-cam-batch-idem", { "model-1": { modelCameras: [] } as CanvasNodeData });
    const service = serviceFor(room);
    const first = await service.mutateCamerasBatch({
      canvasId: "canvas-cam-batch-idem", nodeId: "model-1", requestId: "same",
      mutations: [{ kind: "create", azimuth: 0, distance: 5 }]
    });
    const retry = await service.mutateCamerasBatch({
      canvasId: "canvas-cam-batch-idem", nodeId: "model-1", requestId: "same",
      mutations: [{ kind: "create", azimuth: 0, distance: 5 }]
    });
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.duplicate).toBe(true);
      expect(camerasOf(room)).toHaveLength(1);
    }
  });
});

describe("模型规模统计（change: 2026-10-18-align-model-statistics-with-agent）", () => {
  /** 与聚焦面板同一口径：segment 缺省是 capsule（400 点 / 288 面）。 */
  const SEGMENT_SCRIPT =
    "scene.box({ id: 'body', size: [1, 2, 1] });" +
    "scene.segment({ id: 'limb', from: [0, 0, 0], to: [0, 1, 0], width: 0.2 });";

  it("submitScript 成功回执带与面板同源的统计，并按 segment 实际 shape 计数", async () => {
    const { room } = await readyRoom("canvas-stats-submit");
    const outcome = await serviceFor(room).submitScript({
      canvasId: "canvas-stats-submit",
      nodeId: "model-1",
      source: SEGMENT_SCRIPT,
      requestId: "req-stats-1"
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // box 8 点/12 面 + 缺省 capsule segment 400 点/288 面。
    expect(outcome.statistics).toEqual({ objects: 2, groups: 0, vertices: 408, triangles: 300, materials: 0, animations: 0 });
    expect(outcome.breakdown?.capsule).toEqual({ count: 1, vertices: 400, triangles: 288 });
    expect(outcome.breakdown?.box).toEqual({ count: 1, vertices: 8, triangles: 12 });
  });

  it("getModelNode 默认不执行脚本；includeStatistics=true 才附带统计", async () => {
    const { room } = await readyRoom("canvas-stats-read", {
      "model-1": { modelScript: SEGMENT_SCRIPT } as CanvasNodeData
    });
    const service = serviceFor(room);
    const plain = await service.getModelNode({ canvasId: "canvas-stats-read", nodeId: "model-1" });
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.statistics).toBeUndefined();
    const withStats = await service.getModelNode({ canvasId: "canvas-stats-read", nodeId: "model-1", includeStatistics: true });
    expect(withStats.ok).toBe(true);
    if (!withStats.ok) return;
    expect(withStats.statistics?.vertices).toBe(408);
    expect(withStats.breakdown?.capsule.count).toBe(1);
  });

  it("getModelStatistics 统计当前脚本或候选脚本，且候选不写画布", async () => {
    const { room } = await readyRoom("canvas-stats-tool", {
      "model-1": { modelScript: SEGMENT_SCRIPT } as CanvasNodeData
    });
    const service = serviceFor(room);
    const current = await service.getModelStatistics({ canvasId: "canvas-stats-tool", nodeId: "model-1" });
    expect(current).toMatchObject({ ok: true, source: "current" });
    if (!current.ok) return;
    expect(current.statistics.vertices).toBe(408);

    const candidate = await service.getModelStatistics({
      canvasId: "canvas-stats-tool",
      nodeId: "model-1",
      source: "scene.box({ id: 'body', size: [1, 2, 1] });"
    });
    expect(candidate).toMatchObject({ ok: true, source: "candidate" });
    if (!candidate.ok) return;
    expect(candidate.statistics).toEqual({ objects: 1, groups: 0, vertices: 8, triangles: 12, materials: 0, animations: 0 });
    // 候选只读：权威脚本与 revision 均未变。
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect((exported.canvas.nodeData["model-1"] as CanvasNodeData | undefined)?.modelScript).toBe(SEGMENT_SCRIPT);
  });

  it("非法候选与无脚本节点返回稳定错误，不冒充 0", async () => {
    const { room } = await readyRoom("canvas-stats-errors", {
      "model-1": { modelScript: "scene.box({ id: 'x' });" } as CanvasNodeData
    });
    const service = serviceFor(room);
    // 无脚本模型：脚本按规范是空字符串，统计必须返回稳定原因而不是 0。
    const added = await service.applyCommands({
      canvasId: "canvas-stats-errors",
      commandId: "add-empty-model",
      baseRevision: 0,
      commands: [{ type: "node.add", node: { id: "model-2", type: "model3d", position: { x: 0, y: 0 } } }]
    });
    expect(added.ok).toBe(true);
    const invalid = await service.getModelStatistics({
      canvasId: "canvas-stats-errors",
      nodeId: "model-1",
      source: "scene.box(this is not valid js"
    });
    expect(invalid).toMatchObject({ ok: false });
    if (!invalid.ok) expect(`${invalid.code}:${invalid.message}`).toContain("model-script-");
    const empty = await service.getModelStatistics({ canvasId: "canvas-stats-errors", nodeId: "model-2" });
    expect(empty).toMatchObject({ ok: false, code: "no-model-script" });
    const image = await service.getModelStatistics({ canvasId: "canvas-stats-errors", nodeId: "image-1" });
    expect(image).toMatchObject({ ok: false, code: "invalid-node-type" });
  });
});
