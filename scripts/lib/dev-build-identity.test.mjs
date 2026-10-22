import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { devBuildIdentityPlugin, readDevBuildIdentity } from "./dev-build-identity.mjs";

function client(identity, injected) {
  const plugin = devBuildIdentityPlugin({ root: "/repo", readIdentity: () => identity });
  const handlers = new Map();
  const global = injected ? { __woohaaBuildIdentity: injected } : {};
  const source = plugin.transformIndexHtml()[0].children.replace(/^import .*\n/, "");
  runInNewContext(source, { globalThis: global, createHotContext: () => ({ on: (name, handler) => handlers.set(name, handler) }) });
  return { plugin, global, handlers };
}
test("startup installs known identity without replacing explicit test/host overrides", () => {
  const identity = { js: "source-sha", wasm: "wasm-sha", mode: "development" };
  const normal = client(identity);
  assert.equal(normal.global.__woohaaBuildIdentity.js, identity.js);
  const overridden = client(identity, { js: "before-projection" });
  assert.equal(overridden.global.__woohaaBuildIdentity.js, "before-projection");
  assert.equal(overridden.global.__woohaaBuildIdentity.wasm, identity.wasm);
  assert.equal(normal.plugin.apply, "serve");
});
test("bootstrap imports and HMR context stay within the configured Vite mount", () => {
  for (const base of ["/", "/dev/feature/"]) {
    const plugin = devBuildIdentityPlugin({ root: "/repo", readIdentity: () => ({}) });
    plugin.configResolved({ base });
    const source = plugin.transformIndexHtml()[0].children;
    assert.ok(source.startsWith(`import { createHotContext } from ${JSON.stringify(`${base}@vite/client`)};`));
    const contexts = [];
    runInNewContext(source.replace(/^import .*\n/, ""), {
      globalThis: {}, createHotContext: path => { contexts.push(path); return { on() {} }; }
    });
    assert.deepEqual(contexts, [`${base}@woohaa-build-identity`]);
  }
});
test("HMR invalidates future identities without mutating previously captured identity", () => {
  const { global, handlers } = client({ js: "old-js", wasm: "old-wasm", mode: "development" });
  const captured = global.__woohaaBuildIdentity;
  handlers.get("woohaa:build-identity-invalidated")({ generation: 2 });
  assert.equal(captured.js, "old-js");
  assert.equal(captured.wasm, "old-wasm");
  assert.equal(global.__woohaaBuildIdentity.js, "hmr-mixed:2");
  assert.equal(global.__woohaaBuildIdentity.wasm, "hmr-unverified:2");
  handlers.get("vite:beforeFullReload")();
  assert.match(global.__woohaaBuildIdentity.js, /^hmr-mixed:reload-/);
});
test("only relevant source changes invalidate and no filesystem listener is installed", () => {
  const plugin = devBuildIdentityPlugin({ root: "/repo", readIdentity: () => ({}) });
  const messages = [];
  const server = { ws: { send: packet => messages.push(packet) } };
  for (const file of ["/repo/docs/audit.md", "/outside/web/frontend/src/a.ts", "/repo/bevy/src/main.rs"])
    plugin.handleHotUpdate({ file, server });
  assert.equal(messages.length, 0);
  for (const file of ["/repo/web/frontend/src/a.ts", "/repo/web/contracts/src/a.ts", "/repo/web/extensions/film-set/dist/frontend.js"])
    plugin.handleHotUpdate({ file, server });
  assert.deepEqual(messages.map(packet => packet.data.generation), [1, 2, 3]);
  assert.equal(plugin.configureServer, undefined);
});
test("bootstrap payload escapes a closing script tag", () => {
  const { global } = client({ js: "</script><script>unsafe", wasm: "unknown", mode: "development" });
  assert.equal(global.__woohaaBuildIdentity.js, "</script><script>unsafe");
});
test("dev identity hashes tracked/untracked source and exact WASM; deleted inputs stay observable", t => {
  const root = mkdtempSync(join(tmpdir(), "woohaa-dev-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "web/frontend/src/bevy-wasm");
  mkdirSync(directory, { recursive: true });
  const source = join(root, "web/frontend/src/app.ts");
  const wasm = join(directory, "woohaa_bevy_canvas_bg.wasm");
  writeFileSync(source, "initial");
  writeFileSync(wasm, "first-binary");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "web/frontend/src/app.ts"], { cwd: root });
  const first = readDevBuildIdentity(root);
  assert.match(first.js, /^dev-source-sha256:[a-f0-9]{64}$/);
  assert.match(first.wasm, /^sha256:[a-f0-9]{64}$/);
  writeFileSync(source, "changed");
  assert.notEqual(readDevBuildIdentity(root).js, first.js);
  writeFileSync(join(root, "web/frontend/src/new.ts"), "new-untracked-module");
  const untracked = readDevBuildIdentity(root).js;
  unlinkSync(source);
  assert.notEqual(readDevBuildIdentity(root).js, untracked);
  writeFileSync(wasm, "second-binary");
  assert.notEqual(readDevBuildIdentity(root).wasm, first.wasm);
  unlinkSync(wasm);
  assert.equal(readDevBuildIdentity(root).wasm, "unknown");
});
