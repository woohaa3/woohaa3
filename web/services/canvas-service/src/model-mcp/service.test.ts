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
import { createEmptyWoohaa3ServerCanvas, modelSourceHash, type CanvasNodeData } from "@woohaa3/contracts";
import { InMemoryYjsDocumentRepository } from "../sync/index.js";
import { CanvasRoom } from "../sync/room.js";
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
  await initializeFixture(room, {
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
  await initializeFixture(room, { canvas, roomEpoch: "epoch-1", createdAt: NOW });
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
    await initializeFixture(room, {
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
      background: "transparent"
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

function initializeFixture(room: CanvasRoom, input: Parameters<CanvasRoom["initialize"]>[0]) {
  return room.initialize(input);
}
