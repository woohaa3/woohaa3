/**
 * C01–C03 只读兼容盘点测试
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，任务 6.1）。
 *
 * 断言纯函数盘点的分类与「确定旧默认 vs 未覆盖」判定；并验证真实 SQLite 库路径只读扫描
 * （干跑：不修改任何记录）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerCanvas } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import {
  inventoryCanvas,
  inventoryNodeHistoryPayload,
  summarizeCompatInventory
} from "./compat-inventory.js";

function canvasWith(
  node: { id: string; type: string; width?: number; height?: number },
  data: Record<string, unknown>
): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-c", "t");
  return {
    ...canvas,
    document: {
      ...canvas.document,
      nodes: [
        {
          id: node.id,
          type: node.type,
          position: { x: 0, y: 0 },
          ...(node.width !== undefined ? { width: node.width } : {}),
          ...(node.height !== undefined ? { height: node.height } : {})
        }
      ]
    },
    nodeData: { [node.id]: data }
  } as ServerCanvas;
}

describe("inventoryCanvas", () => {
  it("C01：恰好 196×64 片场是确定旧默认", () => {
    const findings = inventoryCanvas(canvasWith({ id: "a", type: "animation3d", width: 196, height: 64 }, {}));
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "C01", code: "film-set-legacy-compact", confirmedLegacy: true })
    );
  });

  it("C01：非默认片场尺寸报告为未覆盖（无法区分人工 resize）", () => {
    const findings = inventoryCanvas(canvasWith({ id: "a", type: "animation3d", width: 400, height: 300 }, {}));
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "C01", code: "film-set-non-default-size", confirmedLegacy: false })
    );
  });

  it("C02：缺 aspect 的镜头与初始镜头是确定旧记录", () => {
    const findings = inventoryCanvas(
      canvasWith({ id: "m", type: "model3d" }, {
        modelCameras: [{ id: "c1", name: "n", order: 0, azimuth: 0, elevation: 0.7, distance: 5 }],
        initialCamera: { azimuth: 0, elevation: 0.7, distance: 5, focusOffset: { x: 0, y: 0, z: 0 } }
      })
    );
    expect(findings.filter((f) => f.category === "C02")).toHaveLength(2);
    expect(findings.every((f) => f.confirmedLegacy)).toBe(true);
  });

  it("C02：合法 aspect 不产生 finding", () => {
    const findings = inventoryCanvas(
      canvasWith({ id: "m", type: "model3d" }, {
        modelCameras: [{ id: "c1", name: "n", order: 0, azimuth: 0, elevation: 0.7, distance: 5, aspect: "16:9" }]
      })
    );
    expect(findings).toEqual([]);
  });

  it("C03：缺 schemaVersion/items 按 schema 1 / 空集合读取（不升级为 2）", () => {
    const findings = inventoryCanvas(canvasWith({ id: "a", type: "animation3d" }, { filmSetContent: {} }));
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "C03", code: "film-set-missing-schema-version", confirmedLegacy: true })
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "C03", code: "film-set-missing-items", confirmedLegacy: true })
    );
  });
});

describe("inventoryNodeHistoryPayload", () => {
  it("历史模型镜头缺 aspect 报告为确定旧记录", () => {
    const findings = inventoryNodeHistoryPayload({
      canvasId: "c",
      nodeId: "n",
      entryId: "e",
      payload: { kind: "model", modelCameras: [{ id: "c1", name: "n", order: 0, azimuth: 0, elevation: 0.7, distance: 5 }] }
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "C02", code: "history-model-camera-missing-aspect", confirmedLegacy: true })
    );
  });

  it("历史动画初始镜头缺 aspect 报告为确定旧记录", () => {
    const findings = inventoryNodeHistoryPayload({
      canvasId: "c",
      nodeId: "n",
      entryId: "e",
      payload: { kind: "model", animation: { initialCamera: { azimuth: 0, elevation: 0.7, distance: 5 } } }
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "C02", code: "history-initial-camera-missing-aspect", confirmedLegacy: true })
    );
  });

  it("非对象 payload 不产生 finding", () => {
    expect(inventoryNodeHistoryPayload({ canvasId: "c", nodeId: "n", entryId: "e", payload: null })).toEqual([]);
  });
});

describe("summarizeCompatInventory", () => {
  it("按类别分解 total/confirmed/unconfirmed", () => {
    const report = summarizeCompatInventory([
      { category: "C01", location: "a", code: "x", confirmedLegacy: true },
      { category: "C01", location: "b", code: "y", confirmedLegacy: false },
      { category: "C02", location: "c", code: "z", confirmedLegacy: true }
    ]);
    expect(report.counts.C01).toEqual({ total: 2, confirmed: 1, unconfirmed: 1 });
    expect(report.counts.C02).toEqual({ total: 1, confirmed: 1, unconfirmed: 0 });
    expect(report.counts.C03).toEqual({ total: 0, confirmed: 0, unconfirmed: 0 });
  });
});

describe("SQLite 只读干跑（不写入）", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("读取 canvases 行且不修改记录", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "compat-"));
    dirs.push(dir);
    const file = path.join(dir, "canvas.db");
    const { SqliteCanvasRepository } = await import("../sqlite/index.js");
    const repository = new SqliteCanvasRepository({ path: file });
    const canvas = canvasWith({ id: "a", type: "animation3d", width: 196, height: 64 }, {});
    await repository.createCanvas(canvas);
    const before = await repository.getCanvas("a");
    repository.close();

    const { loadNodeSqlite } = await import("../sqlite/sqlite-loader.js");
    const sqlite = loadNodeSqlite();
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT canvas_json FROM canvases").all();
    const findings = rows.flatMap((row) => inventoryCanvas(JSON.parse(String(row.canvas_json))));
    db.close();

    expect(findings.some((f) => f.code === "film-set-legacy-compact")).toBe(true);
    const verify = new SqliteCanvasRepository({ path: file });
    expect(await verify.getCanvas("a")).toEqual(before);
    verify.close();
  });
});
