/**
 * 桌面发行打包单测
 * （change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，任务 6.7 / 6.9 的打包前置）。
 *
 * 运行：`node --test scripts/desktop-release.test.mjs`
 *
 * 只覆盖不依赖 Rust/GPU/网络的部分：参数解析与拒绝、平台 bundle 目标收窄、图标与资源清单、
 * 产物路径推导、文件/目录哈希确定性、manifest 形状。真实的 `tauri build` 产物不在单测里断言。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUNDLE_OUTPUT_DIRS,
  DESKTOP_DEFAULTS_RESOURCE,
  MIN_ICON_SOURCE_SIZE,
  buildDefaultsDocument,
  buildDesktopManifest,
  bundleOutputDir,
  clearBundleOutputDirs,
  collectBundleArtifacts,
  formatCommand,
  hashPath,
  missingBundleKinds,
  missingIcons,
  parseDesktopArgs,
  platformSupportError,
  readPngSize,
  releaseIdFor,
  resolveBundleKinds,
  tauriBuildArgs,
  tauriConfigOverride,
  tauriFrontendDist,
  validateIconSource
} from "./lib/desktop-release.mjs";

/** 只构造 `readPngSize` 需要的头部，用于图标源校验的单测。 */
function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("参数解析给出缺省值，并支持 --name=value 与 --name value", () => {
  const defaults = parseDesktopArgs([]);
  assert.deepEqual(
    { mode: defaults.mode, uiUrl: defaults.uiUrl, bundle: defaults.bundle, debug: defaults.debug, dryRun: defaults.dryRun },
    { mode: "build", uiUrl: null, bundle: true, debug: false, dryRun: false }
  );
  const spaced = parseDesktopArgs(["--ui-url", "http://127.0.0.1:5180/", "--bundles", "app", "--debug", "--dry-run"]);
  assert.equal(spaced.uiUrl, "http://127.0.0.1:5180/");
  assert.equal(spaced.bundles, "app");
  assert.equal(spaced.debug, true);
  assert.equal(spaced.dryRun, true);
  const inline = parseDesktopArgs(["--ui-url=http://127.0.0.1:5180/app/", "--no-bundle"]);
  assert.equal(inline.uiUrl, "http://127.0.0.1:5180/app/");
  assert.equal(inline.bundle, false);
});

test("参数解析拒绝未知开关、缺值、重复与非法地址", () => {
  assert.throws(() => parseDesktopArgs(["--nope"]), /未知参数/);
  assert.throws(() => parseDesktopArgs(["--ui-url"]), /需要取值/);
  assert.throws(() => parseDesktopArgs(["--ui-url", "http://a/", "--ui-url", "http://b/"]), /重复/);
  assert.throws(() => parseDesktopArgs(["--debug=1"]), /不接受取值/);
  // 只有 http/https 能进 bundle 默认值：file/javascript 之类不得被当作界面地址。
  assert.throws(() => parseDesktopArgs(["--ui-url", "file:///etc/passwd"]), /只接受 http\/https/);
  assert.throws(() => parseDesktopArgs(["--ui-url", "not-a-url"]), /不是合法 URL/);
});

test("--backend-url 只用于推导同源界面地址", () => {
  const options = parseDesktopArgs(["--backend-url", "http://127.0.0.1:5180"]);
  assert.equal(options.backendUrl, "http://127.0.0.1:5180/");
  assert.equal(options.uiUrl, "http://127.0.0.1:5180/");
  // 显式 --ui-url 优先，不会被 backend-url 覆盖。
  const explicit = parseDesktopArgs(["--backend-url", "http://127.0.0.1:5180", "--ui-url", "http://127.0.0.1:5173/app/"]);
  assert.equal(explicit.uiUrl, "http://127.0.0.1:5173/app/");
});

test("bundle 目标按平台给缺省，显式值只能收窄", () => {
  assert.deepEqual(resolveBundleKinds({ platform: "darwin", requested: null, bundle: true }), ["app", "dmg"]);
  assert.deepEqual(resolveBundleKinds({ platform: "linux", requested: null, bundle: true }), ["deb", "rpm", "appimage"]);
  assert.deepEqual(resolveBundleKinds({ platform: "darwin", requested: "app, dmg", bundle: true }), ["app", "dmg"]);
  assert.deepEqual(resolveBundleKinds({ platform: "darwin", requested: "app,app", bundle: true }), ["app"]);
  assert.deepEqual(resolveBundleKinds({ platform: "darwin", requested: null, bundle: false }), []);
  assert.throws(() => resolveBundleKinds({ platform: "darwin", requested: "deb", bundle: true }), /不适用于 darwin/);
  assert.equal(platformSupportError("win32"), null);
  assert.equal(platformSupportError("linux"), null);
});

test("图标清单按平台判定缺失项", () => {
  const absent = () => false;
  assert.deepEqual(missingIcons({ iconsDir: "/icons", platform: "darwin", exists: absent }), [
    "icon.icns",
    "128x128.png",
    "128x128@2x.png"
  ]);
  const present = () => true;
  assert.deepEqual(missingIcons({ iconsDir: "/icons", platform: "linux", exists: present }), []);
  // Linux 不需要 icns；darwin 只要列出的三个文件。
  assert.deepEqual(
    missingIcons({ iconsDir: "/icons", platform: "linux", exists: name => !name.endsWith("icon.icns") }),
    []
  );
});

test("图标源必须是正方形且不小于下限", () => {
  assert.deepEqual(readPngSize(pngHeader(1024, 1024)), { width: 1024, height: 1024 });
  assert.deepEqual(validateIconSource({ buffer: pngHeader(MIN_ICON_SOURCE_SIZE, MIN_ICON_SOURCE_SIZE) }), {
    width: MIN_ICON_SOURCE_SIZE,
    height: MIN_ICON_SOURCE_SIZE
  });
  assert.throws(() => validateIconSource({ buffer: pngHeader(32, 32) }), /至少需要 1024×1024/);
  assert.throws(() => validateIconSource({ buffer: pngHeader(1024, 512) }), /必须为正方形/);
  assert.throws(() => readPngSize(Buffer.from("not a png")), /不是 PNG/);
});

test("bundle 默认值文档与 tauri 配置覆盖保持最小面", () => {
  assert.deepEqual(buildDefaultsDocument({ uiUrl: null }), { version: 1, uiUrl: null });
  assert.deepEqual(buildDefaultsDocument({ uiUrl: "http://127.0.0.1:5180/" }), {
    version: 1,
    uiUrl: "http://127.0.0.1:5180/"
  });
  assert.deepEqual(tauriConfigOverride({}), {});
  const override = tauriConfigOverride({
    identifier: "com.woohaa.desktop",
    version: "1.2.3",
    frontendDist: "/tmp/dist",
    defaultsPath: "/tmp/packaging/woohaa-desktop.defaults.json"
  });
  assert.deepEqual(override, {
    identifier: "com.woohaa.desktop",
    version: "1.2.3",
    build: { frontendDist: "/tmp/dist" },
    bundle: { resources: { "/tmp/packaging/woohaa-desktop.defaults.json": DESKTOP_DEFAULTS_RESOURCE } }
  });
});

test("tauri build 参数把 bundle 种类与配置覆盖显式传入", () => {
  const options = { debug: false, target: null, bundle: true };
  assert.deepEqual(tauriBuildArgs({ options, kinds: ["app", "dmg"], config: {} }), ["build", "--bundles", "app,dmg"]);
  assert.deepEqual(
    tauriBuildArgs({ options: { debug: true, target: "universal-apple-darwin", bundle: true }, kinds: ["app"], config: { identifier: "a.b" } }),
    ["build", "--debug", "--target", "universal-apple-darwin", "--bundles", "app", "--config", '{"identifier":"a.b"}']
  );
  assert.deepEqual(
    tauriBuildArgs({ options: { debug: false, target: null, bundle: false }, kinds: [], config: {} }),
    ["build", "--no-bundle"]
  );
  // 不产出安装包时也要能编译出可执行文件，因此 --no-bundle 与 --bundles 不同时出现。
  const noBundleWithKinds = tauriBuildArgs({ options: { debug: false, target: null, bundle: false }, kinds: [], config: {} });
  assert.ok(!noBundleWithKinds.includes("--bundles"));
});

test("release 标识与产物目录按平台/架构/profile 推导", () => {
  const id = releaseIdFor({ platform: "darwin", arch: "arm64", now: new Date("2026-10-18T09:30:15.123Z") });
  assert.equal(id, "desktop-20261018-093015-darwin-arm64");
  const desktopDir = "/repo/desktop";
  assert.equal(
    bundleOutputDir({ desktopDir, debug: false, kind: "app" }),
    path.join(desktopDir, "target", "release", "bundle", BUNDLE_OUTPUT_DIRS.app)
  );
  assert.equal(
    bundleOutputDir({ desktopDir, target: "aarch64-unknown-linux-gnu", debug: true, kind: "deb" }),
    path.join(desktopDir, "target", "aarch64-unknown-linux-gnu", "debug", "bundle", "deb")
  );
  assert.throws(() => bundleOutputDir({ desktopDir, kind: "msi" }), /未知 bundle 种类/);
});

test("产物收集取 bundle 目录的实际条目，不按产品名写死", t => {
  const desktopDir = tmpDir(t);
  const macos = path.join(desktopDir, "target/release/bundle/macos");
  const dmg = path.join(desktopDir, "target/release/bundle/dmg");
  fs.mkdirSync(path.join(macos, "WooHaa3.app/Contents/MacOS"), { recursive: true });
  fs.mkdirSync(dmg, { recursive: true });
  fs.writeFileSync(path.join(macos, "WooHaa3.app/Contents/MacOS/woohaa-desktop"), "bin");
  fs.writeFileSync(path.join(dmg, "WooHaa3_0.1.0_aarch64.dmg"), "dmg");

  const artifacts = collectBundleArtifacts({ desktopDir, debug: false, kinds: ["app", "dmg"] });
  assert.deepEqual(
    artifacts.map(entry => `${entry.kind}:${entry.name}`).sort(),
    ["app:WooHaa3.app", "dmg:WooHaa3_0.1.0_aarch64.dmg"]
  );
  // 只请求一个种类时不顺手读另一个目录。
  assert.deepEqual(collectBundleArtifacts({ desktopDir, debug: false, kinds: ["dmg"] }).map(entry => entry.kind), ["dmg"]);
});

test("缺失的 bundle 目录被准确报告，而不是抛裸 ENOENT", t => {
  const desktopDir = tmpDir(t);
  const macos = path.join(desktopDir, "target/release/bundle/macos");
  fs.mkdirSync(path.join(macos, "WooHaa3.app"), { recursive: true });

  // 请求 app+dmg，但 dmg 目录不存在：不抛异常，只把 dmg 列为缺失。
  const artifacts = collectBundleArtifacts({ desktopDir, debug: false, kinds: ["app", "dmg"] });
  assert.deepEqual(artifacts.map(entry => entry.kind), ["app"]);
  const missing = missingBundleKinds({ desktopDir, debug: false, kinds: ["app", "dmg"], artifacts });
  assert.deepEqual(missing.map(entry => entry.kind), ["dmg"]);
  assert.ok(missing[0].dir.endsWith(path.join("bundle", "dmg")));
  // 目录存在但为空也算缺失（tauri 声称成功却没落盘）。
  fs.mkdirSync(path.join(desktopDir, "target/release/bundle/dmg"), { recursive: true });
  assert.deepEqual(
    missingBundleKinds({ desktopDir, debug: false, kinds: ["dmg"], artifacts: collectBundleArtifacts({ desktopDir, debug: false, kinds: ["dmg"] }) }).map(entry => entry.kind),
    ["dmg"]
  );
});

test("hashPath 对文件与目录都稳定，且区分内容与符号链接目标", async t => {
  const root = tmpDir(t);
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "hello");
  const first = await hashPath(file);
  assert.equal(first.bytes, 5);
  assert.equal(first.sha256, (await hashPath(file)).sha256);

  const tree = path.join(root, "tree");
  fs.mkdirSync(path.join(tree, "nested"), { recursive: true });
  fs.writeFileSync(path.join(tree, "nested", "b.txt"), "b");
  fs.symlinkSync("nested/b.txt", path.join(tree, "link.txt"));
  const treeHash = await hashPath(tree);
  assert.ok(treeHash.sha256.length === 64);
  assert.equal(treeHash.bytes, 1);

  // 改名/改内容/改链接目标都会改变目录哈希（用于比对同一产物是否变化）。
  fs.writeFileSync(path.join(tree, "nested", "b.txt"), "c");
  assert.notEqual((await hashPath(tree)).sha256, treeHash.sha256);
  fs.writeFileSync(path.join(tree, "nested", "b.txt"), "b");
  fs.rmSync(path.join(tree, "link.txt"));
  fs.symlinkSync("nested", path.join(tree, "link.txt"));
  assert.notEqual((await hashPath(tree)).sha256, treeHash.sha256);
});

test("manifest 明确区分已产出与未验证项", async t => {
  const manifest = buildDesktopManifest({
    releaseId: "desktop-x",
    createdAt: "2026-10-18T00:00:00.000Z",
    product: { name: "WooHaa3", version: "0.1.0", identifier: "com.woohaa.desktop" },
    platform: { os: "darwin", arch: "arm64" },
    toolchain: { rust: "rustc 1.97.1", tauriCli: "2.12.3" },
    frontend: { dist: "web/frontend/dist", indexSha256: "a".repeat(64), source: "prebuilt" },
    bootstrap: { uiUrl: null, defaultsResource: DESKTOP_DEFAULTS_RESOURCE, precedence: ["--ui-url"] },
    artifacts: [{ kind: "app", name: "WooHaa3.app", path: "desktop/target/release/bundle/macos/WooHaa3.app", sha256: "b".repeat(64), bytes: 1 }],
    bundles: ["app"],
    target: null,
    debug: false,
    notes: ["n"]
  });
  assert.equal(manifest.platform.targetTriple, null);
  assert.equal(manifest.build.bundles[0], "app");
  assert.equal(manifest.hostPackage.status, "not-packaged");
  assert.equal(manifest.verification.rendering, "pending-manual");
  assert.match(manifest.verification.note, /不得声称通过/);
  assert.deepEqual(manifest.notes, ["n"]);
  // 不传 hostPackage 时给出同一份「未随包发布」的事实，而不是空字段。
  const minimal = buildDesktopManifest({
    releaseId: "x",
    createdAt: "now",
    product: {},
    platform: {},
    toolchain: {},
    frontend: {},
    bootstrap: {},
    artifacts: [],
    bundles: []
  });
  assert.equal(minimal.hostPackage.status, "not-packaged");
  assert.ok(t);
});

test("命令格式化对含空格/引号的参数加引号", () => {
  assert.equal(formatCommand("tauri", ["build", "--bundles", "app,dmg"]), "tauri build --bundles app,dmg");
  assert.equal(formatCommand("tauri", ["build", "--config", '{"bundle":{}}']), 'tauri build --config \'{"bundle":{}}\'');
});

test('Windows x64 uses NSIS and rejects cross-platform or architecture packaging', async () => {
  const { nativeTargetError } = await import('./lib/desktop-release.mjs');
  assert.equal(platformSupportError('win32'), null);
  assert.deepEqual(resolveBundleKinds({platform:'win32', bundle:true}), ['nsis']);
  assert.deepEqual(missingIcons({iconsDir:'/icons',platform:'win32',exists:()=>false}), ['icon.ico']);
  assert.equal(nativeTargetError({platform:'win32',arch:'x64',target:'x86_64-pc-windows-msvc'}), null);
  assert.match(nativeTargetError({platform:'win32',arch:'x64',target:'aarch64-pc-windows-msvc'}), /native/);
  assert.match(nativeTargetError({platform:'darwin',arch:'arm64',target:'x86_64-pc-windows-msvc'}), /native/);
});

test('Windows NSIS collector includes actual executable and signature', t => {
 const desktopDir=tmpDir(t); const dir=path.join(desktopDir,'target/release/bundle/nsis');
 fs.mkdirSync(dir,{recursive:true}); for(const name of ['Custom_1.2.3_x64-setup.exe','Custom_1.2.3_x64-setup.exe.sig']) fs.writeFileSync(path.join(dir,name),'x');
 assert.deepEqual(collectBundleArtifacts({desktopDir,kinds:['nsis']}).map(a=>a.name).sort(),['Custom_1.2.3_x64-setup.exe','Custom_1.2.3_x64-setup.exe.sig']);
});

test('构建前清空本次 bundle 目录，避免上一版安装包混进 manifest 与上传目录', t => {
  const desktopDir = tmpDir(t);
  const nsis = bundleOutputDir({ desktopDir, kind: 'nsis' });
  const dmg = bundleOutputDir({ desktopDir, kind: 'dmg' });
  fs.mkdirSync(nsis, { recursive: true });
  fs.mkdirSync(dmg, { recursive: true });
  // 上一版残留（0.1.8）+ 另一个未请求的种类（dmg）。
  for (const name of ['WooHaa3_0.1.8_x64-setup.exe', 'WooHaa3_0.1.8_x64-setup.exe.sig']) {
    fs.writeFileSync(path.join(nsis, name), 'old');
  }
  fs.writeFileSync(path.join(dmg, 'WooHaa3_0.1.8_aarch64.dmg'), 'old-dmg');

  clearBundleOutputDirs({ desktopDir, debug: false, kinds: ['nsis'] });
  assert.equal(fs.existsSync(nsis), false);
  // 只清本次请求的种类，别顺手删掉别的产物。
  assert.equal(fs.existsSync(path.join(dmg, 'WooHaa3_0.1.8_aarch64.dmg')), true);

  // 清空后重新产物：manifest 只会看到本次构建写进去的那一个。
  fs.mkdirSync(nsis, { recursive: true });
  for (const name of ['WooHaa3_0.1.9_x64-setup.exe', 'WooHaa3_0.1.9_x64-setup.exe.sig']) {
    fs.writeFileSync(path.join(nsis, name), 'new');
  }
  const artifacts = collectBundleArtifacts({ desktopDir, debug: false, kinds: ['nsis'] });
  assert.deepEqual(artifacts.map(entry => entry.name).sort(), ['WooHaa3_0.1.9_x64-setup.exe', 'WooHaa3_0.1.9_x64-setup.exe.sig']);
  assert.equal(artifacts.filter(entry => entry.name.endsWith('.exe')).length, 1);
});

test('pnpm argument separator is accepted before desktop build flags', () => {
  assert.equal(parseDesktopArgs(['--', '--build-frontend']).buildFrontend, true);
});

test("frontendDist keeps Windows startup assets as a directory rather than a drive-letter URL", () => {
  const desktop = String.raw`E:\data\landun\workspace\src\woohaa3\desktop`;
  const startup = path.win32.join(desktop, "build", "packaging-signed-win32-x64", "startup-frontend");
  const relative = tauriFrontendDist(startup, desktop, path.win32);
  assert.equal(relative, "./build/packaging-signed-win32-x64/startup-frontend");
  assert.equal(URL.canParse(relative), false);
  assert.equal(path.win32.resolve(desktop, relative), startup);
  assert.equal(tauriFrontendDist(path.win32.join(desktop, "..", "web", "frontend", "dist"), desktop, path.win32), "./../web/frontend/dist");
  assert.throws(() => tauriFrontendDist(String.raw`F:\startup`, desktop, path.win32), /同一盘符/);
  assert.equal(tauriFrontendDist("/tmp/desktop/build/startup", "/tmp/desktop", path.posix), "./build/startup");
});

test('external composition bundle discovery honors the Cargo target directory', () => {
  const targetDir = path.resolve('/tmp/custom-native-cache');
  assert.equal(bundleOutputDir({ desktopDir:path.resolve('/tmp/composition/host'), targetDir, kind:'app' }), path.join(targetDir,'release/bundle/macos'));
});
