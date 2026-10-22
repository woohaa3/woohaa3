/**
 * 限制基线测量（任务 1.4）。
 *
 * 用真实形态的画布样本（空、含 COS 资产、以及放大的典型画布）测量：
 * - 单画布规范 JSON 字节数
 * - 单个命令批次的 JSON 字节数与命令数
 * - 资产引用数量
 *
 * 默认限制（`DEFAULT_CANVAS_STORAGE_LIMITS`）据此设定，并留出充足余量。这些断言既是
 * 基线记录，也是「默认值不会误伤真实样本」的回归保护。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CanvasCommand } from "@woohaa3/contracts";
import { DEFAULT_CANVAS_STORAGE_LIMITS } from "./index.js";
import { parseCanvasAggregate, type StoredAsset } from "@woohaa3/contracts";

const FIXTURES_DIR = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const NOW = "2026-09-23T00:00:00.000Z";

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}/${name}`, "utf8"));
}

/** 构造一个「典型大型画布」：100 个节点、99 条边、100 个图片资产。 */
function buildLargeCanvas() {
  const nodes = Array.from({ length: 100 }, (_, index) => ({
    id: `node-${index}`,
    type: index % 2 === 0 ? "image" : "text",
    position: { x: (index % 10) * 320, y: Math.floor(index / 10) * 240 },
    width: 260,
    height: 195,
    zIndex: index + 1
  }));
  const edges = Array.from({ length: 99 }, (_, index) => ({
    id: `edge-${index}`,
    source: `node-${index}`,
    target: `node-${index + 1}`,
    sourceHandle: "out-0",
    targetHandle: "in-0",
    data: { kind: "dependency" }
  }));
  const assets = Array.from({ length: 100 }, (_, index) => ({
    id: `asset-${index}`,
    nodeId: `node-${index}`,
    title: `生成结果 ${index}`,
    mediaKind: "image",
    source: "generated",
    status: "ready",
    url: `/api/media/sha256-${"a".repeat(64)}`,
    createdAt: NOW,
    metadata: {
      storageKey: `sha256-${"a".repeat(64)}`,
      checksum: "a".repeat(64),
      contentType: "image/png",
      size: 100_000
    }
  }));
  const nodeData = Object.fromEntries(
    nodes.filter((node) => node.type === "image").map((node) => [node.id, {
      title: `节点 ${node.id}`,
      panelPrompt: "一段用于测量大小的提示词，重复出现以接近真实文本长度。".repeat(3),
      taskStatus: "successed",
      outputAssetId: `asset-${node.id.split("-")[1]}`
    }])
  );
  return {
    id: "canvas-large",
    title: "大型画布基线",
    revision: 500,
    document: { schemaVersion: "asset-canvas-v1", nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: NOW },
    nodeData,
    assets,
    jobs: [],
    updatedAt: NOW
  };
}

const baseline = {
  emptyJsonBytes: 0,
  cosAssetJsonBytes: 0,
  largeJsonBytes: 0,
  largeCommandCount: 0,
  largeCommandJsonBytes: 0,
  largeAssetCount: 0
};

describe("限制基线（任务 1.4）", () => {
  it("测量并断言真实样本远低于默认限制", () => {
    const empty = parseCanvasAggregate(loadFixture("empty-canvas.json"), { now: NOW });
    const cos = parseCanvasAggregate(loadFixture("canvas-with-cos-asset.json"), { now: NOW });
    const large = parseCanvasAggregate(buildLargeCanvas(), { now: NOW });
    expect(empty.ok && cos.ok && large.ok).toBe(true);
    if (!empty.ok || !cos.ok || !large.ok) return;

    baseline.emptyJsonBytes = jsonBytes(empty.canvas);
    baseline.cosAssetJsonBytes = jsonBytes(cos.canvas);
    baseline.largeJsonBytes = jsonBytes(large.canvas);
    baseline.largeAssetCount = large.canvas.assets.length;

    // 典型大型画布命令批次：创建 10 个节点 + 10 条边 + 10 个资产。
    const commands: CanvasCommand[] = [
      ...Array.from({ length: 10 }, (_, index) => ({
        type: "node.add" as const,
        node: { id: `new-${index}`, type: "image", position: { x: index * 10, y: 0 } } as never,
        nodeData: { panelPrompt: "x".repeat(200) } as never
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        type: "asset.upsert" as const,
        asset: {
          id: `new-asset-${index}`,
          title: "n",
          mediaKind: "image",
          source: "generated",
          status: "ready",
          createdAt: NOW,
          metadata: {
            storageKey: `generation-outputs/${"b".repeat(64)}.png`,
            checksum: "b".repeat(64),
            contentType: "image/png",
            size: 200_000
          }
        } satisfies StoredAsset
      }))
    ];
    baseline.largeCommandCount = commands.length;
    baseline.largeCommandJsonBytes = jsonBytes(commands);

    // 记录基线（供 notes/limits-baseline.md 使用）并断言余量。
    for (const bytes of [baseline.largeJsonBytes, baseline.largeCommandJsonBytes]) {
      expect(bytes).toBeLessThan(DEFAULT_CANVAS_STORAGE_LIMITS.maxCanvasJsonBytes);
    }
    expect(baseline.largeCommandCount).toBeLessThan(DEFAULT_CANVAS_STORAGE_LIMITS.maxCommands);
  });

  it("暴露基线数值供人工核对", () => {
    // 这些值随样本变化；测试只确保它们已被测量且为正。
    expect(baseline.largeJsonBytes).toBeGreaterThan(0);
    expect(baseline.largeCommandJsonBytes).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.info("[limits-baseline]", JSON.stringify(baseline));
  });
});
