import assert from "node:assert/strict";
import test from "node:test";

import { applyExtensionDefaults } from "./extension-release-defaults.mjs";

function entries() {
  return [
    { metadata: { extensionId: "alpha" }, artifactId: "a" },
    { metadata: { extensionId: "beta", defaultEnabled: true }, artifactId: "b" }
  ];
}

test("覆盖 defaultEnabled 并返回生效清单", () => {
  const list = entries();
  const applied = applyExtensionDefaults(list, { alpha: false, beta: true });
  assert.equal(list[0].metadata.defaultEnabled, false);
  assert.equal(list[1].metadata.defaultEnabled, true);
  assert.deepEqual(applied, [
    { extensionId: "alpha", defaultEnabled: false },
    { extensionId: "beta", defaultEnabled: true }
  ]);
});

test("不修改未指定的扩展", () => {
  const list = entries();
  applyExtensionDefaults(list, { alpha: false });
  assert.equal("defaultEnabled" in list[1].metadata, true);
  assert.equal(list[1].metadata.defaultEnabled, true);
});

test("站点级扩展被拒绝，并指向 siteDefaultEnabled", () => {
  const list = [{ metadata: { extensionId: "remote-server", configScope: "site" } }];
  assert.throws(() => applyExtensionDefaults(list, { "remote-server": false }), /siteDefaultEnabled/);
});

test("未知 extensionId 默认失败，并列出可用项", () => {
  assert.throws(() => applyExtensionDefaults(entries(), { nope: false }), /可用：alpha、beta/);
});

test("allowMissing 时跳过并回调", () => {
  const skipped = [];
  const applied = applyExtensionDefaults(entries(), { nope: false }, { allowMissing: true, onSkip: (id) => skipped.push(id) });
  assert.deepEqual(applied, []);
  assert.deepEqual(skipped, ["nope"]);
});
