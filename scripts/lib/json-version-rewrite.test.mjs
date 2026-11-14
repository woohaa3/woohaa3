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

test("顶层 version 在 site / engines 之后时仍能正确定位（回归）", () => {
  // 真实故障：带 `site` 段的扩展 bump 全部报「顶层 version 改写后校验失败」——
  // 定位用的是「最后一次 version 匹配」，命中了 site.version 而不是顶层那个。
  const text = `{
  "schemaVersion": 1,
  "extensionId": "remote-server",
  "site": {
    "name": "服务端接入",
    "version": "1.0.0",
    "configSchema": { "schemaId": "s", "schemaVersion": 1 }
  },
  "engines": {
    "hostAbi": "^1.0.0",
    "protocolVersion": 1,
    "host": { "generation": 1 }
  },
  "version": "1.0.0"
}
`;
  const { text: next, changed } = rewriteJsonVersionLiterals(text, { top: "1.0.1", site: "1.0.1" });
  assert.equal(changed, true);
  const parsed = JSON.parse(next);
  assert.equal(parsed.version, "1.0.1", "顶层 version 必须被改");
  assert.equal(parsed.site.version, "1.0.1", "site.version 必须被改");
  assert.equal(parsed.site.configSchema.schemaVersion, 1, "嵌套 schemaVersion 不得被改");
  assert.equal(parsed.engines.protocolVersion, 1, "engines.protocolVersion 不得被改");
});

test("顶层 version 出现在 site 之前时也正确", () => {
  const text = `{
  "version": "1.0.0",
  "site": { "name": "n", "version": "1.0.0" }
}
`;
  const parsed = JSON.parse(rewriteJsonVersionLiterals(text, { top: "2.0.0", site: "2.0.0" }).text);
  assert.equal(parsed.version, "2.0.0");
  assert.equal(parsed.site.version, "2.0.0");
});

test("字符串内容里的括号不干扰深度判定", () => {
  const text = `{
  "description": "包含 { 与 } 以及 \\"version\\" 字样",
  "version": "1.0.0"
}
`;
  const parsed = JSON.parse(rewriteJsonVersionLiterals(text, { top: "1.0.1" }).text);
  assert.equal(parsed.version, "1.0.1");
  assert.match(parsed.description, /包含 \{ 与 \}/);
});
