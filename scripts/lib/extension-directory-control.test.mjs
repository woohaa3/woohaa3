import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionDirectoryControl } from './extension-directory-control.mjs';
import { scanExtensions } from './extension-scan.mjs';

/**
 * 目录只表达「装没装」：面板里的启用/停用走站点控制面，不在这里。
 * 这里只验证安装/卸载的改名语义、可写根约束与冲突保护。
 */
function fixture(t, { writable = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const add = (name, descriptor = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const id = name.replace(/^\./, '');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@woohaa3/extension-${id}` }));
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ extensionId: id, ...descriptor }));
    return dir;
  };
  return {
    root,
    add,
    control: (options = {}) =>
      createExtensionDirectoryControl({ roots: [root], writableRoots: writable ? [root] : [], ...options })
  };
}

test('列表只含已安装扩展，不含启用状态；点前缀目录视为未安装', (t) => {
  const f = fixture(t);
  f.add('one', { site: { name: '样例', description: '测试' } });
  f.add('.two');
  const rows = f.control().list();
  assert.deepEqual(rows.map((row) => row.id), ['one']);
  assert.equal(rows[0].label, '样例');
  assert.equal(rows[0].writable, true);
  assert.ok(!('enabled' in rows[0]) && !('pendingRestart' in rows[0]), '安装态不携带启停字段');
});

test('插件清单解析图标：browser metadata 优先，其次品牌图形路径与语义 glyph', (t) => {
  const f = fixture(t);
  f.add('browser-icon', { icon: { glyph: 'storage' } });
  fs.mkdirSync(path.join(f.root, 'browser-icon', 'browser-dist'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'browser-icon', 'browser-dist', 'artifact-manifest.json'), JSON.stringify({ metadata: { icon: 'film' } }));
  f.add('brand', { icon: { asset: './assets/icon.png' } });
  f.add('glyph', { icon: { glyph: 'storage' } });
  f.add('plain');
  const rows = f.control().list();
  assert.equal(rows.find((row) => row.id === 'browser-icon').icon, 'film');
  assert.equal(rows.find((row) => row.id === 'brand').icon, '/plugin-icons/brand.png');
  assert.equal(rows.find((row) => row.id === 'glyph').icon, 'storage');
  assert.ok(!('icon' in rows.find((row) => row.id === 'plain')));
});

test('插件清单带出版本：site.version > 可信元数据 > 浏览器产物 > package.json', (t) => {
  const f = fixture(t);
  const withPackageVersion = (name, version, descriptor = {}) => {
    const dir = f.add(name, descriptor);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@woohaa3/extension-${name}`, version }));
    return dir;
  };
  // 站点声明的版本是部署口径：同时有 provider metadata 版本时以 site.version 为准。
  withPackageVersion('both-version', '0.1.0', { site: { name: '站点声明', description: '', version: '1.2.0' } });
  const browser = withPackageVersion('browser-version', '0.1.0');
  fs.mkdirSync(path.join(browser, 'browser-dist'), { recursive: true });
  fs.writeFileSync(path.join(browser, 'browser-dist', 'artifact-manifest.json'),
    JSON.stringify({ metadata: { extensionId: 'browser-version', version: '2.0.0' } }));
  withPackageVersion('package-version', '3.4.5');
  withPackageVersion('trusted-version', '0.1.0');
  const control = f.control({ metadata: [
    { extensionId: 'both-version', name: '站点声明', version: '9.9.9' },
    { extensionId: 'trusted-version', name: '可信元数据', version: '8.8.8' }
  ] });
  const versions = Object.fromEntries(control.list().map((row) => [row.id, row.version]));
  assert.equal(versions['both-version'], '1.2.0', 'extension.json 的 site.version 优先于 provider metadata');
  assert.equal(versions['trusted-version'], '8.8.8', '没有 site 段时用已加载的可信元数据');
  assert.equal(versions['browser-version'], '2.0.0', 'browser 产物 metadata 优先于包版本');
  assert.equal(versions['package-version'], '3.4.5', '没有声明时回落到 package.json');
});

test('没有版本声明或版本是空白时不带 version 字段，也不展示空版本', (t) => {
  const f = fixture(t);
  f.add('no-version');
  const blank = f.add('blank-version');
  fs.writeFileSync(path.join(blank, 'package.json'), JSON.stringify({ name: '@woohaa3/extension-blank-version', version: '   ' }));
  const rows = f.control({ metadata: [{ extensionId: 'no-version', name: '无版本', version: '  ' }] }).list();
  for (const row of rows) assert.ok(!('version' in row), `${row.id} 不应带空版本`);
});

test('既无 extension.json 也无 browser 产物的包不是插件；browser-only 扩展仍进清单', (t) => {
  const f = fixture(t);
  f.add('declared');
  const shared = path.join(f.root, 'shared-lib');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'package.json'), JSON.stringify({ name: '@woohaa3/extension-shared-lib' }));
  const browserOnly = path.join(f.root, 'browser-only');
  fs.mkdirSync(path.join(browserOnly, 'browser-dist'), { recursive: true });
  fs.writeFileSync(path.join(browserOnly, 'package.json'), JSON.stringify({ name: '@woohaa3/extension-browser-only' }));
  fs.writeFileSync(path.join(browserOnly, 'browser-dist', 'artifact-manifest.json'), JSON.stringify({ metadata: { extensionId: 'browser-only', label: '浏览器扩展', description: '只在前端装配', icon: 'chat' } }));
  const control = f.control();
  assert.deepEqual(control.list().map((row) => row.id), ['browser-only', 'declared']);
  assert.equal(control.list().find((row) => row.id === 'browser-only').icon, 'chat');
  assert.throws(() => control.setInstalled('shared-lib', false), /不存在/);
});

test('卸载写点前缀、安装去掉前缀，并落到下一次扫描', (t) => {
  const f = fixture(t);
  f.add('one');
  const control = f.control();
  control.setInstalled('one', false);
  assert.ok(fs.existsSync(path.join(f.root, '.one')));
  assert.equal(scanExtensions({ repoRoot: f.root, env: { WOOHAA3_EXTENSION_DIRS: f.root } }).extensions.length, 0);
  f.control().setInstalled('one', true);
  assert.ok(fs.existsSync(path.join(f.root, 'one')));
  assert.equal(scanExtensions({ repoRoot: f.root, env: { WOOHAA3_EXTENSION_DIRS: f.root } }).extensions.length, 1);
});

test('改名只动目录，不执行插件代码也不丢文件', (t) => {
  const f = fixture(t);
  const dir = f.add('.one');
  fs.writeFileSync(path.join(dir, 'index.js'), 'throw new Error("不得执行");');
  f.control().setInstalled('one', true);
  assert.equal(fs.readFileSync(path.join(f.root, 'one/index.js'), 'utf8'), 'throw new Error("不得执行");');
});

test('目录冲突不覆盖已有内容；拒绝未知身份', (t) => {
  const f = fixture(t);
  f.add('one');
  fs.mkdirSync(path.join(f.root, '.one'));
  const control = f.control();
  assert.throws(() => control.setInstalled('one', false), /目标目录已存在/);
  assert.throws(() => control.setInstalled('../one', false), /不存在/);
  assert.deepEqual(control.list().map((row) => row.id), ['one']);
});

test('非可写根拒绝安装/卸载（只有可写根允许改目录）', (t) => {
  const f = fixture(t, { writable: false });
  f.add('one');
  const control = f.control();
  assert.equal(control.list()[0].writable, false);
  assert.throws(() => control.setInstalled('one', false), (error) => error.code === 'EXTENSION_DIRECTORY_READONLY');
  assert.ok(fs.existsSync(path.join(f.root, 'one')), '目录保持不变');
});

test('基础提供者、依赖和跨根重复身份阻止不安全改名', (t) => {
  const f = fixture(t);
  f.add('base', { bootstrap: { module: './bootstrap' } });
  f.add('one');
  f.add('two', { site: { dependencies: ['one'] } });
  const control = f.control();
  assert.throws(() => control.setInstalled('base', false), /基础提供者/);
  assert.throws(() => control.setInstalled('one', false), /先卸载/);
  control.setInstalled('two', false);
  control.setInstalled('one', false);
  assert.throws(() => control.setInstalled('two', true), /先安装/);
  f.add('.base');
  assert.throws(() => control.setInstalled('base', false), /重复/);
});

test('不把软链和普通隐藏目录当成可管理扩展', (t) => {
  const f = fixture(t);
  f.add('one');
  fs.mkdirSync(path.join(f.root, '.cache'));
  fs.symlinkSync(path.join(f.root, 'one'), path.join(f.root, 'alias'));
  assert.deepEqual(f.control().list().map((row) => row.id), ['one']);
});

test('改名通知让当前进程能继续托管已发布资源', (t) => {
  const f = fixture(t);
  const dir = f.add('one');
  const calls = [];
  const control = f.control({ onRename: (...args) => calls.push(args) });
  control.setInstalled('one', false);
  assert.deepEqual(calls, [[dir, path.join(f.root, '.one')]]);
});

test('开发者扩展进入安装清单并覆盖同名安装目录，禁止改名源码', (t) => {
  const f = fixture(t);
  f.add('sample');
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-dev-'));
  t.after(() => fs.rmSync(dev, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dev, 'extension.json'), JSON.stringify({ extensionId: 'sample', version: '2.0.0', site: { name: '开发样例', description: '开发目录' } }));
  const control = f.control({ devExtensions: [{ extensionId: 'sample', dir: dev }] });
  assert.deepEqual(control.list().map(({ id, directory, label, version, writable }) => ({ id, directory, label, version, writable })), [
    { id: 'sample', directory: dev, label: '开发样例', version: '2.0.0', writable: false }
  ]);
  assert.throws(() => control.setInstalled('sample', false), { code: 'EXTENSION_DIRECTORY_READONLY' });
  assert.ok(fs.existsSync(dev));
  fs.rmSync(path.join(f.root, 'sample'), { recursive: true });
  assert.equal(control.list()[0].id, 'sample', '没有常规安装目录也必须展示');
});
