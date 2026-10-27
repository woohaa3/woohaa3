import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildExtensionBrowser } from "./build-extension-browser.mjs";

test("browser SDK bindings follow facade, reexport and lazy implementation dependencies", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "extension-browser-"));
  try {
    const sources = {
      "package.json": JSON.stringify({ type: "module" }),
      "src/frontend/index.ts": 'export { descriptor } from "../integration/browser/plugin.js";',
      "src/frontend/metadata.ts": 'export const metadata = { extensionId: "fixture" };',
      "src/integration/browser/plugin.ts": `
        import { hostValue } from "../../state/shared/value.js";
        export const descriptor = { value: hostValue, run: async () => (await import("../../authoring/browser/action.js")).run() };
      `,
      "src/state/shared/value.ts": 'export { hostValue } from "@woohaa3/frontend/extension-api";',
      "src/authoring/browser/action.ts": 'import { hostAction } from "@woohaa3/frontend/extension-api"; export const run = () => hostAction();',
      // An unreachable backend module must not pollute the browser SDK closure.
      "src/integration/backend/controller.ts": 'import sdk from "@woohaa3/frontend/extension-api"; export default sdk;'
    };
    for (const [relative, source] of Object.entries(sources)) {
      const file = path.join(cwd, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    const result = await buildExtensionBrowser({ cwd });
    assert.deepEqual(result.manifest.requiredSdkExports, ["hostAction", "hostValue"]);
    const entry = await import(pathToFileURL(path.join(result.outDir, result.entry)).href);
    const hostValue = {};
    const { descriptor } = await entry.loadExtension({ token: {}, sdk: { hostValue, hostAction: () => "called" } });
    assert.equal(descriptor.value, hostValue);
    assert.equal(await descriptor.run(), "called");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("package public assets are hashed, reproducible and reject symlinks", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "extension-assets-"));
  try {
    await mkdir(path.join(cwd, "src/frontend"), { recursive: true });
    await mkdir(path.join(cwd, "public/editor"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), '{"type":"module"}');
    await writeFile(path.join(cwd, "src/frontend/index.ts"), 'export const descriptor = {};');
    await writeFile(path.join(cwd, "src/frontend/metadata.ts"), 'export const metadata = { extensionId: "fixture" };');
    await writeFile(path.join(cwd, "public/editor/index.html"), '<script type="module" src="./app.js"></script>');
    await writeFile(path.join(cwd, "public/editor/app.js"), 'export const ready = true;');
    await writeFile(path.join(cwd, "public/editor/app.wasm"), new Uint8Array([0,97,115,109]));
    const first = await buildExtensionBrowser({ cwd });
    const assets = first.manifest.files.filter(file => file.path.startsWith("assets/editor/"));
    assert.equal(assets.length, 3);
    for (const asset of assets) { assert.equal(asset.kind, "asset"); assert.ok(asset.bytes > 0); assert.match(asset.sha256, /^[a-f0-9]{64}$/); }
    assert.equal((await buildExtensionBrowser({ cwd })).artifactId, first.artifactId);
    await writeFile(path.join(cwd, "public/editor/app.js"), 'export const ready = false;');
    assert.notEqual((await buildExtensionBrowser({ cwd })).artifactId, first.artifactId);
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(cwd, "package.json"), path.join(cwd, "public/escape.json"));
    await assert.rejects(buildExtensionBrowser({ cwd }), /symlink/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("react-dom and react-dom/client resolve to host bindings instead of a second inlined copy", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "extension-browser-react-dom-"));
  try {
    const sources = {
      "package.json": JSON.stringify({ type: "module" }),
      "src/frontend/index.ts": 'export { descriptor } from "./plugin.js";',
      "src/frontend/metadata.ts": 'export const metadata = { extensionId: "fixture" };',
      // 这些都是 antd / rc-* 实际会取的导出；bare specifier 在 tmp 目录里根本解析不到，
      // 所以只有被重定向到 shim 才能构建通过——构建成功本身就证明没有内联第二份。
      "src/frontend/plugin.ts": `
        import { useImperativeHandle, useInsertionEffect, version as reactVersion } from "react";
        import { createPortal, flushSync, __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED as internals } from "react-dom";
        import { createRoot } from "react-dom/client";
        export const descriptor = { useImperativeHandle, useInsertionEffect, reactVersion, createPortal, flushSync, internals, createRoot };
      `
    };
    for (const [relative, source] of Object.entries(sources)) {
      const file = path.join(cwd, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    const result = await buildExtensionBrowser({ cwd });
    const entry = await import(pathToFileURL(path.join(result.outDir, result.entry)).href);
    const imperative = () => "imperative";
    const insertion = () => "insertion";
    const portal = () => "portal";
    const flush = () => "flush";
    const internals = { ReactCurrentBatchConfig: {} };
    const root = () => "root";
    const { descriptor } = await entry.loadExtension({
      token: {},
      sdk: {},
      react: { useImperativeHandle: imperative, useInsertionEffect: insertion, version: "18.3.1" },
      jsxRuntime: {},
      reactDom: { createPortal: portal, flushSync: flush, __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: internals },
      reactDomClient: { createRoot: root }
    });
    assert.equal(descriptor.useImperativeHandle, imperative);
    assert.equal(descriptor.useInsertionEffect, insertion);
    assert.equal(descriptor.reactVersion, "18.3.1");
    assert.equal(descriptor.createPortal, portal);
    assert.equal(descriptor.flushSync, flush);
    assert.equal(descriptor.internals, internals);
    assert.equal(descriptor.createRoot, root);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
