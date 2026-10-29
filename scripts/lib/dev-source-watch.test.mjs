/**
 * 开发者模式产物监听单测（change: 2026-10-27-add-extension-dev-reload，D2 / D7）。
 *
 * 运行：`node --test scripts/lib/dev-source-watch.test.mjs`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { resolveDevSurface, startDevSourceWatch } from "./dev-source-watch.mjs";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-dev-watch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 写一个产物文件并推进 mtime（不同平台 mtime 粒度不同，显式 +1000ms）。 */
function writeArtifact(dir, relative, content) {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const next = Date.now() + Math.floor(Math.random() * 1000) + 1000;
  fs.utimesSync(file, next / 1000, next / 1000);
}

/** 假 watcher：记录监听根，并允许测试手动投递事件。 */
function fakeWatch() {
  const calls = [];
  const fn = (root, options, listener) => {
    const emitter = new EventEmitter();
    emitter.close = () => {};
    calls.push({ root, options, listener, emitter });
    return emitter;
  };
  return { watch: fn, calls };
}

describe("resolveDevSurface", () => {
  test("识别 browser-dist / backend-dist，返回所属扩展目录", () => {
    assert.deepEqual(resolveDevSurface("/d/ext/browser-dist/entry-abc.js"), { extensionDir: "/d/ext", surface: "browser" });
    assert.deepEqual(resolveDevSurface("/d/ext/backend-dist/entry.mjs"), { extensionDir: "/d/ext", surface: "backend" });
  });

  test("非产物路径与临时文件不触发", () => {
    assert.equal(resolveDevSurface("/d/ext/src/frontend/index.ts"), null);
    assert.equal(resolveDevSurface("/d/ext/browser-dist/.DS_Store"), null);
    assert.equal(resolveDevSurface("/d/ext/browser-dist/entry.js.tmp"), null);
    assert.equal(resolveDevSurface("/d/ext/browser-dist/entry.js~"), null);
  });
});

describe("startDevSourceWatch", () => {
  test("产物变化按扩展合并，并上报命中的面", async (t) => {
    const root = tmpDir(t);
    const ext = path.join(root, "my-ext");
    writeArtifact(ext, "browser-dist/entry-a.js", "a");
    const { watch, calls } = fakeWatch();
    const events = [];
    const handle = startDevSourceWatch({ devDirs: [root], watch, debounceMs: 5, onChange: (event) => events.push(event) });
    t.after(() => handle.close());

    writeArtifact(ext, "browser-dist/entry-b.js", "b");
    calls[0].listener("change", path.join(ext, "browser-dist/entry-b.js"));
    await handle.idle();

    assert.deepEqual(events, [{ extensionDir: ext, surfaces: ["browser"] }]);
  });

  test("同一次内的前后端变化合成一个事件", async (t) => {
    const root = tmpDir(t);
    const ext = path.join(root, "both");
    writeArtifact(ext, "browser-dist/entry.js", "1");
    writeArtifact(ext, "backend-dist/entry.mjs", "1");
    const { watch, calls } = fakeWatch();
    const events = [];
    const handle = startDevSourceWatch({ devDirs: [root], watch, debounceMs: 5, onChange: (event) => events.push(event) });
    t.after(() => handle.close());

    writeArtifact(ext, "browser-dist/entry.js", "2");
    writeArtifact(ext, "backend-dist/entry.mjs", "2");
    calls[0].listener("change", path.join(ext, "browser-dist/entry.js"));
    calls[0].listener("change", path.join(ext, "backend-dist/entry.mjs"));
    await handle.idle();

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].surfaces, ["backend", "browser"]);
  });

  test("产物内容未变时不重复上报", async (t) => {
    const root = tmpDir(t);
    const ext = path.join(root, "stable");
    writeArtifact(ext, "browser-dist/entry.js", "x");
    const { watch, calls } = fakeWatch();
    const events = [];
    const handle = startDevSourceWatch({ devDirs: [root], watch, debounceMs: 5, onChange: (event) => events.push(event) });
    t.after(() => handle.close());

    const file = path.join(ext, "browser-dist/entry.js");
    calls[0].listener("change", file);
    await handle.idle();
    calls[0].listener("change", file);
    await handle.idle();

    assert.equal(events.length, 1, "同一份产物只触发一次");
  });

  test("回调串行：上一次结束时才处理下一轮", async (t) => {
    const root = tmpDir(t);
    const ext = path.join(root, "serial");
    writeArtifact(ext, "browser-dist/entry.js", "1");
    const { watch, calls } = fakeWatch();
    const order = [];
    let resolveFirst = () => {};
    const handle = startDevSourceWatch({
      devDirs: [root],
      watch,
      debounceMs: 5,
      onChange: async (event) => {
        order.push(`start:${event.surfaces.join("+")}`);
        if (order.length === 1) await new Promise((resolve) => { resolveFirst = resolve; });
        order.push(`end:${event.surfaces.join("+")}`);
      }
    });
    t.after(() => handle.close());

    writeArtifact(ext, "browser-dist/entry.js", "2");
    calls[0].listener("change", path.join(ext, "browser-dist/entry.js"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    writeArtifact(ext, "backend-dist/entry.mjs", "1");
    calls[0].listener("change", path.join(ext, "backend-dist/entry.mjs"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(order, ["start:browser"], "第二轮必须等第一轮结束");
    resolveFirst();
    await handle.idle();
    assert.equal(order.filter((entry) => entry.startsWith("start:")).length, 2);
    assert.equal(order[1], "end:browser");
  });

  test("回调抛错只记录，监听继续可用", async (t) => {
    const root = tmpDir(t);
    const ext = path.join(root, "flaky");
    writeArtifact(ext, "browser-dist/entry.js", "1");
    const { watch, calls } = fakeWatch();
    const logs = [];
    let attempts = 0;
    const handle = startDevSourceWatch({
      devDirs: [root],
      watch,
      debounceMs: 5,
      log: (event) => logs.push(event),
      onChange: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("装配失败");
      }
    });
    t.after(() => handle.close());

    writeArtifact(ext, "browser-dist/entry.js", "2");
    calls[0].listener("change", path.join(ext, "browser-dist/entry.js"));
    await handle.idle();
    assert.ok(logs.some((entry) => entry.event === "dev-reload-failed"));

    writeArtifact(ext, "browser-dist/entry.js", "3");
    calls[0].listener("change", path.join(ext, "browser-dist/entry.js"));
    await handle.idle();
    assert.equal(attempts, 2, "下一次变化仍会触发");
  });

  test("close 后不再触发", async (t) => {
    const root = tmpDir(t);
    const ext = path.join(root, "closing");
    writeArtifact(ext, "browser-dist/entry.js", "1");
    const { watch, calls } = fakeWatch();
    const events = [];
    const handle = startDevSourceWatch({ devDirs: [root], watch, debounceMs: 5, onChange: (event) => events.push(event) });
    handle.close();

    writeArtifact(ext, "browser-dist/entry.js", "2");
    calls[0].listener("change", path.join(ext, "browser-dist/entry.js"));
    await handle.idle();
    assert.deepEqual(events, []);
  });

  test("递归监听不可用时回退轮询并记录诊断", (t) => {
    const root = tmpDir(t);
    const logs = [];
    const watch = () => {
      throw new Error("recursive watch unsupported");
    };
    const handle = startDevSourceWatch({ devDirs: [root], watch, log: (event) => logs.push(event), pollMs: 10 });
    t.after(() => handle.close());
    assert.ok(logs.some((entry) => entry.event === "dev-watch-fallback-poll"));
    assert.deepEqual(handle.watched, []);
  });
});
