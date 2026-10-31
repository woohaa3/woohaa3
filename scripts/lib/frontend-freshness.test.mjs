/**
 * 打包前的「前端产物过期」检查。
 *
 * 回归：修好的扩展重建了 browser-dist，却没重新 assemble:extensions，
 * 打出来的 exe 里跑的还是旧代码 —— 界面照旧报错，而源码与测试全是好的。
 * 这里钉住三层判定：前端源码 → dist、扩展源码 → browser-dist、扩展产物 → dist。
 *
 * 时间戳用 2023-11 起的整日递增，**不要用 `2_000_000_000_000` 这样的大数**：
 * Windows 的 `fs.utimes` 秒数是 32 位，超过 2^32 秒（2106 年）会回绕成 1992 年，
 * 判定结果与写的值完全对不上（踩过）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findStaleFrontend, formatStaleFrontend, newestFile } from "./frontend-freshness.mjs";

const DAY = 86_400_000;
/** 基准时刻，逐日递增，全部远低于 Windows utimes 的 32 位秒上限。 */
const BASE = 1_700_000_000_000;
const at = (days) => BASE + days * DAY;

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-frontend-fresh-"));
  const write = (relative, content = "x") => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const touch = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));
  const pkg = (relative) => write(path.join(relative, "package.json"), "{}");
  /** 一套「已组装好」的基准：前端 dist 与扩展产物都比各自的源码新。 */
  const built = () => {
    const source = write("web/frontend/src/app.tsx");
    const dist = write("web/frontend/dist/index.html");
    pkg("web/extensions/demo");
    const extSource = write("web/extensions/demo/src/index.ts");
    const manifest = write("web/extensions/demo/browser-dist/artifact-manifest.json");
    touch(source, at(0));
    touch(extSource, at(0));
    touch(manifest, at(1));
    touch(dist, at(2));
    return { source, dist, extSource, manifest };
  };
  return { root, write, touch, pkg, built };
}

test("都构建过 → 不报过期", () => {
  const ws = workspace();
  ws.built();
  assert.deepEqual(findStaleFrontend(ws.root), []);
});

test("前端源码比 dist 新 → 报过期", () => {
  const ws = workspace();
  const { source } = ws.built();
  ws.touch(source, at(3));

  const stale = findStaleFrontend(ws.root);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].artifact, path.join("web", "frontend", "dist", "index.html"));
  assert.equal(stale[0].source, path.join("web", "frontend", "src", "app.tsx"));
  assert.match(formatStaleFrontend(stale), /index\.html/);
});

test("扩展源码比 browser-dist 新 → 报过期", () => {
  const ws = workspace();
  const { extSource } = ws.built();
  ws.touch(extSource, at(3));

  const stale = findStaleFrontend(ws.root);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].artifact, path.join("web", "extensions", "demo", "browser-dist", "artifact-manifest.json"));
  assert.equal(stale[0].source, path.join("web", "extensions", "demo", "src", "index.ts"));
});

test("扩展重建了但没重新组装 → 报过期", () => {
  // 这正是打 exe 时踩到的形态：browser-dist 更新了，dist 没动。
  const ws = workspace();
  const { manifest } = ws.built();
  ws.touch(manifest, at(3));

  const stale = findStaleFrontend(ws.root);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].artifact, path.join("web", "frontend", "dist", "index.html"));
  assert.equal(stale[0].source, path.join("web", "extensions", "demo", "browser-dist", "artifact-manifest.json"));
});

test("容差内不算过期（构建与写盘有毫秒级抖动）", () => {
  const ws = workspace();
  const { source } = ws.built();
  // 源码只比产物新 500ms，落在默认 1s 容差里。
  ws.touch(source, at(2) + 500);
  assert.deepEqual(findStaleFrontend(ws.root), []);
  // 调小容差就报。
  assert.equal(findStaleFrontend(ws.root, { toleranceMs: 100 }).length, 1);
});

test("没有 dist → 不参与判定（缺产物由 assertFrontend 报）", () => {
  const ws = workspace();
  const source = ws.write("web/frontend/src/app.tsx");
  ws.touch(source, at(1));
  assert.deepEqual(findStaleFrontend(ws.root), []);
});

test("改测试文件不算过期", () => {
  const ws = workspace();
  ws.built();
  const testFile = ws.write("web/frontend/src/app.test.tsx");
  ws.touch(testFile, at(5));
  assert.deepEqual(findStaleFrontend(ws.root), []);
  assert.equal(path.basename(newestFile(path.join(ws.root, "web/frontend/src")).file), "app.tsx");
});

test("没有 browser-dist 的扩展不参与判定", () => {
  const ws = workspace();
  ws.built();
  // 只有源码、还没构建过的扩展：不该因为它的源码新就拦住打包。
  ws.pkg("web/extensions/never-built");
  const source = ws.write("web/extensions/never-built/src/index.ts");
  ws.touch(source, at(6));
  assert.deepEqual(findStaleFrontend(ws.root), []);
});
