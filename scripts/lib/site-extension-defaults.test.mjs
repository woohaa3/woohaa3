import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applySiteDefaultEnabled, validateSiteDefaultIds } from "./site-extension-defaults.mjs";

function sandbox(descriptor) {
  const dir = mkdtempSync(path.join(tmpdir(), "site-defaults-"));
  writeFileSync(path.join(dir, "extension.json"), JSON.stringify(descriptor, null, 2));
  return dir;
}

test("改写 site.defaultEnabled 并保留其余字段", () => {
  const dir = sandbox({ extensionId: "remote-server", site: { name: "x", defaultEnabled: true, order: 80 } });
  const applied = applySiteDefaultEnabled({ extensionDir: dir, enabled: false });
  assert.deepEqual(applied, { extensionId: "remote-server", defaultEnabled: false });
  const after = JSON.parse(readFileSync(path.join(dir, "extension.json"), "utf8"));
  assert.equal(after.site.defaultEnabled, false);
  assert.equal(after.site.order, 80);
  assert.equal(after.site.name, "x");
});

test("没有 site 段的扩展拒绝改写", () => {
  const dir = sandbox({ extensionId: "browser-only" });
  assert.throws(() => applySiteDefaultEnabled({ extensionDir: dir, enabled: false }), /未声明 site/);
});

test("未安装的 id 在装配前就失败，并列出可用项", () => {
  assert.throws(
    () => validateSiteDefaultIds({ overrides: { nope: false }, availableIds: ["remote-server", "local-agent"] }),
    /可用：local-agent、remote-server/
  );
  assert.doesNotThrow(() => validateSiteDefaultIds({ overrides: { "remote-server": false }, availableIds: ["remote-server"] }));
});
