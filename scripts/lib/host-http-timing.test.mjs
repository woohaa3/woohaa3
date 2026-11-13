/**
 * 宿主 HTTP 连接时间参数单测。
 *
 * 守的是「四个生产入口共用同一份参数」这条约束：参数分散写死时，改一处会静默漏掉其余三处，
 * 而症状（长空闲后 ECONNRESET）在服务端日志里完全看不到。
 *
 * 运行：`node --test scripts/lib/host-http-timing.test.mjs`
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HOST_HTTP_TIMING, applyHostHttpTiming } from "./host-http-timing.mjs";

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("keep-alive 必须显著长于 Node 缺省的 5 秒", () => {
  // Node 缺省 5000ms：本机宿主的长空闲（导入大场景、等用户在文件框操作）会超过它，
  // 服务端关闭空闲连接后浏览器复用即 ECONNRESET。
  assert.ok(HOST_HTTP_TIMING.keepAliveTimeoutMs >= 60_000, `keepAliveTimeoutMs=${HOST_HTTP_TIMING.keepAliveTimeoutMs}，过短会重现 ECONNRESET`);
  assert.ok(HOST_HTTP_TIMING.keepAliveTimeoutMs > 5_000);
});

test("headersTimeout 必须大于 keepAliveTimeout（Node 要求）", () => {
  assert.ok(
    HOST_HTTP_TIMING.headersTimeoutMs > HOST_HTTP_TIMING.keepAliveTimeoutMs,
    `headersTimeoutMs=${HOST_HTTP_TIMING.headersTimeoutMs} 必须大于 keepAliveTimeoutMs=${HOST_HTTP_TIMING.keepAliveTimeoutMs}`
  );
});

test("requestTimeout 不限制，避免大包上传与长轮询被掐断", () => {
  assert.equal(HOST_HTTP_TIMING.requestTimeoutMs, 0);
});

test("applyHostHttpTiming 只写三个属性并返回同一实例", () => {
  const fake = { keepAliveTimeout: 5_000, headersTimeout: 5_000, requestTimeout: 300_000, marker: "untouched" };
  const returned = applyHostHttpTiming(fake);
  assert.equal(returned, fake, "必须返回同一实例，调用方靠它串联 createServer");
  assert.equal(fake.keepAliveTimeout, HOST_HTTP_TIMING.keepAliveTimeoutMs);
  assert.equal(fake.headersTimeout, HOST_HTTP_TIMING.headersTimeoutMs);
  assert.equal(fake.requestTimeout, HOST_HTTP_TIMING.requestTimeoutMs);
  assert.equal(fake.marker, "untouched");
});

test("四个生产入口都应用了共享时间参数", () => {
  const entries = [
    "scripts/serve-web.mjs",
    "scripts/lib/web-host-runtime.mjs",
    "scripts/lib/desktop-host-runtime.mjs",
    "web/backend/src/server.ts"
  ];
  const missing = [];
  for (const entry of entries) {
    const source = readFileSync(path.join(CLIENT_ROOT, entry), "utf8");
    if (!source.includes("applyHostHttpTiming")) missing.push(entry);
  }
  assert.deepEqual(missing, [], "以下入口没有应用共享时间参数，会出现长空闲后 ECONNRESET");
});

test("生产入口不各自写死时间参数", () => {
  const entries = [
    "scripts/serve-web.mjs",
    "scripts/lib/web-host-runtime.mjs",
    "scripts/lib/desktop-host-runtime.mjs",
    "web/backend/src/server.ts"
  ];
  const offenders = [];
  for (const entry of entries) {
    const source = readFileSync(path.join(CLIENT_ROOT, entry), "utf8");
    // 允许 `applyHostHttpTiming` 与注释；不允许直接给 keepAliveTimeout 等赋值。
    if (/\.(keepAliveTimeout|headersTimeout|requestTimeout)\s*=/.test(source)) offenders.push(entry);
  }
  assert.deepEqual(offenders, [], "时间参数只应存在于 scripts/lib/host-http-timing.mjs");
});
