import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWebHostServer } from './lib/web-host-runtime.mjs';
import { webNodeArtifact, WEB_HOST_NODE_VERSION } from './lib/web-host-node.mjs';
import { pruneDanglingLinks } from './prepare-web-host.mjs';

const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-host-runtime-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>web</body></html>');
  fs.writeFileSync(path.join(dir, 'renderer.html'), '<html>renderer</html>');
  return dir;
};

test('serves frontend, health probes and backend routes on the allocated port', async () => {
  const dir = fixture();
  const env = { PORT: '5180' };
  try {
    const server = await startWebHostServer({
      frontendDir: dir,
      basePath: '/',
      env,
      backend: {
        readiness: async () => ({ ready: true }),
        handle: async (req, res) => {
          if (req.url === '/api/probe') { res.end('probe-ok'); return true; }
          return false;
        },
        close: async () => {}
      }
    });
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    // 分配的端口必须回写 env，本机 Agent/MCP 靠它找回环地址。
    assert.equal(env.PORT, String(server.port));
    assert.equal(env.BACKEND_PORT, String(server.port));

    assert.equal(await (await fetch(`${server.origin}/api/probe`)).text(), 'probe-ok');
    assert.equal((await fetch(`${server.origin}/`)).status, 200);
    assert.equal((await fetch(`${server.origin}/renderer.html`)).status, 200);
    assert.equal((await fetch(`${server.origin}/health/live`)).status, 200);
    assert.equal((await fetch(`${server.origin}/health/ready`)).status, 200);
    // 缺失的带扩展名资源必须 404，不能回退成 HTML（否则 WASM 加载会拿到 HTML）。
    assert.equal((await fetch(`${server.origin}/missing.wasm`)).status, 404);
    await server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unready backend refuses to publish a listening port', async () => {
  const dir = fixture();
  let closed = false;
  try {
    await assert.rejects(
      () => startWebHostServer({
        frontendDir: dir,
        backend: { readiness: async () => ({ ready: false, reason: 'broken' }), close: async () => { closed = true; } }
      }),
      /broken/
    );
    assert.ok(closed, '未就绪时必须释放后端资源');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('base path mount strips the prefix once and serves the same assets', async () => {
  const dir = fixture();
  try {
    const server = await startWebHostServer({
      frontendDir: dir,
      basePath: '/tools/woohaa/',
      backend: { readiness: async () => ({ ready: true }), handle: async () => false, close: async () => {} }
    });
    assert.equal((await fetch(`${server.origin}/tools/woohaa/`)).status, 200);
    // 前缀外请求不进入应用（也不走 SPA 回退）。
    assert.equal((await fetch(`${server.origin}/`)).status, 404);
    await server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shutdown cancels persisted unfinished tasks before closing the backend', async () => {
  const dir = fixture();
  const events = [];
  let tasks = [{ taskKey: 'one' }, { taskKey: 'two' }];
  try {
    const server = await startWebHostServer({
      frontendDir: dir,
      backend: {
        modules: () => ({
          canvas: { readiness: async () => ({ ready: true }) },
          task: {
            history: () => ({ listUnsettled: () => tasks }),
            port: () => ({ cancel: async (key) => { events.push(key); tasks = tasks.filter((t) => t.taskKey !== key); } })
          }
        }),
        handle: async () => false,
        close: async () => events.push('closed')
      }
    });
    await server.close();
    assert.deepEqual(events, ['one', 'two', 'closed']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('web node artifacts cover Linux and pin the shared Node version', () => {
  assert.equal(webNodeArtifact('linux', 'x64').archive, `node-v${WEB_HOST_NODE_VERSION}-linux-x64.tar.gz`);
  assert.equal(webNodeArtifact('linux', 'arm64').triple, 'aarch64-unknown-linux-gnu');
  assert.equal(webNodeArtifact('darwin', 'arm64').triple, 'aarch64-apple-darwin');
  assert.equal(webNodeArtifact('win32', 'x64').triple, 'x86_64-pc-windows-msvc');
  // 未覆盖的平台必须明确失败，不能悄悄退回系统 Node。
  assert.throws(() => webNodeArtifact('linux', 's390x'), /不支持/);
});

test('dangling pnpm links are pruned so the tree stays portable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-host-prune-'));
  try {
    fs.mkdirSync(path.join(root, 'pkg/node_modules/.pnpm'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg/real.js'), 'ok');
    // 悬空链接（pnpm --prod 部署后指向未部署的开发包）
    fs.symlinkSync('../missing-target', path.join(root, 'pkg/node_modules/.pnpm/dangling'));
    // 指向树外的链接（workspace 源码）同样不能留
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'web-host-outside-'));
    fs.writeFileSync(path.join(outside, 'file.js'), 'x');
    fs.symlinkSync(outside, path.join(root, 'pkg/node_modules/.pnpm/outside'));
    const removed = pruneDanglingLinks(root);
    assert.equal(removed.length, 2);
    assert.ok(fs.existsSync(path.join(root, 'pkg/real.js')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
