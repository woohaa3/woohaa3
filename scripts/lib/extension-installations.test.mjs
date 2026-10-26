/**
 * 受管安装记录单测（change: 2026-10-21-add-extension-marketplace-point，任务 4.2）。
 *
 * 运行：`node --test scripts/lib/extension-installations.test.mjs`
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_MANAGED_DIR,
  INSTALLATION_HISTORY_LIMIT,
  MANAGED_DIR_ENV,
  appendHistory,
  listOrphanVersionDirs,
  managedLayout,
  openInstallations,
  readInstallations,
  resolveManagedRoot
} from "./extension-installations.mjs";

function managedRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-managed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const record = (current, extra = {}) => ({ current, previous: null, sourceId: "local-file", state: "active", history: [], ...extra });

test("resolveManagedRoot：环境变量优先，缺省为仓库根下 .woohaa3/extensions", () => {
  assert.equal(resolveManagedRoot({ repoRoot: "/repo", env: {} }), path.resolve("/repo", DEFAULT_MANAGED_DIR));
  assert.equal(resolveManagedRoot({ repoRoot: "/repo", env: { [MANAGED_DIR_ENV]: "/data/managed" } }), "/data/managed");
});

test("versionDir 拒绝路径穿越与非法 id", () => {
  const layout = managedLayout("/m");
  assert.equal(layout.versionDir("foo", "1.2.0"), path.join("/m", "installed", "foo", "1.2.0"));
  for (const [id, version] of [["../x", "1.0.0"], ["foo", "../../etc"], ["foo", "1..0"], ["Foo", "1.0.0"], ["foo", "a/b"]]) {
    assert.throws(() => layout.versionDir(id, version), (error) => error.code === "MARKETPLACE_INSTALLATIONS_CORRUPT");
  }
});

test("不存在的受管根读出空状态；commit 推进 revision 并原子写入", (t) => {
  const root = managedRoot(t);
  assert.deepEqual(readInstallations(root).state.extensions, {});
  const handle = openInstallations({ managedRoot: root });
  t.after(() => handle.release());
  assert.equal(handle.read().revision, 0);
  const next = handle.commit((state) => {
    state.extensions.foo = record("1.0.0");
  }, { expectedRevision: 0 });
  assert.equal(next.revision, 1);
  assert.equal(readInstallations(root).state.extensions.foo.current, "1.0.0");
  // 写入后没有遗留 tmp 文件。
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes(".tmp-")), []);
  // 返回新对象也可以。
  const again = handle.commit((state) => ({ ...state, extensions: { ...state.extensions, bar: record("2.0.0") } }), { expectedRevision: 1 });
  assert.equal(again.revision, 2);
});

test("内容不变的 commit 不写盘、不推进 revision", (t) => {
  const root = managedRoot(t);
  const handle = openInstallations({ managedRoot: root });
  t.after(() => handle.release());
  handle.commit((state) => { state.extensions.foo = record("1.0.0"); }, { expectedRevision: 0 });
  const same = handle.commit(() => undefined, { expectedRevision: 1 });
  assert.equal(same.revision, 1);
});

test("expectedRevision 过期：MARKETPLACE_REVISION_CONFLICT，记录不变", (t) => {
  const root = managedRoot(t);
  const handle = openInstallations({ managedRoot: root });
  t.after(() => handle.release());
  handle.commit((state) => { state.extensions.foo = record("1.0.0"); }, { expectedRevision: 0 });
  assert.throws(
    () => handle.commit((state) => { state.extensions.foo = record("9.9.9"); }, { expectedRevision: 0 }),
    (error) => error.code === "MARKETPLACE_REVISION_CONFLICT" && error.currentRevision === 1
  );
  assert.equal(readInstallations(root).state.extensions.foo.current, "1.0.0");
});

test("mutator 抛错或产出无效记录：不提交", (t) => {
  const root = managedRoot(t);
  const handle = openInstallations({ managedRoot: root });
  t.after(() => handle.release());
  assert.throws(() => handle.commit(() => { throw new Error("boom"); }, { expectedRevision: 0 }), /boom/);
  assert.throws(
    () => handle.commit((state) => { state.extensions.foo = { current: "../evil", sourceId: "x" }; }, { expectedRevision: 0 }),
    (error) => error.code === "MARKETPLACE_INSTALLATIONS_CORRUPT"
  );
  assert.equal(fs.existsSync(managedLayout(root).installationsFile), false);
});

test("损坏的 installations.json：只读路径降级为空并告警，写入路径拒绝提交", (t) => {
  const root = managedRoot(t);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(managedLayout(root).installationsFile, "{ not json");
  const read = readInstallations(root);
  assert.deepEqual(read.state.extensions, {});
  assert.equal(read.warnings.length, 1);
  const handle = openInstallations({ managedRoot: root });
  t.after(() => handle.release());
  assert.throws(() => handle.read(), (error) => error.code === "MARKETPLACE_INSTALLATIONS_CORRUPT");
  assert.throws(() => handle.commit(() => undefined, { expectedRevision: 0 }), (error) => error.code === "MARKETPLACE_INSTALLATIONS_CORRUPT");
  // 现场保留，不被覆盖。
  assert.equal(fs.readFileSync(managedLayout(root).installationsFile, "utf8"), "{ not json");
});

test("history 截断到最近 50 条", () => {
  let current = { current: "1.0.0" };
  for (let index = 0; index < INSTALLATION_HISTORY_LIMIT + 7; index += 1) current = appendHistory(current, { revision: index });
  assert.equal(current.history.length, INSTALLATION_HISTORY_LIMIT);
  assert.equal(current.history[0].revision, 7);
});

test("排他锁：存活进程持有时第二个写入者被拒绝；释放后可再次获取", async (t) => {
  const root = managedRoot(t);
  const layout = managedLayout(root);
  fs.mkdirSync(root, { recursive: true });
  // 用一个存活的子进程模拟另一个宿主持有锁。
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  fs.writeFileSync(layout.lockFile, JSON.stringify({ pid: child.pid, owner: "other" }));
  assert.throws(() => openInstallations({ managedRoot: root }), (error) => error.code === "MARKETPLACE_WRITER_LOCKED" && error.holderPid === child.pid);
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  // 持有者已退出：陈旧锁被接管。
  const handle = openInstallations({ managedRoot: root });
  assert.equal(JSON.parse(fs.readFileSync(layout.lockFile, "utf8")).pid, process.pid);
  handle.release();
  assert.equal(fs.existsSync(layout.lockFile), false);
  assert.throws(() => handle.read(), (error) => error.code === "MARKETPLACE_WRITER_LOCKED");
});

test("clearStaging 清空暂存区；listOrphanVersionDirs 只列未被 current/previous 引用的版本", (t) => {
  const root = managedRoot(t);
  const handle = openInstallations({ managedRoot: root });
  t.after(() => handle.release());
  const layout = handle.layout;
  fs.mkdirSync(path.join(layout.stagingDir, "job-1", "tree"), { recursive: true });
  handle.clearStaging();
  assert.deepEqual(fs.readdirSync(layout.stagingDir), []);
  for (const version of ["1.0.0", "1.1.0", "1.2.0"]) fs.mkdirSync(layout.versionDir("foo", version), { recursive: true });
  fs.mkdirSync(layout.versionDir("ghost", "0.1.0"), { recursive: true });
  const state = handle.commit((draft) => { draft.extensions.foo = record("1.2.0", { previous: "1.1.0" }); }, { expectedRevision: 0 });
  const orphans = listOrphanVersionDirs(root, state).map((entry) => `${entry.extensionId}@${entry.version}`).sort();
  assert.deepEqual(orphans, ["foo@1.0.0", "ghost@0.1.0"]);
});
