/**
 * 组合契约测试：`openspec/changes/move-canvas-state-to-web/notes/source-inventory.md` 第 7 节的
 * 兼容性测试矩阵 M1–M14 在此落成断言。每条 `it` 的标题都带矩阵编号，便于回溯。
 *
 * 这里的 fixture 是来源项目 `ServerCanvas` 契约的真实形态（见 fixture 目录 README），
 * 用于固定 serialized shape，避免复制代码后与上游无声漂移。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas,
  createWoohaa3CanvasNode,
  fromWoohaa3CanvasDocument,
  normalizeCanvas,
  parseCanvasAggregate,
  toWoohaa3CanvasDocument,
  type CanvasAggregateIssue,
  type ServerCanvas } from "./index";
import { COMPOSITE_ASSET_NODE_TYPE } from "./core/composite-asset-identity.js";
import { buildCanvasRenderScene } from "../render-scene.js";

import emptyFixture from "./__fixtures__/empty-canvas.json";
import fullFixture from "./__fixtures__/full-canvas.json";
import partialFixture from "./__fixtures__/partial-invalid-canvas.json";
import unsupportedFixture from "./__fixtures__/unsupported-schema-canvas.json";

/** 与 fixture 的 updatedAt 对齐，使「无业务修改」的往返可以断言严格相等。 */
const NOW = "2026-09-22T00:00:00.000Z";
const FIXTURES_DIR = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const IMAGE_NODE = "image-43200b04-00af-443d-a591-decff3e3a014";
const TEXT_NODE = "text-7c1d9f52-2f6e-4a1b-9c3d-1a2b3c4d5e6f";

const STRUCTURAL_NODE_KEYS = new Set([
  "id", "type", "position", "width", "height", "parentId", "zIndex"
]);

function parseOk(input: unknown): { canvas: ServerCanvas; issues: CanvasAggregateIssue[] } {
  const result = parseCanvasAggregate(input, { now: NOW });
  if (!result.ok) throw new Error(`期望解析成功，实际失败: ${result.failure.code}`);
  return { canvas: result.canvas, issues: result.issues };
}

function issuesOf(issues: CanvasAggregateIssue[], code: CanvasAggregateIssue["code"]) {
  return issues.filter((issue) => issue.code === code);
}

function roundTrip(canvas: ServerCanvas) {
  return toWoohaa3CanvasDocument(fromWoohaa3CanvasDocument(canvas.document), NOW);
}

describe("M1–M2 往返序列化", () => {
  it("M1 空聚合可读取且往返后语义不变", () => {
    const { canvas } = parseOk(emptyFixture);
    expect(canvas.document.schemaVersion).toBe("asset-canvas-v1");
    expect(canvas.document.nodes).toEqual([]);
    expect(canvas.document.edges).toEqual([]);
    expect(canvas.nodeData).toEqual({});
    expect(canvas.assets).toEqual([]);
    expect(canvas.jobs).toEqual([]);
    expect(roundTrip(canvas)).toEqual(canvas.document);
  });

  it("M2 完整聚合的全部字段在往返后保留", () => {
    const { canvas } = parseOk(fullFixture);
    expect(canvas.id).toBe("canvas-full");
    expect(canvas.title).toBe("完整画布");
    expect(canvas.revision).toBe(7);
    expect(canvas.document.nodes.map((node) => node.id)).toEqual([IMAGE_NODE, TEXT_NODE]);
    expect(canvas.document.edges.map((edge) => edge.id))
      .toEqual(["edge-9f0c2b71-3a44-4c8e-8d55-0b7a6e5f4d31"]);
    expect(Object.keys(canvas.nodeData).sort()).toEqual([IMAGE_NODE, TEXT_NODE].sort());
    expect(canvas.assets.map((asset) => asset.id)).toEqual(["asset-image-mtpb4p43"]);
    expect(canvas.jobs.map((job) => job.id)).toEqual(["job-5d2c8e14"]);
    expect(canvas.assets[0].provenance?.runId).toBe("run-6b3e91d7");
    expect(canvas.jobs[0].status).toBe("success");
    expect(roundTrip(canvas)).toEqual(canvas.document);
    expect(canvas.document.schemaVersion).toBe("asset-canvas-v1");
  });

  it("M2 来源项目生成的 JSON 无需字段迁移即可读取", () => {
    // fixture 直接来自来源契约，读取时不应产生任何「迁移」类 issue。
    const { issues } = parseOk(fullFixture);
    expect(issues).toEqual([]);
  });
});

describe("M3 节点业务字段不内嵌进结构节点", () => {
  it("M3 结构节点只含结构字段，业务字段全部位于 nodeData", () => {
    const { canvas } = parseOk(fullFixture);
    for (const node of canvas.document.nodes) {
      const extras = Object.keys(node).filter((key) => !STRUCTURAL_NODE_KEYS.has(key));
      expect(extras, `节点 ${node.id} 不应内嵌业务字段`).toEqual([]);
    }
    expect(canvas.nodeData[IMAGE_NODE]).toMatchObject({
      title: "主视觉",
      panelPrompt: "一只猫坐在窗台上",
      parameters: { ratio: "1:1", resolution: "1K" }
    });
  });
});

describe("M4–M7 不受信任输入规范化", () => {
  it("M4 丢弃缺 id/缺 type 的节点，修正非法坐标，收敛未知类型", () => {
    const { canvas, issues } = parseOk(partialFixture);
    expect(canvas.document.nodes.map((node) => node.id)).toEqual([
      IMAGE_NODE,
      TEXT_NODE,
      "image-broken-position",
      "task-legacy-unknown-type"
    ]);
    expect(canvas.document.nodes.map((node) => node.type))
      .toEqual(["image", "text", "image", "custom"]);
    expect(canvas.document.nodes[2].position).toEqual({ x: 0, y: 120 });
    expect(issuesOf(issues, "node.dropped")).toHaveLength(2);
    expect(issuesOf(issues, "node.type-coerced")).toHaveLength(1);
  });

  it("M4b 已下线的旧应用节点类型（generate/edit/shot/start）收敛为 custom", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas-app-types", NOW);
    const input = {
      ...canvas,
      document: toWoohaa3CanvasDocument(
        {
          nodes: [
            createWoohaa3CanvasNode("generate", { x: 0, y: 0 }, "n-generate"),
            createWoohaa3CanvasNode("edit", { x: 0, y: 0 }, "n-edit"),
            createWoohaa3CanvasNode("shot", { x: 0, y: 0 }, "n-shot"),
            createWoohaa3CanvasNode("start", { x: 0, y: 0 }, "n-start")
          ],
          edges: []
        },
        NOW
      )
    };
    const { canvas: parsed, issues } = parseOk(input);
    expect(parsed.document.nodes.map((node) => node.type))
      .toEqual(["custom", "custom", "custom", "custom"]);
    expect(issuesOf(issues, "node.type-coerced")).toHaveLength(4);
  });

  it("M4c 通用复合资产节点 composite-asset 被接受，边被清除（change: 2026-10-10-add-game-furnace-extension；2026-10-11 身份迁移）", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas-ext3d", NOW);
    const input = {
      ...canvas,
      document: toWoohaa3CanvasDocument(
        {
          nodes: [
            createWoohaa3CanvasNode(COMPOSITE_ASSET_NODE_TYPE, { x: 10, y: 20 }, "n-ext"),
            createWoohaa3CanvasNode("image", { x: 300, y: 0 }, "n-img")
          ],
          edges: [
            { id: "e-ext", source: "n-ext", target: "n-img", sourceHandle: null, targetHandle: null, data: {} }
          ]
        },
        NOW
      )
    };
    const parsed = normalizeCanvas(input);
    // 复合资产节点是合法 canonical 类型（不再收敛为 custom）。
    expect(parsed.document.nodes.find((node) => node.id === "n-ext")?.type).toBe(COMPOSITE_ASSET_NODE_TYPE);
    // 复合资产现在是普通节点，连线保留。
    expect(parsed.document.edges.map((edge) => edge.id)).toEqual(["e-ext"]);
  });

  it("复合资产节点连线在规范化与重新加载后保留", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("reference-container", NOW);
    canvas.document.nodes.push(
      { id: "container", type: "composite-asset", position: { x: 0, y: 0 } },
      { id: "model", type: "composite-asset", position: { x: 0, y: 300 } },
      { id: "output", type: "text", position: { x: 400, y: 0 } }
    );
    canvas.nodeData.container = { compositeAssetRole: "reference-container" };
    canvas.document.edges.push(
      { id: "reference", source: "container", target: "output", sourceHandle: null, targetHandle: null, data: { kind: "dependency" } },
      { id: "model-edge", source: "model", target: "output", sourceHandle: null, targetHandle: null, data: { kind: "dependency" } }
    );
    const normalized = normalizeCanvas(canvas);
    expect(normalized.document.edges.map(edge => edge.id)).toEqual(["reference", "model-edge"]);
    expect(normalizeCanvas(JSON.parse(JSON.stringify(normalized))).document.edges).toEqual(normalized.document.edges);
    const scene = buildCanvasRenderScene({ canvas: normalized });
    expect(scene.edges.map(edge => edge.id)).toEqual(["reference", "model-edge"]);
  });

  it("M5 丢弃缺少端点或 data 非对象的边", () => {    const { canvas, issues } = parseOk(partialFixture);
    expect(canvas.document.edges.map((edge) => edge.id))
      .toEqual(["edge-9f0c2b71-3a44-4c8e-8d55-0b7a6e5f4d31"]);
    expect(issuesOf(issues, "edge.dropped")).toHaveLength(2);
  });

  it("M6 旧文档里的 viewport 字段在读取时被忽略（视口为本地状态）", () => {
    const { canvas } = parseOk(partialFixture);
    expect(canvas.document).not.toHaveProperty("viewport");
  });

  it("M7 剪枝空 nodeId、非对象值、孤儿节点与 custom 节点的 nodeData", () => {
    const { canvas, issues } = parseOk(partialFixture);
    expect(Object.keys(canvas.nodeData).sort()).toEqual([IMAGE_NODE, TEXT_NODE].sort());
    const prunedPaths = issuesOf(issues, "nodeData.pruned").map((issue) => issue.path);
    expect(prunedPaths).toContain(`nodeData.${"task-legacy-unknown-type"}`);
    expect(prunedPaths).toContain("nodeData.node-orphan-not-in-document");
  });

  it("M13 读取不改写坐标，写回时按世界单位吸附且此后往返幂等", () => {
    const { canvas } = parseOk(partialFixture);
    const image = canvas.document.nodes.find((node) => node.id === IMAGE_NODE);
    // 读取路径不得改写用户数据：85/95 原样保留。
    expect(image?.position).toEqual({ x: 85, y: 95 });

    // 吸附只发生在写回路径（toWoohaa3CanvasDocument）。规范坐标是世界单位，
    // 20 图素网格 = 20/80 = 0.25 世界单位；85/95 已是 0.25 的整数倍，保持不变。
    const once = roundTrip(canvas);
    expect(once.nodes.find((node) => node.id === IMAGE_NODE)?.position)
      .toEqual({ x: 85, y: 95 });

    // 非 0.25 倍数的坐标被吸附到 0.25 网格。
    const snapped = toWoohaa3CanvasDocument(
      fromWoohaa3CanvasDocument({
        ...canvas.document,
        nodes: canvas.document.nodes.map((node) =>
          node.id === IMAGE_NODE ? { ...node, position: { x: 85.1, y: 95.61 } } : node
        )
      }),
      NOW
    );
    expect(snapped.nodes.find((node) => node.id === IMAGE_NODE)?.position)
      .toEqual({ x: 85, y: 95.5 });

    // 幂等：已吸附的坐标再次往返不再变化。
    const twice = toWoohaa3CanvasDocument(fromWoohaa3CanvasDocument(once), NOW);
    expect(twice).toEqual(once);
  });
});

describe("M8–M9 资产与任务记录", () => {
  it("M8 丢弃缺 mediaKind 的旧资产与无 id 的资产", () => {
    const { canvas, issues } = parseOk(partialFixture);
    expect(canvas.assets.map((asset) => asset.id))
      .toEqual(["asset-image-mtpb4p43"]);

    // 旧格式资产不再被推断迁移，与无 id 资产一样被丢弃。
    expect(issuesOf(issues, "asset.dropped")).toHaveLength(2);
  });

  it("M9 丢弃缺少 id / nodeId / taskId 的任务记录", () => {
    const { canvas, issues } = parseOk(partialFixture);
    expect(canvas.jobs.map((job) => job.id)).toEqual(["job-5d2c8e14"]);
    expect(issuesOf(issues, "job.dropped")).toHaveLength(2);
  });
});

describe("M10 未知 schema 拒绝", () => {
  it("M10 不支持的 schema 版本被拒绝且不返回可用画布", () => {
    const result = parseCanvasAggregate(unsupportedFixture, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("unsupported-schema-version");
    expect(result.failure.schemaVersion).toBe("asset-canvas-v99");
  });

  it("M10 缺少 schemaVersion 的文档同样被拒绝", () => {
    const result = parseCanvasAggregate({ id: "x", document: { nodes: [] } }, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("missing-schema-version");
  });

  it("M10 非对象输入被拒绝", () => {
    const result = parseCanvasAggregate("not-a-canvas", { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("not-an-object");
  });
});

describe("M11–M12 非 JSON 值与二进制不进入规范状态", () => {
  it("M11 剥离 nodeData 中的函数、undefined、NaN 等非 JSON 值", () => {
    const { canvas } = parseOk({
      id: "canvas-non-json",
      revision: 2,
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: IMAGE_NODE, type: "image", position: { x: 0, y: 0 } }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        updatedAt: NOW
      },
      nodeData: {
        [IMAGE_NODE]: {
          panelPrompt: "保留",
          droppedUndefined: undefined,
          droppedFunction: () => "nope",
          droppedNaN: Number.NaN,
          droppedInfinity: Number.POSITIVE_INFINITY,
          nested: { keep: 1, drop: undefined }
        }
      },
      assets: [],
      jobs: [],
      updatedAt: NOW
    });

    expect(canvas.nodeData[IMAGE_NODE]).toEqual({
      panelPrompt: "保留",
      nested: { keep: 1 }
    });
    expect(() => JSON.stringify(canvas)).not.toThrow();
  });

  it("M12 Blob 与非契约二进制字段不进入画布 JSON", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    const { canvas } = parseOk({
      id: "canvas-blob",
      revision: 1,
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: IMAGE_NODE, type: "image", position: { x: 0, y: 0 } }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        updatedAt: NOW
      },
      nodeData: {},
      assets: [
        {
          id: "asset-with-blob",
          nodeId: IMAGE_NODE,
          title: "带二进制的资产",
          mediaKind: "image",
          source: "uploaded",
          status: "ready",
          createdAt: NOW,
          blob,
          base64: "AQIDBA==",
          metadata: { keep: "ok" }
        }
      ],
      jobs: [],
      updatedAt: NOW
    });

    const asset = canvas.assets[0];
    expect(asset).toBeDefined();
    expect(Object.keys(asset)).not.toContain("blob");
    expect(Object.keys(asset)).not.toContain("base64");
    expect(asset.id).toBe("asset-with-blob");
    expect(asset.metadata).toEqual({ keep: "ok" });

    const json = JSON.stringify(canvas);
    expect(json).not.toContain("AQIDBA==");
    // 二进制只通过稳定资产 ID 与聚合关联
    expect(JSON.parse(json).assets[0].id).toBe("asset-with-blob");
  });
});

describe("空画布引导与 M14 fixture 卫生", () => {
  it("创建的空画布不含任何节点，也不创建 START 规范节点", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas-new", NOW);
    expect(canvas.revision).toBe(0);
    expect(canvas.document.schemaVersion).toBe("asset-canvas-v1");
    expect(canvas.document.nodes).toEqual([]);
    expect(canvas.document.edges).toEqual([]);
    expect(canvas.assets).toEqual([]);
    expect(canvas.jobs).toEqual([]);
    expect(canvas.updatedAt).toBe(NOW);
  });

  it("M14 fixture 内不含绝对路径或 file: 引用", () => {
    const files = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const raw = readFileSync(`${FIXTURES_DIR}/${file}`, "utf8");
      expect(raw, `${file} 不应包含绝对路径`).not.toContain("/data/workspace");
      expect(raw, `${file} 不应包含 file: 引用`).not.toMatch(/file:\/\//);
    }
  });
});
