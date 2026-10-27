/**
 * 运行：`node --test scripts/lib/dev-host-watch.test.mjs`
 *
 * 覆盖宿主 watch 的定位规则（哪些文件触发、触发哪个包的哪些脚本）、重建队列的合并/串行
 * 语义，以及监听 wiring（用注入的假 watcher，不依赖 inotify 时序）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createRebuildQueue,
  resolveHostWatchRoots,
  resolveWatchTarget,
  startHostWatch
} from "./dev-host-watch.mjs";

/** 造一个最小工作区：固定根 + 扩展根 + 各类包脚本组合。 */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-dev-watch-"));
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const pkg = (relative, manifest) => write(relative, JSON.stringify(manifest));
  write("extensions.config.json", JSON.stringify({ schemaVersion: 1, roots: ["web/extensions", "extensions"] }));
  pkg("web/backend/package.json", { name: "@woohaa3/backend", scripts: { build: "x", "server:build": "y" } });
  write("web/backend/src/server.ts", "export {};");
  pkg("web/services/canvas-service/package.json", { name: "@woohaa3/canvas-service", scripts: { build: "x", "server:build": "y" } });
  write("web/services/canvas-service/src/index.ts", "export {};");
  pkg("web/contracts/package.json", { name: "@woohaa3/contracts", scripts: { build: "x" } });
  write("web/contracts/src/index.ts", "export {};");
  pkg("web/vendor/pptask/package.json", { name: "@sdppp/pptask", scripts: { build: "x" } });
  write("web/vendor/pptask/src/index.ts", "export {};");
  pkg("extensions/sample-provider/package.json", {
    name: "@woohaa3/extension-sample-provider",
    scripts: { build: "x", "build:browser": "z" }
  });
  write("extensions/sample-provider/src/backend.ts", "export {};");
  pkg("web/extensions/prompt-snippets/package.json", { name: "@woohaa3/extension-prompt-snippets", scripts: { build: "x" } });
  write("web/extensions/prompt-snippets/src/frontend/index.ts", "export {};");
  pkg("web/extensions/.disabled-ext/package.json", { name: "@woohaa3/extension-disabled", scripts: { build: "x" } });
  write("web/extensions/.disabled-ext/src/index.ts", "export {};");
  pkg("web/frontend/package.json", { name: "@woohaa3/frontend", scripts: { build: "vite build" } });
  write("web/frontend/src/main.tsx", "export {};");
  return { root, write, pkg };
}

function targetFor(repo, relative) {
  return resolveWatchTarget({
    repoRoot: repo.root,
    backendDir: path.join(repo.root, "web/backend"),
    file: path.join(repo.root, relative),
    watchRoots: resolveHostWatchRoots({ repoRoot: repo.root, env: {} })
  });
}

test("监听根包含固定宿主根与配置声明的扩展根，且只返回存在的目录", () => {
  const repo = makeRepo();
  const roots = resolveHostWatchRoots({ repoRoot: repo.root, env: {} }).map((dir) => path.relative(repo.root, dir).split(path.sep).join("/"));
  assert.deepEqual(roots, ["web/backend", "web/contracts", "web/services", "web/vendor", "web/extensions", "extensions"]);
});

test("统一后端：build + server:build（dev 跑的就是它的 server-dist）", () => {
  const repo = makeRepo();
  const target = targetFor(repo, "web/backend/src/server.ts");
  assert.equal(target.name, "@woohaa3/backend");
  assert.deepEqual(target.steps, [
    { scope: "package", script: "build" },
    { scope: "package", script: "server:build" }
  ]);
});

test("服务包只跑 build：dev 不执行服务包的 server-dist", () => {
  const repo = makeRepo();
  const target = targetFor(repo, "web/services/canvas-service/src/index.ts");
  assert.equal(target.name, "@woohaa3/canvas-service");
  assert.deepEqual(target.steps, [{ scope: "package", script: "build" }]);
});

test("扩展：有 browser 入口时串联 build:browser + assemble:extensions", () => {
  const repo = makeRepo();
  const target = targetFor(repo, "extensions/sample-provider/src/backend.ts");
  assert.deepEqual(target.steps, [
    { scope: "package", script: "build" },
    { scope: "package", script: "build:browser" },
    { scope: "workspace", script: "assemble:extensions" }
  ]);

  const noBrowser = targetFor(repo, "web/extensions/prompt-snippets/src/frontend/index.ts");
  assert.deepEqual(noBrowser.steps, [{ scope: "package", script: "build" }]);
});

test("扩展：dev 模式（assemble:false）只构建 browser 产物，不装配 dist", () => {
  const repo = makeRepo();
  const target = resolveWatchTarget({
    repoRoot: repo.root,
    backendDir: path.join(repo.root, "web/backend"),
    file: path.join(repo.root, "extensions/sample-provider/src/backend.ts"),
    watchRoots: resolveHostWatchRoots({ repoRoot: repo.root, env: {} }),
    assemble: false
  });
  // dev 从不构建 web/frontend/dist，装配必然以「宿主构建产物不存在」失败；
  // 失败会中断后续步骤，扩展改动永远进不去。
  assert.deepEqual(target.steps, [
    { scope: "package", script: "build" },
    { scope: "package", script: "build:browser" }
  ]);
});

test("package.json 变化同样触发该包重建", () => {
  const repo = makeRepo();
  assert.equal(targetFor(repo, "web/services/canvas-service/package.json").name, "@woohaa3/canvas-service");
});

test("非宿主路径不触发：前端源码、产物、依赖、测试文件、隐藏扩展、非源码文件", () => {
  const repo = makeRepo();
  for (const relative of [
    "web/frontend/src/main.tsx",
    "web/services/canvas-service/dist/index.js",
    "web/services/canvas-service/node_modules/x/index.js",
    "web/backend/src/server.test.ts",
    "web/extensions/.disabled-ext/src/index.ts",
    "extensions/sample-provider/README.md",
    "web/services/canvas-service/src/assets/logo.png"
  ]) {
    assert.equal(targetFor(repo, relative), null, relative);
  }
});

test("重建队列：同批次合并、构建期间的新变化排到下一轮、失败不阻断后续", async () => {
  const batches = [];
  const queue = createRebuildQueue({
    debounceMs: 5,
    log: () => {},
    runBuild: async (target) => {
      batches.push(target.key);
      if (target.key === "bad") throw new Error("boom");
    }
  });
  queue.schedule({ key: "a" });
  queue.schedule({ key: "a" });
  queue.schedule({ key: "bad" });
  queue.schedule({ key: "good" });
  await queue.idle();
  assert.deepEqual(batches, ["a", "bad", "good"]);
});

test("重建队列：构建进行中到达的变化会再跑一轮", async () => {
  const batches = [];
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const queue = createRebuildQueue({
    debounceMs: 5,
    log: () => {},
    runBuild: async (target) => {
      batches.push(target.key);
      if (batches.length === 1) await blocked;
    }
  });
  queue.schedule({ key: "a" });
  while (batches.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  queue.schedule({ key: "a" });
  release();
  await queue.idle();
  assert.deepEqual(batches, ["a", "a"]);
});

/** 假 watcher：记录创建出来的监听器，可手动投递 change/error。 */
function fakeWatch() {
  const watchers = [];
  const watch = (root, _options, listener) => {
    const watcher = {
      root,
      listener,
      handlers: {},
      closed: false,
      on(event, handler) {
        this.handlers[event] = handler;
        return this;
      },
      close() {
        this.closed = true;
      }
    };
    watchers.push(watcher);
    return watcher;
  };
  return { watch, watchers };
}

test("监听 wiring：变化文件映射到包与脚本，未知文件忽略，close 后不再调度", async () => {
  const repo = makeRepo();
  const { watch, watchers } = fakeWatch();
  const steps = [];
  const controller = startHostWatch({
    repoRoot: repo.root,
    backendDir: path.join(repo.root, "web/backend"),
    env: {},
    watch,
    debounceMs: 5,
    log: () => {},
    runStep: async (step, target) =>
      steps.push(`${step.scope === "workspace" ? "web" : target.name}:${step.script}`)
  });

  const backendWatcher = watchers.find((watcher) => watcher.root === path.join(repo.root, "web/backend"));
  assert.ok(backendWatcher, "应监听 web/backend");
  repo.write("web/backend/src/server.ts", "export const changed = true;");
  backendWatcher.listener("change", path.join("src", "server.ts"));
  const extensionWatcher = watchers.find((watcher) => watcher.root === path.join(repo.root, "extensions"));
  repo.write("extensions/sample-provider/src/backend.ts", "export const changed = true;");
  extensionWatcher.listener("change", path.join("sample-provider", "src", "backend.ts"));
  await controller.idle();
  assert.deepEqual(steps, [
    "@woohaa3/backend:build",
    "@woohaa3/backend:server:build",
    "@woohaa3/extension-sample-provider:build",
    "@woohaa3/extension-sample-provider:build:browser",
    "web:assemble:extensions"
  ]);

  steps.length = 0;
  backendWatcher.listener("change", "README.md");
  await controller.idle();
  assert.deepEqual(steps, []);

  controller.close();
  assert.ok(watchers.every((watcher) => watcher.closed));
  backendWatcher.listener("change", path.join("src", "server.ts"));
  await controller.idle();
  assert.deepEqual(steps, []);
});

test("监听不可用时只记录，不抛错", async () => {
  const repo = makeRepo();
  const events = [];
  const controller = startHostWatch({
    repoRoot: repo.root,
    backendDir: path.join(repo.root, "web/backend"),
    env: {},
    debounceMs: 5,
    runStep: async () => {},
    log: (event) => events.push(event),
    watch: () => {
      throw new Error("ENOSPC");
    }
  });
  assert.ok(events.length > 0);
  assert.equal(events[0].event, "watch-unavailable");
  controller.close();
});

test("递归监听报 ENOENT 后重建该根监听；close 后不再重建", async () => {
  const repo = makeRepo();
  const { watch, watchers } = fakeWatch();
  const steps = [];
  const controller = startHostWatch({
    repoRoot: repo.root,
    backendDir: path.join(repo.root, "web/backend"),
    env: {},
    watch,
    debounceMs: 5,
    reattachDelayMs: 1,
    log: () => {},
    runStep: async (step, target) =>
      steps.push(`${step.scope === "workspace" ? "web" : target.name}:${step.script}`)
  });

  const vendorRoot = path.join(repo.root, "web/vendor");
  const first = watchers.find((watcher) => watcher.root === vendorRoot);
  first.handlers.error(new Error("ENOENT: no such file or directory, scandir '.../dist'"));
  assert.equal(first.closed, true, "失效的监听应被关闭");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const attached = watchers.filter((watcher) => watcher.root === vendorRoot);
  assert.equal(attached.length, 2, "应重建该根的监听");

  repo.write("web/vendor/pptask/src/index.ts", "export const changed = true;");
  attached[1].listener("change", path.join("pptask", "src", "index.ts"));
  await controller.idle();
  assert.deepEqual(steps, ["@sdppp/pptask:build"]);

  controller.close();
  attached[1].handlers.error(new Error("ENOENT"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(watchers.filter((watcher) => watcher.root === vendorRoot).length, 2, "close 后不再重建");
});


test("浏览器发布装配成功后通知宿主重载目录，构建失败不通知", async () => {
  const repo = makeRepo();
  const backendDir = path.join(repo.root, "web/backend");
  const entry = path.join(backendDir, "server-dist/index.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "export {};");
  for (const fail of [false, true]) {
    fs.utimesSync(entry, 1, 1);
    const { watch, watchers } = fakeWatch();
    const controller = startHostWatch({ repoRoot: repo.root, backendDir, env: {}, watch,
      runStep: async step => { if (fail && step.script === "assemble:extensions") throw new Error("fixture"); }
    });
    repo.write("extensions/sample-provider/src/backend.ts", `export const changed = ${fail};`);
    watchers.find(w => w.root === path.join(repo.root, "extensions"))
      .listener("change", path.join("sample-provider", "src", "backend.ts"));
    await controller.idle();
    assert.equal(fs.statSync(entry).mtimeMs > 1000, !fail);
    assert.equal(fs.readFileSync(entry, "utf8"), "export {};");
    controller.close();
  }
});

test("源码内容未变的重复/时间戳通知不重建；真实修改、删除和重新创建仍可重建", async () => {
  const repo = makeRepo();
  const { watch, watchers } = fakeWatch();
  const steps = [];
  const controller = startHostWatch({ repoRoot: repo.root, backendDir: path.join(repo.root, "web/backend"), env: {}, watch,
    runStep: async step => { steps.push(step.script); }
  });
  const watcher = watchers.find(w => w.root === path.join(repo.root, "web/contracts"));
  const file = path.join(repo.root, "web/contracts/src/index.ts");
  try {
    fs.utimesSync(file, new Date(), new Date());
    watcher.listener("change", "src/index.ts");
    watcher.listener("change", "src/index.ts");
    await controller.idle();
    assert.deepEqual(steps, []);
    repo.write("web/contracts/src/index.ts", "export const changed = true;");
    watcher.listener("change", "src/index.ts");
    watcher.listener("change", "src/index.ts");
    await controller.idle();
    assert.deepEqual(steps, ["build"]);
    fs.unlinkSync(file);
    watcher.listener("rename", "src/index.ts");
    await controller.idle();
    assert.equal(steps.length, 2);
    repo.write("web/contracts/src/index.ts", "export const changed = true;");
    watcher.listener("rename", "src/index.ts");
    await controller.idle();
    assert.equal(steps.length, 3);
  } finally { controller.close(); }
});

test("explicit external extension roots rebuild their nearest package", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-external-watch-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repoRoot = path.join(parent, "client");
  const extensionRoot = path.join(parent, "extensions");
  const dir = path.join(extensionRoot, "sample-provider");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(repoRoot);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@example/provider", scripts: { build: "node build.mjs" } }));
  const file = path.join(dir, "src", "backend.ts");
  fs.writeFileSync(file, "export {};");
  assert.equal(resolveWatchTarget({ repoRoot, file, watchRoots: [extensionRoot] })?.dir, dir);
  assert.equal(resolveWatchTarget({ repoRoot, file, watchRoots: [repoRoot] }), null);
});
