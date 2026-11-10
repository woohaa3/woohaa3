import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const clientRoot = fileURLToPath(new URL("../", import.meta.url));

function build(t, desktop, overrides = {}, args = [], windows = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-trust-preflight-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profile = path.join(directory, "build-profile.json");
  fs.writeFileSync(profile, JSON.stringify({ schemaVersion: 1, profileId: "ci-test", desktop }));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (["WOOHAA_DESKTOP_TRUST_UNAMANAGED", "WOOHAA3_EXTENSION_TRUST_CONFIG", "WOOHAA_DESKTOP_PROJECT_DIR"].includes(name.toUpperCase())) delete env[name];
  }
  // Exercise Windows platform selection without invoking native tools on the test host.
  const launcher = windows ? ["--input-type=module", "-e", `
    import { pathToFileURL } from 'node:url';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    await import(pathToFileURL(process.argv[1]).href);
  `] : [];
  const result = spawnSync(process.execPath, [...launcher, path.join(clientRoot, "scripts/build-desktop.mjs"), "--frontend", path.join(directory, "missing-frontend"), ...args], {
    cwd: directory,
    env: { ...env, WOOHAA3_BUILD_PROFILE: profile, ...overrides },
    encoding: "utf8",
    timeout: 15_000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  return result;
}

test("direct desktop build uses the release profile without running a CI wrapper", t => {
  const result = build(t, { allowUnmanagedExtensionTrust: true });
  assert.match(result.stdout, /extension trust: v1 compatibility/);
  // The deliberately missing frontend stops the build after preflight, before any compilation.
  assert.match(result.stderr, /前端产物缺失/);
  assert.doesNotMatch(result.stderr, /发布版桌面必须固定扩展信任根/);
});

test("Windows desktop preflight also uses the profile when the cmd wrapper is bypassed", t => {
  const result = build(t, { allowUnmanagedExtensionTrust: true }, {}, [], true);
  assert.match(result.stdout, /extension trust: v1 compatibility/);
  assert.match(result.stderr, /前端产物缺失/);
  assert.doesNotMatch(result.stderr, /发布版桌面必须固定扩展信任根/);
});

test("missing release trust is rejected before frontend or native compilation", t => {
  const result = build(t, {}, {}, ["--build-frontend"]);
  assert.match(result.stderr, /发布版桌面必须固定扩展信任根/);
  assert.doesNotMatch(result.stdout, /构建前端与扩展发布产物|\[desktop\] \$/);
});

test("an invalid CI override is reported even when the release profile allows v1", t => {
  const result = build(t, { allowUnmanagedExtensionTrust: true }, { WOOHAA_DESKTOP_TRUST_UNAMANAGED: "false" }, ["--build-frontend"]);
  assert.match(result.stderr, /当前 WOOHAA_DESKTOP_TRUST_UNAMANAGED="false"/);
  assert.doesNotMatch(result.stdout, /构建前端与扩展发布产物|\[desktop\] \$/);
});
