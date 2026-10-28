/**
 * 产物新鲜度检查：`pnpm dev --skip-build` 之前必须能发现「src 比 dist 新」。
 *
 * 回归：新增 result-archive.ts 后 dist 只含调用点、不含定义，--skip-build 重启直接
 * ReferenceError；这里钉住判定规则（测试文件不算、缺产物不算）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findStaleArtifacts, formatStaleArtifacts, newestSource } from "./artifact-freshness.mjs";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-fresh-"));
  const write = (relative, content = "x") => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const touch = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));
  const pkg = (relative) => write(path.join(relative, "package.json"), "{}");
  return { root, write, touch, pkg };
}

test("src 比 dist 新 → 报过期", () => {
  const ws = workspace();
  ws.pkg("web/services/demo");
  const source = ws.write("web/services/demo/src/index.ts");
  const artifact = ws.write("web/services/demo/dist/index.js");
  ws.touch(source, 2_000_000_000_000);
  ws.touch(artifact, 1_000_000_000_000);

  const stale = findStaleArtifacts(ws.root);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].name, path.join("web/services", "demo"));
  assert.equal(stale[0].artifact, path.join("web/services", "demo", "dist", "index.js"));
  assert.match(formatStaleArtifacts(stale), /demo/);
});

test("dist 比 src 新 → 不报", () => {
  const ws = workspace();
  ws.pkg("web/services/demo");
  const source = ws.write("web/services/demo/src/index.ts");
  const artifact = ws.write("web/services/demo/dist/index.js");
  ws.touch(source, 1_000_000_000_000);
  ws.touch(artifact, 2_000_000_000_000);
  assert.deepEqual(findStaleArtifacts(ws.root), []);
});

test("改测试文件不算过期", () => {
  const ws = workspace();
  ws.pkg("web/services/demo");
  const impl = ws.write("web/services/demo/src/index.ts");
  const testFile = ws.write("web/services/demo/src/index.test.ts");
  const artifact = ws.write("web/services/demo/dist/index.js");
  ws.touch(impl, 1_000_000_000_000);
  ws.touch(testFile, 3_000_000_000_000);
  ws.touch(artifact, 2_000_000_000_000);

  // 测试文件更新（3e12）也不该把 artifact（2e12）判成过期。
  assert.deepEqual(findStaleArtifacts(ws.root), []);
  assert.equal(newestSource(path.join(ws.root, "web/services/demo/src")).file, "index.ts");
});

test("没有产物 → 不参与判定（交给启动时的缺产物提示）", () => {
  const ws = workspace();
  ws.pkg("web/services/demo");
  ws.write("web/services/demo/src/index.ts");
  assert.deepEqual(findStaleArtifacts(ws.root), []);
});

test("server-dist 与 dist 各自判定", () => {
  const ws = workspace();
  ws.pkg("web/backend");
  const source = ws.write("web/backend/src/server.ts");
  const bundle = ws.write("web/backend/dist/index.js");
  const server = ws.write("web/backend/server-dist/index.js");
  ws.touch(source, 2_000_000_000_000);
  ws.touch(bundle, 1_000_000_000_000);
  ws.touch(server, 1_000_000_000_000);

  const stale = findStaleArtifacts(ws.root);
  assert.equal(stale.length, 2);
  assert.deepEqual(
    stale.map((entry) => path.basename(entry.artifact)).sort(),
    ["index.js", "index.js"]
  );
  assert.deepEqual(
    stale.map((entry) => path.dirname(entry.artifact)).sort(),
    [path.join("web/backend", "dist"), path.join("web/backend", "server-dist")].sort()
  );
});
