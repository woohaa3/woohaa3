/**
 * 单节点快捷「转为片场」转换服务测试
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.1–1.4）。
 *
 * 覆盖：3D 权威复制（无 LLM）、持久镜头映射、requestId 幂等/不同输入拒绝、双击并发、
 * 响应丢失后恢复、服务重启后 unknown 与 3D 恢复、取消与提交边界、源删除/提交竞态、
 * 候选校验失败不遗留空片场。均为非渲染检查。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createFilmSetSnapshot,
  decodeFilmSetNodeData,
  filmSetConversionInputHash,
  readFilmSetConversionNodeStatus,
  type CanvasNodeData,
  type FilmSetConversionAdapterCapabilities,
  type FilmSetConversionRepair,
  type FilmSetConversionRequest,
  type StoredAsset
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { InMemoryYjsDocumentRepository } from "../../../services/canvas-service/src/sync/index.js";
import { CanvasRoom } from "../../../services/canvas-service/src/sync/room.js";
import {
  FilmSetConversionService,
  InMemoryFilmSetConversionRegistry,
  type FilmSetConversionGenerator
} from "../src/backend.js";

const NOW = "2026-10-13T00:00:00.000Z";
const SCRIPT = "scene.box({ id: 'torso', size: [1, 2, 0.5] });";

type TestNode = { id: string; type: string; data?: CanvasNodeData };

async function readyRoom(
  canvasId: string,
  nodes: TestNode[] = [],
  assets: StoredAsset[] = []
): Promise<CanvasRoom> {
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
        if (node.data) acc[node.id] = node.data;
        return acc;
      }, {}),
      assets
    },
    roomEpoch: "epoch-1",
    createdAt: NOW
  });
  return room;
}

/** 稳定的 ready 图片资产（与 img-src 的 outputAssetId 一致）。 */
function readyImageAsset(id = "asset-1"): StoredAsset {
  return {
    id,
    title: "图片",
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: NOW,
    metadata: {
      checksum: "checksum-1",
      width: 1920,
      height: 1080,
      storageKey: `sha256-${"a".repeat(64)}`,
      contentType: "image/png"
    }
  };
}

/** 稳定的 ready 视频资产（带时长，供范围预算校验）。 */
function readyVideoAsset(id = "asset-1"): StoredAsset {
  return {
    id,
    title: "视频",
    mediaKind: "video",
    source: "uploaded",
    status: "ready",
    createdAt: NOW,
    durationSeconds: 12,
    metadata: {
      checksum: "checksum-video",
      width: 1920,
      height: 1080,
      durationSeconds: 12,
      storageKey: `sha256-${"b".repeat(64)}`,
      contentType: "video/mp4"
    }
  };
}

function model3dData(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    kind: "model3d",
    title: "模型",
    modelScript: SCRIPT,
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    modelContentVersion: { revision: 1, sourceHash: "src-from-model", contentHash: "content-from-model" },
    modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    ...overrides
  } as CanvasNodeData;
}

function serviceFor(
  room: CanvasRoom | null,
  options: {
    registry?: InMemoryFilmSetConversionRegistry;
    generator?: FilmSetConversionGenerator;
    capabilities?: FilmSetConversionAdapterCapabilities | undefined;
    resolveModelCapabilities?: boolean;
    submitBudgetMs?: number;
    generationTimeoutMs?: number;
  } = {}
): FilmSetConversionService {
  return new FilmSetConversionService({
    resolveRoom: async () => room,
    registry: options.registry ?? new InMemoryFilmSetConversionRegistry(),
    submitBudgetMs: 15_000,
    ...(options.generator ? { generator: options.generator } : {}),
    ...(options.resolveModelCapabilities
      ? {
          resolveModelCapabilities: async () => ({
            modelKey: "chatgpt:conversion",
            capabilities: options.capabilities
          })
        }
      : {}),
    ...(options.submitBudgetMs !== undefined ? { submitBudgetMs: options.submitBudgetMs } : {}),
    ...(options.generationTimeoutMs !== undefined ? { generationTimeoutMs: options.generationTimeoutMs } : {}),
    now: () => NOW
  });
}

function request(canvasId: string, overrides: Partial<FilmSetConversionRequest> = {}): FilmSetConversionRequest {
  return {
    canvasId,
    requestId: "req-1",
    sourceNodeId: "model-src",
    targetNodeId: "film-target",
    sourceKind: "model3d",
    ...overrides
  };
}

function filmSetNode(room: CanvasRoom, nodeId: string) {
  const exported = room.exportCanvas();
  if (!exported.ok) throw new Error("export failed");
  const node = exported.canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  return { node, data: exported.canvas.nodeData[nodeId] as CanvasNodeData | undefined, canvas: exported.canvas };
}

/** 构造一个合法的片场候选（含重建画面的 model 对象；无 LLM 参与，用于媒体端口测试）。 */
function validCandidate(title: string) {
  const snapshot = createFilmSetSnapshot({
    title,
    timeline: { duration: 0, loop: false },
    model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" }
  });
  return {
    filmSetContent: snapshot.filmSetContent,
    filmSetAnimations: snapshot.filmSetAnimations,
    sceneCamera: snapshot.sceneCamera
  };
}

describe("FilmSetConversionService：3D 直接复制（任务 1.4 / D3）", () => {
  it("复制为自包含片场，保留 model item 与内部 part ID，且不调用任何生成端口", async () => {
    const room = await readyRoom("c-3d", [{ id: "model-src", type: "model3d", data: model3dData() }]);
    let generatorCalls = 0;
    const service = serviceFor(room, {
      generator: async () => { generatorCalls += 1; return { ok: false, code: "generation-failed", message: "should not run" }; }
    });
    const outcome = await service.submit(request("c-3d"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status.status).toBe("completed");
    expect(generatorCalls).toBe(0);

    const target = filmSetNode(room, "film-target");
    expect(target).not.toBeNull();
    expect(target!.node.type).toBe("composite-asset");
    const decoded = decodeFilmSetNodeData(target!.data);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const item = decoded.value.filmSetContent.items.find((entry) => entry.kind === "model");
    expect(item).toBeTruthy();
    if (item?.kind !== "model") throw new Error("expected model item");
    expect(item.model.modelScript).toBe(SCRIPT);
    expect(item.model.placement).toEqual({ offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 });
    // 源节点保留。
    expect(filmSetNode(room, "model-src")!.node.type).toBe("model3d");
    // 来源 metadata 记录请求身份。
    expect(decoded.value.origin?.conversion?.requestId).toBe("req-1");
    expect(decoded.value.origin?.conversion?.sourceKind).toBe("model3d");
  });

  it("持久镜头映射为片场片段镜头；无法映射的附加镜头在来源记录说明", async () => {
    const room = await readyRoom("c-3d-cam", [{
      id: "model-src",
      type: "model3d",
      data: model3dData({
        modelCameras: [
          { id: "cam-a", name: "镜头 A", order: 0, azimuth: 0.1, elevation: 0.2, distance: 5, aspect: "16:9" },
          { id: "cam-b", name: "镜头 B", order: 1, azimuth: 0.3, elevation: 0.4, distance: 6, aspect: "16:9" }
        ]
      } as Partial<CanvasNodeData>)
    }]);
    const outcome = await serviceFor(room).submit(request("c-3d-cam"));
    expect(outcome.ok).toBe(true);
    const target = filmSetNode(room, "film-target")!;
    const decoded = decodeFilmSetNodeData(target.data);
    if (!decoded.ok) throw new Error(decoded.reason);
    const clips = decoded.value.filmSetAnimations?.clips ?? [];
    expect(clips.length).toBe(2);
    expect(clips.map((clip) => clip.name)).toEqual(["镜头 A", "镜头 B"]);
    // sceneCamera 使用首个镜头。
    expect(decoded.value.sceneCamera.azimuth).toBeCloseTo(0.1, 6);
    expect(decoded.value.origin?.conversion?.unmappedCameras).toBeUndefined();
  });

  it("复制后编辑/删除源模型不影响目标；目标编辑不回写源", async () => {
    const room = await readyRoom("c-3d-indep", [{ id: "model-src", type: "model3d", data: model3dData() }]);
    await serviceFor(room).submit(request("c-3d-indep"));
    const before = filmSetNode(room, "film-target")!;
    const beforeDecoded = decodeFilmSetNodeData(before.data);
    if (!beforeDecoded.ok) throw new Error(beforeDecoded.reason);

    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    const removed = await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: "c-3d-indep",
      actorId: "test",
      commandId: "delete-src",
      baseRevision: exported.canvas.revision,
      commands: [{ type: "node.remove", nodeIds: ["model-src"] }]
    } as never);
    expect(removed.ok).toBe(true);
    const after = filmSetNode(room, "film-target")!;
    const afterDecoded = decodeFilmSetNodeData(after.data);
    if (!afterDecoded.ok) throw new Error(afterDecoded.reason);
    expect(afterDecoded.value.filmSetContent).toEqual(beforeDecoded.value.filmSetContent);
  });
});

describe("FilmSetConversionService：幂等与恢复（任务 1.2 / D5）", () => {
  it("相同 requestId 相同输入返回 duplicate 且只创建一个结果", async () => {
    const room = await readyRoom("c-idem", [{ id: "model-src", type: "model3d", data: model3dData() }]);
    const registry = new InMemoryFilmSetConversionRegistry();
    const service = serviceFor(room, { registry });
    const first = await service.submit(request("c-idem"));
    const second = await service.submit(request("c-idem"));
    expect(first.ok && first.receipt.duplicate).toBe(false);
    expect(second.ok && second.receipt.duplicate).toBe(true);
    expect(second.ok && second.receipt.targetNodeId).toBe("film-target");
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.document.nodes.filter((node) => node.id === "film-target")).toHaveLength(1);
  });

  it("同一 requestId 不同输入被拒绝（request-id-reused）", async () => {
    const room = await readyRoom("c-reuse", [{ id: "model-src", type: "model3d", data: model3dData() }]);
    const service = serviceFor(room);
    await service.submit(request("c-reuse", { settings: { instruction: "a" } }));
    const reused = await service.submit(request("c-reuse", { settings: { instruction: "b" } }));
    expect(!reused.ok && reused.code).toBe("request-id-reused");
  });

  it("双击并发只产生一条记录与一个结果", async () => {
    const room = await readyRoom("c-double", [{ id: "model-src", type: "model3d", data: model3dData() }]);
    const registry = new InMemoryFilmSetConversionRegistry();
    const service = serviceFor(room, { registry });
    const [a, b] = await Promise.all([
      service.submit(request("c-double")),
      service.submit(request("c-double"))
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(registry.size()).toBe(1);
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.document.nodes.filter((node) => node.id === "film-target")).toHaveLength(1);
  });

  it("服务重启后 running 记录状态为 unknown，3D 重提交可幂等恢复", async () => {
    const room = await readyRoom("c-restart", [{ id: "model-src", type: "model3d", data: model3dData() }]);
    const registry = new InMemoryFilmSetConversionRegistry();
    const input = request("c-restart");
    // 模拟重启：registry 中留下一条 running 记录（无本地进行中任务）。
    await registry.put({
      canvasId: "c-restart",
      requestId: input.requestId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      sourceKind: "model3d",
      inputHash: filmSetConversionInputHash(input),
      frozenSource: { nodeId: input.sourceNodeId, kind: "model3d", contentHash: "src-from-model" },
      title: "模型",
      settings: {},
      step: "prepare-source",
      state: "running",
      attempt: 1,
      createdAt: NOW,
      updatedAt: NOW
    });
    const restarted = serviceFor(room, { registry });
    const status = await restarted.status({ canvasId: "c-restart", requestId: input.requestId });
    expect(status.ok && status.status?.status).toBe("unknown");
    // 重提交（同输入）恢复：3D 幂等完成。
    const resumed = await restarted.submit(input);
    expect(resumed.ok && resumed.status.status).toBe("completed");
    expect(filmSetNode(room, "film-target")).not.toBeNull();
  });
});

describe("FilmSetConversionService：取消与竞态（任务 1.3 / D4/D5）", () => {
  it("媒体转换未提交时取消返回 cancelled 并保留占位片场节点为已取消（不新增第二个节点）", async () => {
    const room = await readyRoom("c-cancel", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const generator: FilmSetConversionGenerator = async (input) => {
      entered!();
      await gate;
      return { ok: true, candidate: validCandidate(input.title) };
    };
    const service = serviceFor(room, { generator });
    const pending = service.submit(request("c-cancel", {
      sourceNodeId: "img-src", targetNodeId: "film-cancel", sourceKind: "image"
    }));
    // 等待生成器开始：占位片场节点已在提交时创建（design D4）。
    await started;
    // 并在其上显示进行中阶段。
    const placeholder = filmSetNode(room, "film-cancel");
    expect(placeholder).not.toBeNull();
    expect(readFilmSetConversionNodeStatus(placeholder!.data)?.status).toBe("running");
    const cancelled = await service.cancel({ canvasId: "c-cancel", requestId: "req-1" });
    expect(cancelled.ok && cancelled.status.status).toBe("cancelled");
    release!();
    const settled = await pending;
    expect(settled.ok && settled.status.status).toBe("cancelled");
    // 占位节点保留（design D4 表格：取消 → 已取消转换），且只有一个目标节点。
    const after = filmSetNode(room, "film-cancel");
    expect(after).not.toBeNull();
    expect(readFilmSetConversionNodeStatus(after!.data)?.status).toBe("cancelled");
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.document.nodes.filter((node) => node.id === "film-cancel")).toHaveLength(1);
  });

  it("提交事务先于取消完成：取消返回实际已创建结果，不显示已取消", async () => {
    const room = await readyRoom("c-cancel-after", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const generator: FilmSetConversionGenerator = async (input) => ({ ok: true, candidate: validCandidate(input.title) });
    const service = serviceFor(room, { generator });
    const submitted = await service.submit(request("c-cancel-after", {
      sourceNodeId: "img-src", targetNodeId: "film-done", sourceKind: "image"
    }));
    expect(submitted.ok && submitted.status.status).toBe("completed");
    const cancelled = await service.cancel({ canvasId: "c-cancel-after", requestId: "req-1" });
    expect(cancelled.ok && cancelled.status.status).toBe("completed");
    expect(filmSetNode(room, "film-done")).not.toBeNull();
  });

  it("源节点在生成期间删除：提交被拒绝且移除占位片场节点（不保留）", async () => {
    const room = await readyRoom("c-race", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const generator: FilmSetConversionGenerator = async (input) => {
      // 生成期间删除来源节点（模拟竞态）。
      const exported = room.exportCanvas();
      if (!exported.ok) throw new Error("export");
      await room.submit({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId: "c-race",
        actorId: "test",
        commandId: "delete-during-gen",
        baseRevision: exported.canvas.revision,
        commands: [{ type: "node.remove", nodeIds: ["img-src"] }]
      } as never);
      return { ok: true, candidate: validCandidate(input.title) };
    };
    const service = serviceFor(room, { generator });
    const outcome = await service.submit(request("c-race", {
      sourceNodeId: "img-src", targetNodeId: "film-race", sourceKind: "image"
    }));
    // 提交边界复核失败：以明确失败回执返回，且不保留占位片场节点（源删除竞态）。
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("source-not-found");
    expect(filmSetNode(room, "film-race")).toBeNull();
    const status = await service.status({ canvasId: "c-race", requestId: "req-1" });
    expect(status.ok && status.status?.status).toBe("failed");
  });
});

describe("FilmSetConversionService：媒体候选与端口（任务 1.1/2.4 / D5/D6）", () => {
  it("未配置生成端口时媒体转换返回已受理的 failed 状态（model-not-configured），不创建占位", async () => {
    const room = await readyRoom("c-nogen", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const service = serviceFor(room);
    const media = await service.submit(request("c-nogen", {
      sourceNodeId: "img-src", targetNodeId: "film-media", sourceKind: "image"
    }));
    expect(media.ok).toBe(false);
    if (media.ok) return;
    expect(media.code).toBe("model-not-configured");
    // 首次使用缺模型先于占位创建（design D4）：不创建占位片场节点。
    expect(filmSetNode(room, "film-media")).toBeNull();
    // 终态记录可通过状态查询回读（不遗留空片场）。
    const status = await service.status({ canvasId: "c-nogen", requestId: "req-1" });
    expect(status.ok && status.status?.status).toBe("failed");
  });

  it("非法候选整份拒绝并返回诊断，占位节点保留诊断且无部分创建", async () => {
    const room = await readyRoom("c-bad", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const generator: FilmSetConversionGenerator = async () => ({
      ok: true,
      candidate: {
        filmSetContent: { schemaVersion: 4, items: [{ id: "x", kind: "video", name: "v", assetId: "missing-asset", aspectRatio: 1 }] },
        sceneCamera: undefined
      }
    });
    const service = serviceFor(room, { generator });
    const outcome = await service.submit(request("c-bad", {
      sourceNodeId: "img-src", targetNodeId: "film-bad", sourceKind: "image"
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("candidate-invalid");
    // 失败保留占位片场节点并在其上给出具体诊断（design D4）；画布无第二个节点/部分内容。
    const target = filmSetNode(room, "film-bad");
    expect(target).not.toBeNull();
    const nodeStatus = readFilmSetConversionNodeStatus(target!.data);
    expect(nodeStatus?.status).toBe("failed");
    expect(nodeStatus?.status === "failed" ? nodeStatus.code : null).toBe("candidate-invalid");
    const decoded = decodeFilmSetNodeData(target!.data);
    expect(decoded.ok).toBe(true);
    // 占位节点保持空内容，未写入任何候选对象（无半个片场定义）。
    if (decoded.ok) {
      expect(decoded.value.filmSetContent.items.map((item) => item.kind)).toEqual([]);
    }
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.document.nodes).toHaveLength(2);
    const status = await service.status({ canvasId: "c-bad", requestId: "req-1" });
    expect(status.ok && status.status?.status).toBe("failed");
  });

  it("只放入源素材（平媒）而无模型对象的候选整份拒绝（必须真正重建画面）", async () => {
    const room = await readyRoom("c-flat", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const generator: FilmSetConversionGenerator = async () => ({
      ok: true,
      candidate: {
        filmSetContent: {
          schemaVersion: 4,
          // 引用合法且 ready 的源资产，但整份片场只有平面媒体项、没有 model 对象。
          items: [{ id: "img", kind: "image", name: "源图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-1", aspectRatio: 1.5 }]
        },
        sceneCamera: undefined
      }
    });
    const service = serviceFor(room, { generator });
    const outcome = await service.submit(request("c-flat", {
      sourceNodeId: "img-src", targetNodeId: "film-flat", sourceKind: "image"
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("candidate-invalid");
    const target = filmSetNode(room, "film-flat");
    expect(target).not.toBeNull();
    expect(readFilmSetConversionNodeStatus(target!.data)?.status).toBe("failed");
    // 占位节点仍是空内容，没有把源素材当作成功结果写入。
    const decoded = decodeFilmSetNodeData(target!.data);
    if (decoded.ok) {
      expect(decoded.value.filmSetContent.items.map((item) => item.kind)).toEqual([]);
    }
  });

  it("完整校验失败时把错误与上一份候选回喂给模型，修复成功后原子提交", async () => {
    const room = await readyRoom("c-repair", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const seen: Array<FilmSetConversionRepair | undefined> = [];
    let calls = 0;
    // 结构归一成功但完整校验失败的候选（只有平面媒体、无重建画面的 model 对象）。
    const invalid = {
      filmSetContent: {
        schemaVersion: 4,
        items: [{ id: "img", kind: "image", name: "源图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-1", aspectRatio: 1.5 }]
      },
      sceneCamera: undefined
    };
    const generator: FilmSetConversionGenerator = async (input) => {
      calls += 1;
      seen.push(input.repair);
      if (calls === 1) return { ok: true, candidate: invalid };
      return { ok: true, candidate: validCandidate(input.title) };
    };
    const service = serviceFor(room, { generator });
    const outcome = await service.submit(request("c-repair", {
      sourceNodeId: "img-src", targetNodeId: "film-repair", sourceKind: "image"
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status.status).toBe("completed");
    // 首次无修复指引；第二次带上一份候选与具体校验错误（上游是无状态回合，必须回喂）。
    expect(calls).toBe(2);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]?.message).toBeTruthy();
    expect(seen[1]?.attempt).toBe(1);
    expect(seen[1]?.candidate).toEqual(invalid);
  });

  it("持续相同诊断不被隐藏次数上限终止；真实上游失败才结束", async () => {
    // change: 2026-10-22-remove-agent-execution-limits，任务 7.2：原「1 + 默认 2 次修复」的
    // 有界修复已删除。持续无效候选不会因修复次数被终止；这里用上游真实失败（非 retryable）
    // 结束循环，验证终止原因是真实故障而不是计数。
    const room = await readyRoom("c-repair-x", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let calls = 0;
    const generator: FilmSetConversionGenerator = async () => {
      calls += 1;
      if (calls > 4) return { ok: false, code: "generation-failed", message: "上游真实失败", retryable: false };
      return {
        ok: true,
        candidate: {
          filmSetContent: {
            schemaVersion: 4,
            items: [{ id: "img", kind: "image", name: "图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-1", aspectRatio: 1 }]
          },
          sceneCamera: undefined
        }
      };
    };
    const service = serviceFor(room, { generator });
    const outcome = await service.submit(request("c-repair-x", {
      sourceNodeId: "img-src", targetNodeId: "film-repair-x", sourceKind: "image"
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 超过原来的 3 次调用仍继续修复，直到上游真实失败。
    expect(calls).toBeGreaterThan(3);
    expect(outcome.code).toBe("generation-failed");
    const target = filmSetNode(room, "film-repair-x");
    const status = readFilmSetConversionNodeStatus(target!.data);
    expect(status?.status).toBe("failed");
    if (status?.status === "failed") expect(status.message.trim().length).toBeGreaterThan(0);
  });

  it("合法候选一次事务创建片场并记录来源 metadata", async () => {
    const room = await readyRoom("c-ok", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const generator: FilmSetConversionGenerator = async (input) => ({ ok: true, candidate: validCandidate(input.title) });
    const service = serviceFor(room, { generator });
    const outcome = await service.submit(request("c-ok", {
      sourceNodeId: "img-src", targetNodeId: "film-ok", sourceKind: "image", settings: { modelKey: "litellm:model" }
    }));
    expect(outcome.ok && outcome.status.status).toBe("completed");
    const target = filmSetNode(room, "film-ok")!;
    const decoded = decodeFilmSetNodeData(target.data);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.value.filmSetContent.items.length).toBeGreaterThan(0);
    expect(decoded.value.origin?.conversion?.modelKey).toBe("litellm:model");
  });

  it("生成器收到冻结来源与稳定媒体引用（storageKey），而非仅 URL 文本", async () => {
    const room = await readyRoom("c-media", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let seen: { storageKey: string; contentType: string; modelKey: string; kind: string } | null = null;
    const generator: FilmSetConversionGenerator = async (input) => {
      seen = {
        storageKey: input.media?.storageKey ?? "",
        contentType: input.media?.contentType ?? "",
        modelKey: input.modelKey,
        kind: input.frozenSource.kind
      };
      return { ok: true, candidate: validCandidate(input.title) };
    };
    const service = serviceFor(room, { generator });
    const outcome = await service.submit(request("c-media", {
      sourceNodeId: "img-src", targetNodeId: "film-media-in", sourceKind: "image"
    }));
    expect(outcome.ok && outcome.status.status).toBe("completed");
    expect(seen).toEqual({
      storageKey: `sha256-${"a".repeat(64)}`,
      contentType: "image/png",
      modelKey: "",
      kind: "image"
    });
  });

  it("ownerId 冻结进记录并原样传给生成器（缺失时不传，生成端按可信主体解析）", async () => {
    const room = await readyRoom("c-owner", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const registry = new InMemoryFilmSetConversionRegistry();
    const seen: Array<string | undefined> = [];
    const generator: FilmSetConversionGenerator = async (input) => {
      seen.push(input.ownerId);
      return { ok: true, candidate: validCandidate(input.title) };
    };
    const service = serviceFor(room, { generator, registry });
    const outcome = await service.submit(request("c-owner", {
      sourceNodeId: "img-src", targetNodeId: "film-owner", sourceKind: "image", ownerId: "local:abc"
    }));
    expect(outcome.ok && outcome.status.status).toBe("completed");
    expect(seen).toEqual(["local:abc"]);
    // 冻结在记录里：重试/恢复复用同一 owner。
    expect((await registry.get("c-owner", "req-1"))?.ownerId).toBe("local:abc");

    // 未解析出 owner 时不注入字段，生成端按 `subject`/自身边界处理。
    const room2 = await readyRoom("c-owner-none", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const seen2: Array<string | undefined> = [];
    const service2 = serviceFor(room2, {
      generator: async (input) => { seen2.push(input.ownerId); return { ok: true, candidate: validCandidate(input.title) }; }
    });
    await service2.submit(request("c-owner-none", { sourceNodeId: "img-src", targetNodeId: "film-owner-none", sourceKind: "image" }));
    expect(seen2).toEqual([undefined]);
  });
});

describe("FilmSetConversionService：占位片场节点生命周期（任务 1.3/2.4 / D4）", () => {
  it("media 转换进行中在占位节点上显示真实阶段，成功原地填入且不新增第二个节点", async () => {
    const room = await readyRoom("c-ph-media", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const seen: Array<{ kind: string; step?: string }> = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const generator: FilmSetConversionGenerator = async (input) => {
      entered!();
      input.onStep?.("analyze-content");
      await gate;
      return { ok: true, candidate: validCandidate(input.title) };
    };
    const service = serviceFor(room, { generator });
    const pending = service.submit(request("c-ph-media", {
      sourceNodeId: "img-src", targetNodeId: "film-ph", sourceKind: "image"
    }));
    await started;
    const inProgress = readFilmSetConversionNodeStatus(filmSetNode(room, "film-ph")!.data);
    seen.push({ kind: inProgress?.status ?? "none", ...(inProgress?.status === "running" ? { step: inProgress.step } : {}) });
    release!();
    const outcome = await pending;
    expect(outcome.ok && outcome.status.status).toBe("completed");
    // 目标只有一个节点：占位即最终片场（原地填入，不新增第二个）。
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.document.nodes.filter((node) => node.id === "film-ph")).toHaveLength(1);
    expect(exported.canvas.document.nodes.filter(node => node.type !== "film-set-shot-preview")).toHaveLength(2);
    const target = filmSetNode(room, "film-ph")!;
    const decoded = decodeFilmSetNodeData(target.data);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.value.filmSetContent.items.length).toBeGreaterThan(0);
    expect(readFilmSetConversionNodeStatus(target.data)?.status).toBe("completed");
    // 进行中时确实在占位节点上呈现过阶段。
    expect(seen.some((entry) => entry.kind === "running")).toBe(true);
  });

  it("3D 复制：占位节点随后即变为已交付（同一节点身份）", async () => {
    const room = await readyRoom("c-ph-3d", [{ id: "model-src", type: "model3d", data: model3dData() }]);
    const outcome = await serviceFor(room).submit(request("c-ph-3d"));
    expect(outcome.ok && outcome.status.status).toBe("completed");
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.document.nodes.filter((node) => node.id === "film-target")).toHaveLength(1);
    const target = filmSetNode(room, "film-target")!;
    const decoded = decodeFilmSetNodeData(target.data);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.value.filmSetContent.items.some((item) => item.kind === "model")).toBe(true);
    expect(readFilmSetConversionNodeStatus(target.data)?.status).toBe("completed");
    // 占位节点不改动源节点；没有从来源关系派生的普通片场端口边。
    expect(exported.canvas.document.nodes.some((node) => node.id === "model-src")).toBe(true);
    expect(exported.canvas.document.edges).toHaveLength(0);
  });

  it("占位节点可由片场 decoder 读取（初始空内容，无默认地面）", async () => {
    const room = await readyRoom("c-ph-empty", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const generator: FilmSetConversionGenerator = async () => {
      entered!();
      await gate;
      return { ok: false, code: "generation-failed", message: "上游失败", retryable: true };
    };
    const service = serviceFor(room, { generator });
    const pending = service.submit(request("c-ph-empty", {
      sourceNodeId: "img-src", targetNodeId: "film-empty", sourceKind: "image"
    }));
    await started;
    const target = filmSetNode(room, "film-empty")!;
    expect(target.node.type).toBe("composite-asset");
    expect(target.data?.extensionId).toBe("film-set");
    const decoded = decodeFilmSetNodeData(target.data);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.value.filmSetContent.items.map((item) => item.kind)).toEqual([]);
    release!();
    await pending;
  });
});

describe("FilmSetConversionService：后台执行与不重复执行（任务 2.5 / D4/D5）", () => {
  it("同一来源的两个请求可并行生成，取消其中一个不影响另一个提交", async () => {
    const room = await readyRoom("c-parallel", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const seen = new Set<string>();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const bothStarted = new Promise<void>(resolve => { started = resolve; });
    const service = serviceFor(room, {
      submitBudgetMs: 0,
      generator: async input => {
        seen.add(input.requestId);
        if (seen.size === 2) started();
        await gate;
        return { ok: true, candidate: validCandidate(input.title) };
      }
    });
    try {
      const outcomes = await Promise.all(["a", "b"].map(id => service.submit(request("c-parallel", {
        requestId: id, sourceNodeId: "img-src", targetNodeId: `film-${id}`, sourceKind: "image", settings: { instruction: `task-${id}` }
      }))));
      expect(outcomes.every(outcome => outcome.ok && outcome.status.status === "running")).toBe(true);
      await bothStarted;
      for (const id of ["a", "b"]) {
        expect(filmSetNode(room, `film-${id}`)!.data?.filmSetConversionRequest).toEqual({
          canvasId: "c-parallel", requestId: id, sourceNodeId: "img-src", targetNodeId: `film-${id}`, sourceKind: "image",
          settings: { instruction: `task-${id}` }
        });
      }
      expect(filmSetNode(room, "film-a")!.node.position).not.toEqual(filmSetNode(room, "film-b")!.node.position);
      const cancelled = await service.cancel({ canvasId: "c-parallel", requestId: "a" });
      expect(cancelled.ok && cancelled.status.status).toBe("cancelled");
      const other = await service.status({ canvasId: "c-parallel", requestId: "b" });
      expect(other.ok && other.status?.status).toBe("running");
    } finally {
      release();
      await service.whenSettled();
    }
    expect(readFilmSetConversionNodeStatus(filmSetNode(room, "film-a")!.data)?.status).toBe("cancelled");
    expect(readFilmSetConversionNodeStatus(filmSetNode(room, "film-b")!.data)?.status).toBe("completed");
  });

  it("并发重复提交同一媒体请求最多调用一次模型并只创建一个结果", async () => {
    const room = await readyRoom("c-once", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let modelCalls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generator: FilmSetConversionGenerator = async (input) => {
      modelCalls += 1;
      await gate;
      return { ok: true, candidate: validCandidate(input.title) };
    };
    const service = serviceFor(room, { generator });
    const requestPayload = request("c-once", { sourceNodeId: "img-src", targetNodeId: "film-once", sourceKind: "image" });
    // 三条并发（双击 + 重连恢复）都复用同一 requestId：模型最多调用一次，结果最多创建一次。
    const pending = [service.submit(requestPayload), service.submit(requestPayload), service.submit(requestPayload)];
    release!();
    const outcomes = await Promise.all(pending);
    expect(modelCalls).toBe(1);
    for (const outcome of outcomes) expect(outcome.ok).toBe(true);
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    expect(exported.canvas.document.nodes.filter((node) => node.id === "film-once")).toHaveLength(1);
  });

  it("unknown 只由显式查询核对，不自动重新推理（同 requestId 不重复调用模型）", async () => {
    const room = await readyRoom("c-unknown", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let modelCalls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const generator: FilmSetConversionGenerator = async (input) => {
      modelCalls += 1;
      entered!();
      await gate;
      return { ok: true, candidate: validCandidate(input.title) };
    };
    const service = serviceFor(room, { generator });
    const requestPayload = request("c-unknown", { sourceNodeId: "img-src", targetNodeId: "film-unknown-2", sourceKind: "image" });
    const running = service.submit(requestPayload);
    // 等待生成器真正被调用（占位创建后），再断言没有新推理。
    await started;
    // 查询在记录处于 running 且本进程持有 in-flight 任务时返回 running（不触发新推理）。
    const status = await service.status({ canvasId: "c-unknown", requestId: "req-1" });
    expect(status.ok && status.status?.status).toBe("running");
    expect(modelCalls).toBe(1);
    release!();
    await running;
  });
});

describe("FilmSetConversionService：模型能力门禁（任务 1.1/2.1 / D6）", () => {
  const VISION: FilmSetConversionAdapterCapabilities = {
    structuredCandidateOutput: true,
    input: {
      imageInput: true,
      maxImages: 1,
      videoInput: false,
      maxFrames: 0,
      maxDurationSeconds: 0
    }
  };

  it("能力未知（目录返回 undefined）在调用上游前拒绝，不调用生成器", async () => {
    const room = await readyRoom("c-cap-unknown", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let calls = 0;
    const generator: FilmSetConversionGenerator = async () => { calls += 1; return { ok: false, code: "generation-failed", message: "no" }; };
    const service = serviceFor(room, { generator, resolveModelCapabilities: true, capabilities: undefined });
    const outcome = await service.submit(request("c-cap-unknown", {
      sourceNodeId: "img-src", targetNodeId: "film-unknown", sourceKind: "image"
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("model-not-vision-capable");
    expect(calls).toBe(0);
    expect(filmSetNode(room, "film-unknown")).toBeNull();
  });

  it("仅文字能力或缺少结构化输出在调用上游前拒绝", async () => {
    const room = await readyRoom("c-cap-text", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let calls = 0;
    const generator: FilmSetConversionGenerator = async () => { calls += 1; return { ok: false, code: "generation-failed", message: "no" }; };
    const textOnly = serviceFor(room, {
      generator, resolveModelCapabilities: true,
      capabilities: { structuredCandidateOutput: false, input: { imageInput: false, maxImages: 0, videoInput: false, maxFrames: 0, maxDurationSeconds: 0 } }
    });
    const rejected = await textOnly.submit(request("c-cap-text", {
      sourceNodeId: "img-src", targetNodeId: "film-text", sourceKind: "image"
    }));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("model-no-structured-output");
    expect(calls).toBe(0);
  });

  it("视频模型需原生视频或多图输入；仅单图能力被拒绝", async () => {
    const room = await readyRoom("c-cap-video", [{ id: "vid-src", type: "video", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyVideoAsset()]);
    let calls = 0;
    const generator: FilmSetConversionGenerator = async () => { calls += 1; return { ok: false, code: "generation-failed", message: "no" }; };
    const singleImage = serviceFor(room, { generator, resolveModelCapabilities: true, capabilities: VISION });
    const rejected = await singleImage.submit(request("c-cap-video", {
      sourceNodeId: "vid-src", targetNodeId: "film-video", sourceKind: "video"
    }));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("model-not-vision-capable");
    expect(calls).toBe(0);

    const multi = serviceFor(room, {
      generator: async (input) => { calls += 1; return { ok: true, candidate: validCandidate(input.title) }; },
      resolveModelCapabilities: true,
      capabilities: { structuredCandidateOutput: true, input: { imageInput: true, maxImages: 8, videoInput: false, maxFrames: 8, maxDurationSeconds: 0 } }
    });
    const accepted = await multi.submit(request("c-cap-video", {
      sourceNodeId: "vid-src", targetNodeId: "film-video", sourceKind: "video"
    }));
    expect(accepted.ok && accepted.status.status).toBe("completed");
    expect(calls).toBe(1);
  });
});

describe("FilmSetConversionService：显式重试（任务 2.5 / D5）", () => {
  it("合法候选保存失败后重试复用候选，不重复调用模型", async () => {
    const room = await readyRoom("c-retry", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let modelCalls = 0;
    // 生成期间删除来源节点：候选合法但权威提交在边界复核失败 → 记录为 failed 且保留候选。
    const generator: FilmSetConversionGenerator = async (input) => {
      modelCalls += 1;
      const exported = room.exportCanvas();
      if (!exported.ok) throw new Error("export");
      await room.submit({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId: "c-retry",
        actorId: "test",
        commandId: "delete-before-retry",
        baseRevision: exported.canvas.revision,
        commands: [{ type: "node.remove", nodeIds: ["img-src"] }]
      } as never);
      return { ok: true, candidate: validCandidate(input.title) };
    };
    const registry = new InMemoryFilmSetConversionRegistry();
    const service = serviceFor(room, { generator, registry });
    const first = await service.submit(request("c-retry", { sourceNodeId: "img-src", targetNodeId: "film-retry", sourceKind: "image" }));
    expect(first.ok).toBe(false);
    expect(modelCalls).toBe(1);
    const failed = await registry.get("c-retry", "req-1");
    expect(failed?.state).toBe("failed");
    expect(failed?.candidate).toBeTruthy();

    // 重试：来源仍删除 → 提交边界再次失败，但**不**重复调用模型（复用候选）。
    const retried = await service.retry({ canvasId: "c-retry", requestId: "req-1" });
    expect(retried.ok).toBe(false);
    expect(modelCalls).toBe(1);
    expect(filmSetNode(room, "film-retry")).toBeNull();
  });

  it("无候选的失败重试产生新的尝试身份并重新推理", async () => {
    const room = await readyRoom("c-retry-fail", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let attempts = 0;
    const generator: FilmSetConversionGenerator = async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, code: "generation-failed", message: "上游失败", retryable: true }
        : { ok: false, code: "generation-failed", message: "上游再次失败", retryable: true };
    };
    const service = serviceFor(room, { generator });
    const first = await service.submit(request("c-retry-fail", {
      sourceNodeId: "img-src", targetNodeId: "film-rf", sourceKind: "image"
    }));
    expect(first.ok).toBe(false);
    const status1 = await service.status({ canvasId: "c-retry-fail", requestId: "req-1" });
    expect(status1.ok && status1.status?.status === "failed" && status1.status.attempt).toBe(1);

    await service.retry({ canvasId: "c-retry-fail", requestId: "req-1" });
    expect(attempts).toBe(2);
    const status2 = await service.status({ canvasId: "c-retry-fail", requestId: "req-1" });
    expect(status2.ok && status2.status?.status === "failed" && status2.status.attempt).toBe(2);
  });
});

describe("FilmSetConversionService：提交预算与上游硬超时（design D4/D5/D6）", () => {
  it("默认在占位节点落地后受理，不等待模型；无镜头候选交付默认静态镜头与预览", async () => {
    const room = await readyRoom("c-immediate", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = new FilmSetConversionService({
      resolveRoom: async () => room, registry: new InMemoryFilmSetConversionRegistry(),
      generator: async () => {
        await gate;
        const candidate = validCandidate("重建");
        return { ok: true, candidate: { filmSetContent: candidate.filmSetContent, sceneCamera: candidate.sceneCamera } };
      }
    });
    const outcome = await service.submit(request("c-immediate", { sourceKind: "image", sourceNodeId: "img-src" }));
    expect(outcome.ok && outcome.status.status).toBe("running");
    expect(filmSetNode(room, "film-target")!.data?.taskStatus).toBe("processing");
    release();
    await service.whenSettled();
    const decoded = decodeFilmSetNodeData(filmSetNode(room, "film-target")!.data);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const clips = decoded.value.filmSetAnimations!;
    expect(clips.defaultClipId).toBe("converted-shot");
    expect(clips.clips[0]).toMatchObject({ kind: "static", timeline: { duration: 0 } });
    expect(clips.clips[0]!.bindings.map(binding => binding.itemId)).toEqual(decoded.value.filmSetContent.items.filter(item => item.kind !== "ground").map(item => item.id));
    const canvas = room.exportCanvas();
    expect(canvas.ok && canvas.canvas.document.nodes.some(node => node.type === "film-set-shot-preview")).toBe(true);
  });

  it("生成器意外抛错也将具体失败写回目标节点", async () => {
    const room = await readyRoom("c-throw", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    const service = serviceFor(room, { generator: async () => { throw new Error("上游连接已断开"); } });
    await service.submit(request("c-throw", { sourceKind: "image", sourceNodeId: "img-src" }));
    expect(readFilmSetConversionNodeStatus(filmSetNode(room, "film-target")!.data)).toMatchObject({ status: "failed", message: "上游连接已断开", retryable: true });
  });

  it("上游推理超过提交预算时返回进行中、不阻塞入口；占位节点已创建，后台完成后落终态", async () => {
    const room = await readyRoom("c-budget", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generator: FilmSetConversionGenerator = async (input) => {
      await gate;
      return { ok: true, candidate: validCandidate(input.title) };
    };
    // 极小的提交预算：模拟“上游推理远超入口单跳超时”。
    const service = serviceFor(room, { generator, submitBudgetMs: 5 });
    const outcome = await service.submit(request("c-budget", {
      sourceNodeId: "img-src", targetNodeId: "film-budget", sourceKind: "image"
    }));
    // 未被入口超时掐断成通用错误：返回进行中；占位片场节点已创建并显示进行中。
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status.status).toBe("running");
    const placeholder = filmSetNode(room, "film-budget");
    expect(placeholder).not.toBeNull();
    expect(readFilmSetConversionNodeStatus(placeholder!.data)?.status).toBe("running");
    // 后台继续完成：终态可在状态查询读到，不需要重新提交。
    release!();
    await service.whenSettled();
    const status = await service.status({ canvasId: "c-budget", requestId: "req-1" });
    expect(status.ok && status.status?.status).toBe("completed");
  });

  it("上游长时间无响应时按硬超时落为可重试失败（占位节点脱离进行中，可删除）", async () => {
    const room = await readyRoom("c-timeout", [{ id: "img-src", type: "image", data: { outputAssetId: "asset-1" } as CanvasNodeData }], [readyImageAsset()]);
    // 永不返回的生成器：只有 abort 信号能唤醒它（模拟上游挂起）。
    const generator: FilmSetConversionGenerator = (input) =>
      new Promise((resolve) => {
        const abort = () => resolve({ ok: false, code: "cancelled", message: "aborted" });
        if (input.signal.aborted) abort();
        else input.signal.addEventListener("abort", abort, { once: true });
      });
    const service = serviceFor(room, { generator, submitBudgetMs: 5, generationTimeoutMs: 20 });
    const outcome = await service.submit(request("c-timeout", {
      sourceNodeId: "img-src", targetNodeId: "film-timeout", sourceKind: "image"
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status.status).toBe("running");
    await service.whenSettled();
    const status = await service.status({ canvasId: "c-timeout", requestId: "req-1" });
    expect(status.ok && status.status?.status).toBe("failed");
    if (status.ok && status.status?.status === "failed") {
      expect(status.status.code).toBe("generation-failed");
      expect(status.status.retryable).toBe(true);
    }
    // 占位节点落到终态失败：其 taskStatus 不再是进行中，任务边界保护因此不再阻止删除。
    const target = filmSetNode(room, "film-timeout");
    expect(readFilmSetConversionNodeStatus(target!.data)?.status).toBe("failed");
    expect(target!.data?.taskStatus).toBe("failed");
  });
});
