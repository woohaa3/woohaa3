import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDefines,
  decodeBuildProfile,
  describeBuildProfile,
  joinUrl,
  loadBuildProfile,
  updateEndpointFor,
  updaterPlatformKey
} from "./build-profile.mjs";

const PUBKEY = "MCowBQYDK2VwAyEA9BSsnRjDqAC9oW4PmDez8mNNi5cSJY3aocXRu20o47E=";
const KEY_ID = "aadb5d097b0d9234";

function validProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    profileId: "test",
    cdn: {
      baseUrl: "https://cos.example.com/",
      runtimePath: "woohaa/runtimes/",
      updatePath: "woohaa/updates/stable/{platformKey}/latest.json"
    },
    desktop: { update: { publicKeys: ["dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Q="] } },
    extensionTrust: { officialKeys: [{ keyId: KEY_ID, publicKey: PUBKEY }] },
    ...overrides
  };
}

function sandbox(profile) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "build-profile-"));
  if (profile !== undefined) writeFileSync(path.join(repoRoot, "build-profile.json"), JSON.stringify(profile));
  return repoRoot;
}

test("合法 profile 解码通过", () => {
  const decoded = decodeBuildProfile(validProfile());
  assert.equal(decoded.ok, true);
});

test("未知字段直接失败（严格模式）", () => {
  const decoded = decodeBuildProfile(validProfile({ extraBucket: "x" }));
  assert.equal(decoded.ok, false);
  assert.match(decoded.errors[0].path, /extraBucket/);
});

test("keyId 必须等于 sha256(SPKI)[:16]", () => {
  const decoded = decodeBuildProfile(validProfile({ extensionTrust: { officialKeys: [{ keyId: "0000000000000000", publicKey: PUBKEY }] } }));
  assert.equal(decoded.ok, false);
  assert.match(decoded.errors.at(-1).message, /keyId/);
});

test("禁止密钥字段与 PEM 私钥", () => {
  assert.equal(decodeBuildProfile(validProfile({ apiKey: "x" })).ok, false);
  // 拼出来，避免仓库里出现完整的 PEM 私钥头字面量（public boundary 门禁会告警）。
  const pemHeader = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
  const decoded = decodeBuildProfile(validProfile({ dev: { remoteServerUrl: pemHeader } }));
  assert.equal(decoded.ok, false);
});

test("cdn 路径约束：基址以 / 结尾，updatePath 必须含 {platformKey}", () => {
  assert.equal(decodeBuildProfile(validProfile({ cdn: { baseUrl: "https://cos.example.com", runtimePath: "r/", updatePath: "u/{platformKey}/latest.json" } })).ok, false);
  assert.equal(decodeBuildProfile(validProfile({ cdn: { baseUrl: "https://cos.example.com/", runtimePath: "r/", updatePath: "u/latest.json" } })).ok, false);
});

test("joinUrl 恰好一个斜杠", () => {
  assert.equal(joinUrl("https://a.com/x/", "y/"), "https://a.com/x/y/");
  assert.equal(joinUrl("https://a.com/x", "/y/"), "https://a.com/x/y/");
});

test("updaterPlatformKey 覆盖三平台", () => {
  assert.equal(updaterPlatformKey({ platform: "darwin", arch: "arm64" }), "darwin-aarch64");
  assert.equal(updaterPlatformKey({ platform: "darwin", arch: "x64" }), "darwin-x86_64");
  assert.equal(updaterPlatformKey({ platform: "win32", arch: "x64" }), "windows-x86_64");
  assert.equal(updaterPlatformKey({ platform: "aix", arch: "x" }), null);
});

test("没有 profile 时返回空 resolved，而不是假默认值", () => {
  const loaded = loadBuildProfile({ repoRoot: sandbox(undefined) });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.profile.profileId, "empty");
  assert.equal(loaded.resolved.runtimeCdnUrl, "");
  assert.equal(loaded.resolved.updateEndpointTemplate, "");
});

test("committed 与 local 的优先级：local 覆盖 committed", () => {
  const repoRoot = sandbox(validProfile({ profileId: "committed" }));
  writeFileSync(path.join(repoRoot, "build-profile.local.json"), JSON.stringify(validProfile({ profileId: "local" })));
  const loaded = loadBuildProfile({ repoRoot });
  assert.equal(loaded.profile.profileId, "local");
  assert.equal(loaded.source, "local");
});

test("env 指定的 profile 必须存在，缺失即失败", () => {
  const repoRoot = sandbox(validProfile());
  const loaded = loadBuildProfile({ repoRoot, env: { WOOHAA3_BUILD_PROFILE: "nope.json" } });
  assert.equal(loaded.ok, false);
  assert.match(loaded.errors[0].message, /不存在/);
});

test("env 只作为已解析值的覆盖，并被记录", () => {
  const loaded = loadBuildProfile({
    repoRoot: sandbox(validProfile()),
    env: { WOOHAA_RUNTIME_CDN_BASE_URL: "https://override.example.com/runtimes/" }
  });
  assert.equal(loaded.resolved.runtimeCdnUrl, "https://override.example.com/runtimes/");
  assert.deepEqual(loaded.overrides.map(entry => entry.field), ["runtimeCdnUrl"]);
  assert.match(describeBuildProfile(loaded), /env-overrides=runtimeCdnUrl/);
});

test("updateEndpointFor 展开平台键，缺平台键时抛错", () => {
  const loaded = loadBuildProfile({ repoRoot: sandbox(validProfile()) });
  assert.equal(
    updateEndpointFor(loaded.resolved, "darwin-aarch64"),
    "https://cos.example.com/woohaa/updates/stable/darwin-aarch64/latest.json"
  );
  assert.throws(() => updateEndpointFor(loaded.resolved, null), /平台键/);
});

test("extensions.defaultEnabled 解码通过，非法 id 与非布尔值被拒", () => {
  assert.equal(decodeBuildProfile(validProfile({ extensions: { defaultEnabled: { "task-activity": false } } })).ok, true);
  assert.equal(decodeBuildProfile(validProfile({ extensions: { defaultEnabled: { "Film Set": false } } })).ok, false);
  assert.equal(decodeBuildProfile(validProfile({ extensions: { defaultEnabled: { "task-activity": "no" } } })).ok, false);
  assert.equal(decodeBuildProfile(validProfile({ extensions: { other: {} } })).ok, false);
});

test("siteDefaultEnabled 单独解码，且与 catalog 默认值不混用", () => {
  const loaded = loadBuildProfile({
    repoRoot: sandbox(validProfile({ extensions: { siteDefaultEnabled: { "remote-server": false } } }))
  });
  assert.deepEqual(loaded.resolved.siteExtensionDefaults, { "remote-server": false });
  assert.deepEqual(loaded.resolved.extensionDefaults, {});
  assert.equal(decodeBuildProfile(validProfile({ extensions: { siteDefaultEnabled: { "remote-server": "off" } } })).ok, false);
});

test("resolved.extensionDefaults 与 cdnBaseUrl", () => {
  const loaded = loadBuildProfile({
    repoRoot: sandbox(validProfile({ extensions: { defaultEnabled: { "remote-server": false } } }))
  });
  assert.deepEqual(loaded.resolved.extensionDefaults, { "remote-server": false });
  assert.equal(loaded.resolved.cdnBaseUrl, "https://cos.example.com/");
});

test("buildDefines 注入官方信任根；没有常量时为 null", () => {
  const withBoth = loadBuildProfile({
    repoRoot: sandbox(validProfile())
  });
  const defines = buildDefines(withBoth.resolved);
  assert.deepEqual(Object.keys(defines).sort(), ["__WOOHAA3_OFFICIAL_TRUST_KEYS__"]);
  assert.deepEqual(defines.__WOOHAA3_OFFICIAL_TRUST_KEYS__, [{ keyId: KEY_ID, publicKey: PUBKEY }]);

  const empty = loadBuildProfile({ repoRoot: sandbox({ schemaVersion: 1, profileId: "bare" }) });
  assert.equal(buildDefines(empty.resolved), null);
});

test("settings 默认值解码并进入 buildDefines；非法键与密钥字段被拒", () => {
  const settings = { "exposer.primary": "auto", "storage.primary": "local" };
  const loaded = loadBuildProfile({ repoRoot: sandbox(validProfile({ settings })) });
  assert.deepEqual(loaded.resolved.settingDefaults, settings);
  assert.deepEqual(buildDefines(loaded.resolved).__WOOHAA3_SETTING_DEFAULTS__, settings);
  assert.equal(decodeBuildProfile(validProfile({ settings: { "bad key": true } })).ok, false);
  assert.equal(decodeBuildProfile(validProfile({ settings: { "a.b": [] } })).ok, false);
  assert.equal(decodeBuildProfile(validProfile({ settings: { "provider.token": "x" } })).ok, false);
});

test("已移除的公开桶构建配置被拒绝", () => {
  assert.equal(decodeBuildProfile(validProfile({ publicBucket: { bucketName: "b", bucketUrl: "https://b.example.com", prefix: "p" } })).ok, false);
});
