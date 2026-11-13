/**
 * JSON 版本就地改写单测。
 *
 * 核心约束：**只改 version 的值，其余字节不动**。整文件重新序列化会把紧凑写法展开，
 * 制造几十行格式噪音（实施中真实发生过），所以这里逐字节验证。
 *
 * 运行：`node --test scripts/lib/json-version-rewrite.test.mjs`
 */
import assert from "node:assert/strict";
import test from "node:test";

import { rewriteJsonVersionLiterals } from "./json-version-rewrite.mjs";

test("改顶层 version，紧凑嵌套写法保持原样", () => {
  const text = `{
  "schemaVersion": 1,
  "extensionId": "ark-provider",
  "metadata": { "module": "./shared", "export": "ARK_PLUGIN_METADATA", "order": 40 },
  "hostPlugin": { "module": "./backend", "factory": "createArkProviderPlugin", "features": ["provider"], "order": 30 },
  "version": "1.0.0"
}
`;
  const { text: next, changed } = rewriteJsonVersionLiterals(text, { top: "1.0.1" });
  assert.equal(changed, true);
  // 只有版本那一行的值变了。
  assert.equal(next, text.replace('"version": "1.0.0"', '"version": "1.0.1"'));
  assert.equal(JSON.parse(next).version, "1.0.1");
  // 紧凑写法必须原样保留。
  assert.match(next, /"metadata": \{ "module": "\.\/shared", "export": "ARK_PLUGIN_METADATA", "order": 40 \}/);
  assert.match(next, /"features": \["provider"\]/);
});

test("同时改 site.version，且不会碰到嵌套对象里的 version", () => {
  const text = `{
  "schemaVersion": 1,
  "extensionId": "demo",
  "version": "0.1.0",
  "site": {
    "name": "演示",
    "version": "0.1.0",
    "configSchema": { "schemaId": "s", "schemaVersion": 1 }
  },
  "hostPlugin": { "module": "./backend", "factory": "f", "features": ["provider"] }
}
`;
  const { text: next, changed } = rewriteJsonVersionLiterals(text, { top: "0.2.0", site: "0.2.0" });
  assert.equal(changed, true);
  const parsed = JSON.parse(next);
  assert.equal(parsed.version, "0.2.0");
  assert.equal(parsed.site.version, "0.2.0");
  // 嵌套的 schemaVersion 不得被改成版本号。
  assert.equal(parsed.site.configSchema.schemaVersion, 1);
  assert.match(next, /"configSchema": \{ "schemaId": "s", "schemaVersion": 1 \}/);
});

test("顶层缺 version 时在根对象末尾插入，保持两空格缩进与紧凑写法", () => {
  const text = `{
  "schemaVersion": 1,
  "extensionId": "cos-storage",
  "hostPlugin": { "module": "./backend", "factory": "f", "features": ["storage"] }
}
`;
  const { text: next, changed } = rewriteJsonVersionLiterals(text, { insertTop: "0.1.0" });
  assert.equal(changed, true);
  const parsed = JSON.parse(next);
  assert.equal(parsed.version, "0.1.0");
  assert.equal(parsed.extensionId, "cos-storage");
  assert.match(next, /"hostPlugin": \{ "module": "\.\/backend", "factory": "f", "features": \["storage"\] \}/);
  assert.match(next, /\n {2}"version": "0\.1\.0"\n}\n$/);
});

test("值已是目标值时 changed=false，不产生 diff", () => {
  const text = '{\n  "version": "1.0.0"\n}\n';
  const { text: next, changed } = rewriteJsonVersionLiterals(text, { top: "1.0.0" });
  assert.equal(changed, false);
  assert.equal(next, text);
});

test("非法 JSON 直接抛错，不写半成品", () => {
  assert.throws(() => rewriteJsonVersionLiterals("{ not json", { top: "1.0.0" }), /JSON/);
});

test("字符串值里的 version 字样不被误改", () => {
  const text = `{
  "description": "keep version: \\"9.9.9\\" untouched",
  "version": "1.0.0"
}
`;
  const { text: next } = rewriteJsonVersionLiterals(text, { top: "2.0.0" });
  assert.match(next, /"description": "keep version: \\"9\.9\.9\\" untouched"/);
  assert.equal(JSON.parse(next).version, "2.0.0");
});

test("改完结果与原文件行数一致（只改值，不重排）", () => {
  const text = `{
  "schemaVersion": 1,
  "extensionId": "x",
  "metadata": { "module": "./shared", "order": 1 },
  "version": "0.1.0"
}
`;
  const { text: next } = rewriteJsonVersionLiterals(text, { top: "0.1.1" });
  assert.equal(next.split("\n").length, text.split("\n").length, "行数必须不变，说明没有重排");
});
