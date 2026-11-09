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
    const entry = await fetch(`${server.origin}/tools/woohaa/`);
    await entry.text();
    assert.equal(entry.status, 200);
    // 前缀外请求不进入应用（也不走 SPA 回退）。
    //
    // 根路径是例外：子路径部署下它现在重定向到 basePath（见下面的专项用例），
    // 因为运维习惯直接访问 `http://host:port/`。这里验证的是**除根路径外**
    // 的前缀外请求仍是 404，不会落到应用或 SPA 回退。
    for (const outside of ['/other', '/tools/other/']) {
      const response = await fetch(`${server.origin}${outside}`, { redirect: 'manual' });
      await response.text();
      assert.equal(response.status, 404, `${outside} 应在前缀外被拒`);
    }
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

test('子路径部署：根路径重定向到 basePath，且保留 query', async () => {
  const dir = fixture();
  try {
    const server = await startWebHostServer({
      frontendDir: dir,
      basePath: '/tools/woohaa/',
      backend: { readiness: async () => ({ ready: true }), handle: async () => false, close: async () => {} }
    });
    // 运维习惯访问根路径；子路径部署下裸 404 不友好，重定向更符合预期。
    // 必须消费响应体：`redirect: 'manual'` 下若只读 header 就丢弃响应，连接不会归还，
    // 随后的 server.close()（等全部连接结束）会一直挂着。
    const root = await fetch(`${server.origin}/`, { redirect: 'manual' });
    await root.text();
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/tools/woohaa/');

    const withQuery = await fetch(`${server.origin}/?a=1&b=2`, { redirect: 'manual' });
    await withQuery.text();
    assert.equal(withQuery.headers.get('location'), '/tools/woohaa/?a=1&b=2');

    // 子路径本身仍是 200，不被重定向影响。
    assert.equal((await fetch(`${server.origin}/tools/woohaa/`)).status, 200);
    await server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('根路径部署：不重定向（basePath=/ 时根就是应用入口）', async () => {
  const dir = fixture();
  try {
    const server = await startWebHostServer({
      frontendDir: dir,
      basePath: '/',
      backend: { readiness: async () => ({ ready: true }), handle: async () => false, close: async () => {} }
    });
    const root = await fetch(`${server.origin}/`, { redirect: 'manual' });
    await root.text();
    assert.equal(root.status, 200);
    await server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/health/live 自述版本，部署脚本据此核对线上跑的是哪一版', async () => {
  const dir = fixture();
  try {
    const server = await startWebHostServer({
      frontendDir: dir,
      backend: { readiness: async () => ({ ready: true }), handle: async () => false, close: async () => {} },
      version: { commit: 'abc1234', nodeVersion: '24.22.0', extensions: 21, form: 'web-host' }
    });
    const live = await (await fetch(`${server.origin}/health/live`)).json();
    assert.equal(live.status, 'ok');
    assert.equal(live.commit, 'abc1234');
    assert.equal(live.nodeVersion, '24.22.0');
    assert.equal(live.extensions, 21);
    await server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未提供版本时 /health/live 只回 status，不编造字段', async () => {
  const dir = fixture();
  try {
    const server = await startWebHostServer({
      frontendDir: dir,
      backend: { readiness: async () => ({ ready: true }), handle: async () => false, close: async () => {} }
    });
    const live = await (await fetch(`${server.origin}/health/live`)).json();
    assert.deepEqual(live, { status: 'ok' });
    await server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
