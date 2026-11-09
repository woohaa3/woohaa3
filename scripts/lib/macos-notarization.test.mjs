import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notarizeMacDiskImages } from "./macos-notarization.mjs";

const env = { APPLE_ID: "release@example.com", APPLE_PASSWORD: "test-secret", APPLE_TEAM_ID: "TEAM" };
const signing = { adhoc: false, notarization: { mode: "apple-id" } };
const image = { path: "/build/WooHaa3.dmg", name: "WooHaa3.dmg" };
const ok = stdout => ({ status: 0, stdout: stdout ?? "", stderr: "" });
const missing = { status: 65, stdout: "does not have a ticket", stderr: "" };
const accepted = ok('{"id":"request-1","status":"Accepted"}');

function harness(responses) {
  const calls = [], logs = [];
  const spawn = (command, args) => {
    assert.equal(command, "/usr/bin/xcrun");
    calls.push(args);
    assert.ok(responses.length, `Unexpected call: ${args.slice(0, 2)}`);
    const next = responses.shift();
    return typeof next === "function" ? next() : next;
  };
  return { calls, logs, run: (overrides = {}) => notarizeMacDiskImages({
    artifacts: [image], signing, env, spawn, log: message => logs.push(message), ...overrides
  }) };
}

test("App 已有票据仍须独立公证 DMG，并在 Accepted 后装订、校验", () => {
  const h = harness([missing, accepted, ok(), ok()]);
  h.run({ artifacts: [{ path: "/build/WooHaa3.app", name: "WooHaa3.app" }, image] });
  assert.deepEqual(h.calls.map(args => args.slice(0, 2)), [
    ["stapler", "validate"], ["notarytool", "submit"], ["stapler", "staple"], ["stapler", "validate"]
  ]);
  assert.equal(h.calls[1][2], image.path);
  assert.ok(h.calls[1].includes("--wait"));
  assert.equal(h.calls[1][h.calls[1].indexOf("--password") + 1], env.APPLE_PASSWORD);
  assert.ok(!h.logs.join("\n").includes(env.APPLE_PASSWORD));
});

test("已有 DMG 票据时不重复提交；ad-hoc、未公证、仅 App 不提交", () => {
  const h = harness([ok()]);
  h.run();
  assert.equal(h.calls.length, 1);
  const skipped = harness([]);
  skipped.run({ signing: null });
  skipped.run({ signing: { ...signing, adhoc: true } });
  skipped.run({ signing: { ...signing, notarization: null } });
  skipped.run({ artifacts: [{ path: "/build/WooHaa3.app" }] });
  assert.equal(skipped.calls.length, 0);
});

test("Apple 返回 Invalid 即使退出码为 0 也停止，取回拒绝日志且不回显密码", () => {
  const h = harness([missing, ok('{"id":"request-bad","status":"Invalid"}'), ok(`unsigned binary; ${env.APPLE_PASSWORD}`)]);
  assert.throws(() => h.run(), error => {
    assert.match(error.message, /Invalid.*request-bad/);
    assert.match(error.message, /unsigned binary/);
    assert.ok(!error.message.includes(env.APPLE_PASSWORD));
    return true;
  });
  assert.deepEqual(h.calls.at(-1).slice(0, 3), ["notarytool", "log", "request-bad"]);
  assert.ok(!h.calls.some(args => args[1] === "staple"));
});

test("网络/认证失败、无效响应与工具无法启动都停止，不能装订", () => {
  for (const response of [
    { status: 1, stdout: "", stderr: "HTTP 401" }, ok("not JSON"),
    { status: null, error: new Error("spawn ENOENT") }
  ]) {
    const h = harness([missing, response]);
    assert.throws(() => h.run(), /DMG 公证失败/);
    assert.equal(h.calls.length, 2);
  }
});

test("Apple 接受后装订失败或票据无效仍停止", () => {
  assert.throws(() => harness([missing, accepted, missing]).run(), /DMG 装订/);
  assert.throws(() => harness([missing, accepted, ok(), missing]).run(), /DMG 票据核对/);
});

test("API key 公证使用对应参数；缺失凭据在提交前失败", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notary-key-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, "AuthKey.p8");
  fs.writeFileSync(keyPath, "test-key");
  const h = harness([missing, accepted, ok(), ok()]);
  h.run({ env: { APPLE_API_KEY: "KEY", APPLE_API_ISSUER: "issuer", APPLE_API_KEY_PATH: keyPath } });
  assert.deepEqual(h.calls[1].slice(3, -3), ["--key", keyPath, "--key-id", "KEY", "--issuer", "issuer"]);
  assert.throws(() => harness([]).run({ env: {} }), /缺少/);
});

test("多个 DMG 必须逐个处理，不能用第一个的票据放行其余产物", () => {
  const second = { path: "/build/Second.dmg", name: "Second.dmg" };
  const h = harness([ok(), missing, accepted, ok(), ok()]);
  h.run({ artifacts: [image, second] });
  assert.equal(h.calls[1][2], second.path);
  assert.equal(h.calls[2][2], second.path);
  assert.equal(h.calls[3][2], second.path);
  assert.equal(h.calls[4][2], second.path);
});
