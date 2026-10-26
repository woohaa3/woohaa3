/**
 * Extension Host 子进程隔离端到端（change: 2026-10-21-isolate-extension-host-process，任务 10.2）。
 *
 * 真实本机宿主 + HTTP + 真实 fork：受管 Provider 在独立子进程里运行（pid ≠ 宿主），生成往返成功；
 * 升级走蓝绿、期间持续请求无 503 空窗；杀子进程后能力立即撤销、退避重启后恢复；
 * 连续崩溃进入 quarantined，解除后恢复；越权全部被拒且宿主不受影响；死循环不拖垮宿主就绪。
 */
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBackendService, type BackendService } from "../src/composition.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

type Packed = { outFile: string };
let packFixture: (name: string, options: Record<string, unknown>) => Promise<Packed>;
const dirs: string[] = [];
const running: Array<{ service: BackendService; server: http.Server }> = [];

function temp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeAll(async () => {
  ({ packFixture } = (await import(pathToFileURL(path.join(REPO_ROOT, "scripts/fixtures-marketplace.test.mjs")).href)) as never);
});

afterEach(async () => {
  for (const { service, server } of running.splice(0)) {
    // 先关宿主（停止子进程：卡死的实例在停止时限后被 SIGKILL，挂着的转发请求随之以 503 收尾），
    // 再关 HTTP 服务器——否则 server.close 会一直等那条转发给卡死子进程的请求。
    await service.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trusted = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

async function pack(name: string, version?: string) {
  return (await packFixture(name, { privateKey: pem, outDir: temp("iso-pkg-"), ...(version ? { version } : {}) })).outFile;
}

async function boot(extraConfig = "") {
  const dir = temp("iso-host-");
  const configFile = path.join(dir, "woohaa.config.yml");
  fs.writeFileSync(configFile, `extensions:\n  marketplace:\n    trustedKeys: "e2e=${trusted}"\n${extraConfig}`);
  const service = await createBackendService({
    env: {
      WOOHAA3_CONFIG_FILE: configFile,
      WOOHAA3_SECRETS_FILE: path.join(dir, "woohaa.secrets.yml"),
      WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
      WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite"),
      WOOHAA3_EXTENSION_MANAGED_DIR: path.join(dir, "managed"),
      WOOHAA3_BOOT_STATE_FILE: path.join(dir, "boot-state.json")
    },
    logger: () => {},
    modelsConfig: { version: 1, models: [] },
    enableYjsSync: false
  });
  await service.settled();
  const server = http.createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  running.push({ service, server });
  return { service, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, managed: path.join(dir, "managed") };
}

const json = async (res: Response) => (await res.json()) as Record<string, any>;

async function waitJob(base: string, jobId: string) {
  for (let i = 0; i < 400; i += 1) {
    const view = await json(await fetch(`${base}/api/extensions/install/${jobId}`));
    if (view.status !== "running" && view.status !== "queued") return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("任务超时");
}

async function install(base: string, file: string) {
  const res = await fetch(`${base}/api/extensions/install`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: fs.readFileSync(file) });
  return waitJob(base, (await json(res)).jobId);
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T;
  do {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < deadline);
  return last!;
}

const refresh = (base: string) => fetch(`${base}/api/extensions/fixture-echo-provider/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const providerIds = (service: BackendService) => service.modules().generation.list().map((p: { providerId: string }) => p.providerId);

describe("Extension Host 子进程隔离（真实宿主 + fork）", () => {
  it("受管 Provider 在独立子进程运行；升级蓝绿无 503 空窗；杀进程后撤销并退避恢复", async () => {
    const { service, base } = await boot();
    const job = await install(base, await pack("fixture-echo-provider"));
    expect(job.status, JSON.stringify(job)).toBe("succeeded");
    expect(JSON.stringify(job)).not.toMatch(/restart-required/);

    const first = await until(async () => refresh(base), (r) => r.status === 200);
    const { pid } = await json(first);
    expect(typeof pid).toBe("number");
    expect(pid).not.toBe(process.pid);
    expect(providerIds(service)).toContain("fixture-echo");

    // 升级期间持续打路由：不应出现 503。
    const statuses: number[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        statuses.push((await refresh(base)).status);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    const upgrade = await install(base, await pack("fixture-echo-provider", "1.1.0"));
    polling = false;
    await poller;
    expect(upgrade.status, JSON.stringify(upgrade)).toBe("succeeded");
    expect(statuses.filter((s) => s === 503)).toEqual([]);
    const { pid: greenPid } = await json(await refresh(base));
    expect(greenPid).not.toBe(pid);

    // 杀子进程：能力立即撤销 → 503 → 退避重启后恢复（新 pid）。
    process.kill(greenPid, "SIGKILL");
    const down = await until(async () => refresh(base), (r) => r.status === 503, 5_000);
    expect(down.status).toBe(503);
    const back = await until(async () => refresh(base), (r) => r.status === 200, 15_000);
    expect(back.status).toBe(200);
    expect((await json(back)).pid).not.toBe(greenPid);
  }, 120_000);

  it("激活即崩溃的扩展连续崩溃后进入 quarantined，宿主保持就绪；解除后重新尝试", async () => {
    const { base } = await boot("providers:\n  fixture-crashy:\n    crashOnActivate: true\n");
    await install(base, await pack("fixture-crashy"));
    // fixture-crashy 没有站点元数据（不受站点开关管理），所以不在 GET /api/extensions 的 plugins 里；
    // 隔离状态从设置快照的受管扩展视图读取（与设置面「解除隔离」按钮同一数据源）。
    const managed = async () => {
      const settings = await json(await fetch(`${base}/api/settings`));
      return ((settings.installedExtensions ?? []) as Array<Record<string, any>>).find((e) => e.id === "fixture-crashy");
    };
    const quarantined = await until(managed, (view) => typeof view?.quarantinedAt === "string", 60_000);
    expect(quarantined).toMatchObject({ isolation: "process", crashCount: 3 });
    // 宿主保持可用：其他接口照常应答，隔离中的扩展路由回 503。
    expect((await fetch(`${base}/api/settings`)).status).toBe(200);
    expect((await fetch(`${base}/api/extensions/fixture-crashy/ping`, { method: "POST" })).status).toBe(503);
    const res = await fetch(`${base}/api/extensions/fixture-crashy/unquarantine`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    expect((await json(res)).unquarantined).toBe(true);
    // 解除后重新尝试激活（仍激活即崩溃 → 重新开始计数，不会立即再次隔离）。
    const after = await managed();
    expect(after?.quarantinedAt).toBeUndefined();
  }, 120_000);

  it("越权尝试全部被拒，宿主与其他扩展不受影响", async () => {
    const { base } = await boot();
    expect((await install(base, await pack("fixture-greedy"))).status).toBe("succeeded");
    const res = await until(async () => fetch(`${base}/api/extensions/fixture-greedy/probes`), (r) => r.status === 200);
    const { pid, probes } = await json(res);
    expect(pid).not.toBe(process.pid);
    const by = Object.fromEntries((probes as Array<{ name: string; ok: boolean; code?: string; detail?: string }>).map((p) => [p.name, p]));
    for (const name of ["fetch-denied", "fetch-private", "net-denied"]) expect(by[name], name).toMatchObject({ ok: false, code: "EXTENSION_NETWORK_DENIED" });
    for (const name of ["spawn", "route-outside", "storage-other"]) expect(by[name], name).toMatchObject({ ok: false, code: "permission-denied" });
    expect(by["storage-own"]?.ok).toBe(true);
    expect(by["canvas"]?.detail).toBe("undefined");
    expect(by["env"]?.detail).toBe("none");
    // 越权注册的路由在宿主上不存在。
    expect((await fetch(`${base}/api/settings/greedy`)).status).not.toBe(200);
  }, 120_000);

  it("扩展同步死循环不影响宿主就绪与其他路由", async () => {
    const { base } = await boot();
    expect((await install(base, await pack("fixture-crashy"))).status).toBe("succeeded");
    await until(async () => fetch(`${base}/api/extensions/fixture-crashy/ping`, { method: "POST" }), (r) => r.status === 200);
    void fetch(`${base}/api/extensions/fixture-crashy/hang`, { method: "POST" }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    const settings = await fetch(`${base}/api/settings`);
    expect(settings.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);
    // 心跳超时判死后，退避重启恢复（宿主始终可用）。
    const back = await until(async () => fetch(`${base}/api/extensions/fixture-crashy/ping`, { method: "POST" }), (r) => r.status === 200, 60_000);
    expect(back.status).toBe(200);
  }, 120_000);
});
