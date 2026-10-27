/**
 * 开发者模式热重载编排单测（change: 2026-10-27-add-extension-dev-reload，3.2 / 3.4 / D6）。
 *
 * 只验证编排：监听产出的事件如何变成「重登记 + 后端 swap + reload 通知」，
 * 以及每一步失败时的行为。真实的 fs.watch 行为由 dev-source-watch.test.mjs 覆盖。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { startDevReload } from "./extension-host-dev.mjs";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-dev-reload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeExtension(root, id) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, "browser-dist"), { recursive: true });
  fs.mkdirSync(path.join(dir, "backend-dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "extension.json"), JSON.stringify({ schemaVersion: 1, extensionId: id }));
  fs.writeFileSync(path.join(dir, "browser-dist", "entry.js"), "1");
  fs.writeFileSync(path.join(dir, "backend-dist", "entry.mjs"), "1");
  return dir;
}

/** 每次调用都推进 mtime：连续两次变化必须产生不同的产物指纹。 */
let bumpSequence = 0;
function bump(dir, relative, content) {
  const file = path.join(dir, relative);
  fs.writeFileSync(file, content);
  bumpSequence += 1;
  const next = (Date.now() + bumpSequence * 5000) / 1000;
  fs.utimesSync(file, next, next);
}

/** 假 watcher：测试手动投递事件。 */
function fakeWatch() {
  const calls = [];
  return {
    calls,
    watch: (root, options, listener) => {
      const emitter = new EventEmitter();
      emitter.close = () => {};
      calls.push({ root, listener });
      return emitter;
    }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("startDevReload", () => {
  test("前端产物变化：重登记 → 发 reload，且不带后端语义", async (t) => {
    const root = tmpDir(t);
    const dir = writeExtension(root, "ext-a");
    const { watch, calls } = fakeWatch();
    const published = [];
    const reloads = [];
    const handle = startDevReload({
      devDirs: [root],
      watch,
      debounceMs: 5,
      publishBrowserRelease: async (change) => {
        published.push(change);
        return { releaseId: "rel-1", href: "/extension-releases/rel-1.json", changed: true };
      },
      onReload: (event) => reloads.push(event)
    });
    t.after(() => handle.close());

    bump(dir, "browser-dist/entry.js", "2");
    calls[0].listener("change", path.join(dir, "browser-dist", "entry.js"));
    await handle.idle();

    assert.deepEqual(published, [{ upsert: [{ extensionId: "ext-a", directory: dir }] }]);
    assert.equal(reloads.length, 1);
    assert.equal(reloads[0].extensionId, "ext-a");
    assert.equal(reloads[0].browserChanged, true);
    assert.equal(reloads[0].backend, false);
  });

  test("后端产物变化：swap 带 token 与 last-good，并通知", async (t) => {
    const root = tmpDir(t);
    const dir = writeExtension(root, "ext-b");
    const { watch, calls } = fakeWatch();
    const swaps = [];
    const reloads = [];
    const handle = startDevReload({
      devDirs: [root],
      watch,
      debounceMs: 5,
      publishBrowserRelease: async () => ({ releaseId: "rel", href: "/r.json", changed: false }),
      swapBackend: async (extensionId, directory, options) => swaps.push({ extensionId, directory, ...options }),
      onReload: (event) => reloads.push(event)
    });
    t.after(() => handle.close());

    bump(dir, "backend-dist/entry.mjs", "2");
    calls[0].listener("change", path.join(dir, "backend-dist", "entry.mjs"));
    await handle.idle();
    bump(dir, "backend-dist/entry.mjs", "3");
    calls[0].listener("change", path.join(dir, "backend-dist", "entry.mjs"));
    await handle.idle();

    assert.equal(swaps.length, 2);
    assert.notEqual(swaps[0].token, swaps[1].token, "每次变化都要新 token");
    assert.equal(swaps[0].previousToken, null);
    assert.equal(swaps[1].previousToken, swaps[0].token, "第二次装回时要能回到上一次成功的 token");
    assert.equal(reloads.length, 2);
    assert.equal(reloads[0].backend, true);
  });

  test("前端同内容重放且后端未变：不发 reload", async (t) => {
    const root = tmpDir(t);
    const dir = writeExtension(root, "ext-c");
    const { watch, calls } = fakeWatch();
    const reloads = [];
    const handle = startDevReload({
      devDirs: [root],
      watch,
      debounceMs: 5,
      publishBrowserRelease: async () => ({ releaseId: "rel", href: "/r.json", changed: false }),
      onReload: (event) => reloads.push(event)
    });
    t.after(() => handle.close());

    bump(dir, "browser-dist/entry.js", "9");
    calls[0].listener("change", path.join(dir, "browser-dist", "entry.js"));
    await handle.idle();
    assert.deepEqual(reloads, []);
  });

  test("发布失败：保留上一次产物，不发 reload，下一次变化重试", async (t) => {
    const root = tmpDir(t);
    const dir = writeExtension(root, "ext-d");
    const { watch, calls } = fakeWatch();
    const logs = [];
    const reloads = [];
    let fail = true;
    const handle = startDevReload({
      devDirs: [root],
      watch,
      debounceMs: 5,
      log: (event) => logs.push(event),
      publishBrowserRelease: async () => {
        if (fail) throw new Error("产物不合法");
        return { releaseId: "rel", href: "/r.json", changed: true };
      },
      onReload: (event) => reloads.push(event)
    });
    t.after(() => handle.close());

    bump(dir, "browser-dist/entry.js", "2");
    calls[0].listener("change", path.join(dir, "browser-dist", "entry.js"));
    await handle.idle();
    assert.deepEqual(reloads, []);
    assert.ok(logs.some((entry) => entry.event === "dev-artifact-register-failed"));

    fail = false;
    bump(dir, "browser-dist/entry.js", "3");
    calls[0].listener("change", path.join(dir, "browser-dist", "entry.js"));
    await handle.idle();
    assert.equal(reloads.length, 1, "失败不缓存为终态");
  });

  test("后端 swap 失败：不发 reload，也不推进 last-good", async (t) => {
    const root = tmpDir(t);
    const dir = writeExtension(root, "ext-e");
    const { watch, calls } = fakeWatch();
    const reloads = [];
    const logs = [];
    const handle = startDevReload({
      devDirs: [root],
      watch,
      debounceMs: 5,
      log: (event) => logs.push(event),
      publishBrowserRelease: async () => ({ releaseId: "rel", href: "/r.json", changed: false }),
      swapBackend: async () => {
        throw new Error("装不回新产物");
      },
      onReload: (event) => reloads.push(event)
    });
    t.after(() => handle.close());

    bump(dir, "backend-dist/entry.mjs", "2");
    calls[0].listener("change", path.join(dir, "backend-dist", "entry.mjs"));
    await handle.idle();
    assert.deepEqual(reloads, []);
    assert.ok(logs.some((entry) => entry.event === "dev-backend-swap-failed"));
  });

  test("没有身份声明的目录：只记录，不装配", async (t) => {
    const root = tmpDir(t);
    const dir = path.join(root, "nameless");
    fs.mkdirSync(path.join(dir, "browser-dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "browser-dist", "entry.js"), "1");
    const { watch, calls } = fakeWatch();
    const logs = [];
    const handle = startDevReload({
      devDirs: [root],
      watch,
      debounceMs: 5,
      log: (event) => logs.push(event),
      publishBrowserRelease: async () => ({ releaseId: "rel", href: "/r.json", changed: true }),
      onReload: () => assert.fail("无身份不应发 reload")
    });
    t.after(() => handle.close());

    bump(dir, "browser-dist/entry.js", "2");
    calls[0].listener("change", path.join(dir, "browser-dist", "entry.js"));
    await handle.idle();
    assert.ok(logs.some((entry) => entry.event === "dev-reload-no-identity"));
    await tick();
  });
});
