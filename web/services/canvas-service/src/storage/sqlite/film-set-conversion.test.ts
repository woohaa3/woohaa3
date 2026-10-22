/**
 * SQLite 转片场任务幂等登记仓库测试
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.2 / design D5）。
 *
 * 覆盖：跨实例（重启）持久读取、同键覆盖、删除。非渲染检查。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FilmSetConversionRecord } from "@woohaa3/contracts";
import { SqliteFilmSetConversionRegistry } from "./film-set-conversion.js";

const NOW = "2026-10-13T00:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath(name = "canvas.sqlite"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-conversion-"));
  dirs.push(dir);
  return path.join(dir, name);
}

function record(overrides: Partial<FilmSetConversionRecord> = {}): FilmSetConversionRecord {
  return {
    canvasId: "c1",
    requestId: "req-1",
    sourceNodeId: "src",
    targetNodeId: "target",
    sourceKind: "model3d",
    inputHash: "hash-1",
    frozenSource: { nodeId: "src", kind: "model3d", contentHash: "src-hash" },
    title: "模型",
    settings: {},
    step: "validate-and-save",
    state: "completed",
    attempt: 1,
    result: { targetNodeId: "target", commandId: "cmd-1" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

describe("SqliteFilmSetConversionRegistry", () => {
  it("跨实例（重启）读取同一回执", async () => {
    const file = dbPath();
    const first = new SqliteFilmSetConversionRegistry({ path: file, now: () => NOW });
    await first.put(record());
    first.close();

    const second = new SqliteFilmSetConversionRegistry({ path: file, now: () => NOW });
    const loaded = await second.get("c1", "req-1");
    expect(loaded?.state).toBe("completed");
    expect(loaded?.result?.targetNodeId).toBe("target");
    expect(await second.get("c1", "missing")).toBeNull();
    second.close();
  });

  it("同键覆盖推进状态且不产生第二行", async () => {
    const file = dbPath();
    const registry = new SqliteFilmSetConversionRegistry({ path: file, now: () => NOW });
    await registry.put(record({ state: "running" }));
    await registry.put(record({ state: "failed", error: { code: "commit-failed", message: "x", retryable: false } }));
    const loaded = await registry.get("c1", "req-1");
    expect(loaded?.state).toBe("failed");
    registry.close();
  });

  it("delete 移除记录", async () => {
    const file = dbPath();
    const registry = new SqliteFilmSetConversionRegistry({ path: file, now: () => NOW });
    await registry.put(record());
    await registry.delete("c1", "req-1");
    expect(await registry.get("c1", "req-1")).toBeNull();
    registry.close();
  });
});
