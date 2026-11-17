/**
 * Fixture 卫生与依赖边界（任务 1.3 / 1.6）。
 *
 * 1.3：所有 fixture 必须先通过 domain parser，且规范化后是纯 JSON（无 Blob/base64/签名 URL）。
 * 1.6：包只依赖中立边界与 Yjs 生态；不得把 yjs/服务端依赖内联进产物，也不得依赖
 *      具体数据库、COS SDK、HTTP 框架或浏览器运行时。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCanvasAggregate } from "../domain/index.js";
import { ALL_FIXTURES, FIXTURE_NOW } from "./__fixtures__/canvases.js";

const PACKAGE_DIR = fileURLToPath(new URL("../../..", import.meta.url));

describe("Yjs fixtures 通过 domain parser（任务 1.3）", () => {
  for (const { name, build } of ALL_FIXTURES) {
    it(`${name} 规范化成功且为纯 JSON`, () => {
      const parsed = parseCanvasAggregate(build(), { now: FIXTURE_NOW });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const json = JSON.stringify(parsed.canvas);
      expect(json).not.toContain("base64");
      expect(json).not.toContain("data:");
      expect(json).not.toContain("blob:");
      expect(json).not.toContain("X-Amz-Signature");
      // revision / 结构字段保留。
      expect(typeof parsed.canvas.revision).toBe("number");
    });
  }

  it("覆盖空/完整图/资产任务/运行态/COS 引用五类样本", () => {
    expect(ALL_FIXTURES.map((entry) => entry.name)).toEqual([
      "empty",
      "full-graph",
      "assets-jobs",
      "task-run-state",
      "uploaded-asset"
    ]);
  });

  it("资产 fixture 的 storageKey 是稳定引用而非 URL", () => {
    const parsed = parseCanvasAggregate(ALL_FIXTURES[2].build(), { now: FIXTURE_NOW });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const metadata = parsed.canvas.assets[0].metadata as Record<string, unknown>;
    expect(String(metadata.storageKey)).not.toMatch(/^https?:/);
  });
});

describe("包依赖边界（任务 1.6；change: split-web-runtime-services 后并入 contracts）", () => {
  it("contracts/canvas-yjs 线格式 codec 不引入数据库/COS/HTTP/浏览器框架", () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));
    // 迁移后共享 codec 归属 `@woohaa3/contracts`；其 canvas-yjs 子路径只依赖 Yjs 生态。
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "lib0",
      "yjs"
    ]);
    for (const forbidden of ["mongodb", "cos-nodejs-sdk-v5", "@woohaa3/canvas-service", "express", "ws", "react"]) {
      expect(manifest.dependencies?.[forbidden], forbidden).toBeUndefined();
    }
  });

  it("构建产物把 yjs/lib0 保留为 external，未内联", () => {
    const distPath = path.join(PACKAGE_DIR, "dist", "canvas-yjs", "index.js");
    if (!existsSync(distPath)) return;
    const bundle = readFileSync(distPath, "utf8");
    expect(bundle).not.toContain("node:sqlite");
    expect(bundle).not.toContain("mongodb");
    expect(bundle).not.toContain("cos-nodejs-sdk-v5");
    // 产物体积应远小于 yjs 本体（说明未内联 yjs/lib0 实现）。
    // 阈值随包功能增长而上调；yjs + lib0 内联会是数 MB 级。
    expect(bundle.length).toBeLessThan(300_000);
    // 直接证据：产物里 import 了外部依赖，而不是内联。
    expect(bundle).toMatch(/from "yjs"/);
    expect(bundle).toMatch(/from "lib0\//);
    // 体积阈值只能发现「整体爆掉」，发现不了「只多带了一份大常量」。SOMA v1/v2 人体网格
    // 是十几 MB 的 base64 常量，`sideEffects: false` 一旦丢失就会重新被当成有副作用模块整份内联
    // （2026-11-16 现场：11 个扩展各自内联 17MB contracts，web host payload 92MB → 405MB，
    // SEA 注入直接失败）。网格的 base64 都以 `mREAACkAAAD` 开头，点名它比只看体积更准：
    // 清单/manifest 文字仍可按需进入产物，真正不该来的是那几 MB 顶点数据。
    expect(bundle).not.toContain("mREAACkAAAD");
  });
});
