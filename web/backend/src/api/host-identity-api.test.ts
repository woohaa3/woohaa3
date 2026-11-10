import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_IDENTITY_PATH, sameHostInstance, type HostIdentity } from "@woohaa3/contracts";
import {
  createHostIdentity,
  createHostIdentityApiHandler,
  deriveInstanceId
} from "./host-identity-api.js";
import { resolveDataDir } from "../host/base/identity.js";

/**
 * 宿主身份端点：外部工具靠它认出「这是哪一份实例」。
 *
 * 它存在的唯一理由是**区分**——同机多实例的 HTTP 形状一模一样，仅凭端口能连会选错数据。
 * 所以这里的断言集中在「不同该不同、相同该相同」，而不是字段格式细节。
 */

const servers: http.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** 起一个只挂身份端点的最小服务。 */
async function serve(identity: HostIdentity): Promise<string> {
  const handler = createHostIdentityApiHandler(identity);
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('deriveInstanceId', () => {
  it('同一数据目录 + 同一启动时刻 → 同一指纹', () => {
    const startedAt = new Date("2026-11-10T08:00:00.000Z");
    expect(deriveInstanceId({ dataDir: '/data/a', startedAt })).toBe(deriveInstanceId({ dataDir: '/data/a', startedAt }));
  });

  it('数据目录不同 → 指纹不同（这是「两套数据」的判据）', () => {
    const startedAt = new Date("2026-11-10T08:00:00.000Z");
    expect(deriveInstanceId({ dataDir: '/data/a', startedAt })).not.toBe(deriveInstanceId({ dataDir: '/data/b', startedAt }));
  });

  it('同一数据目录重启后 → 指纹不同（运行态已换，外部工具应重新握手）', () => {
    const first = deriveInstanceId({ dataDir: '/data/a', startedAt: new Date("2026-11-10T08:00:00.000Z") });
    const second = deriveInstanceId({ dataDir: '/data/a', startedAt: new Date("2026-11-10T09:00:00.000Z") });
    expect(first).not.toBe(second);
  });

  it('定长且不含路径原文', () => {
    const id = deriveInstanceId({ dataDir: '/very/secret/path', startedAt: new Date(0) });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain('secret');
  });
});

describe('createHostIdentity', () => {
  it('同一份实例的两次身份相等（指纹与字段都取自同一组输入）', () => {
    const deps = { dataDir: '/data/a', startedAt: new Date("2026-11-10T08:00:00.000Z"), version: '1.2.3' };
    const first = createHostIdentity(deps);
    const second = createHostIdentity(deps);
    expect(sameHostInstance(first, second)).toBe(true);
    expect(first).toMatchObject({ dataDir: '/data/a', version: '1.2.3', protocolVersion: 1 });
  });

  it('版本取不到时是空串，而不是编一个', () => {
    expect(createHostIdentity({ dataDir: '/data/a' }).version).toBe('');
  });

  it('不同数据目录不被认成同一实例', () => {
    const a = createHostIdentity({ dataDir: '/data/a' });
    const b = createHostIdentity({ dataDir: '/data/b' });
    expect(sameHostInstance(a, b)).toBe(false);
  });
});

describe('host identity 端点', () => {
  it('GET 回身份，且不缓存', async () => {
    const identity = createHostIdentity({ dataDir: '/data/a', startedAt: new Date("2026-11-10T08:00:00.000Z") });
    const base = await serve(identity);
    const response = await fetch(`${base}${HOST_IDENTITY_PATH}`);
    expect(response.status).toBe(200);
    // 扫描器要问「现在还是不是那个实例」，缓存会把已退出的实例报成活。
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(identity);
  });

  it('其他方法一律 405，不含业务数据', async () => {
    const base = await serve(createHostIdentity({ dataDir: '/data/a' }));
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${base}${HOST_IDENTITY_PATH}`, { method });
      expect(response.status, method).toBe(405);
      expect(await response.json()).toMatchObject({ code: 'unsupported' });
    }
  });

  it('不认识别的路径：交下游而不是自己 404', async () => {
    const base = await serve(createHostIdentity({ dataDir: '/data/a' }));
    expect((await fetch(`${base}/api/canvases`)).status).toBe(404);
  });
});

describe('resolveDataDir', () => {
  it('打包版取 stores 的上一级（数据根）', () => {
    expect(resolveDataDir({ WOOHAA3_APPLICATION_STORE_PATH: '/tmp/wh-run/data/woohaa3/web-host/data/stores/application.sqlite' })).toBe(
      '/tmp/wh-run/data/woohaa3/web-host/data'
    );
  });

  it('dev 的扁平 .local/ 直接用所在目录', () => {
    expect(resolveDataDir({ WOOHAA3_APPLICATION_STORE_PATH: '/work/.local/application-dev.sqlite' })).toBe('/work/.local');
  });

  it('桌面随包宿主给出的运行时目录优先', () => {
    expect(
      resolveDataDir({
        WOOHAA3_RUNTIME_DATA_DIR: '/Users/me/Library/Application Support/woohaa3',
        WOOHAA3_APPLICATION_STORE_PATH: '/elsewhere/stores/application.sqlite'
      })
    ).toBe('/Users/me/Library/Application Support/woohaa3');
  });

  it('全部缺失时回落工作目录，端点仍然可用', () => {
    expect(resolveDataDir({})).toBe(process.cwd());
  });
});
