/**
 * 扩展市场端到端（change: 2026-10-21-add-extension-marketplace-point，任务 9.3）。
 *
 * 真实本机宿主 + HTTP：打包签名的纯前端 fixture → POST /api/extensions/install → 发布目录
 * current.json 指向含该扩展的新 release（已打开页面据此热登记，不刷新）→ 升级 → 回滚 → 卸载；
 * 含后端 fixture 安装后标记需要重启、不热登记；签名不受信与路径穿越包被拒绝且当前版本不变。
 */
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBackendService, type BackendService } from "../src/composition.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const FIXTURES = path.join(REPO_ROOT, "scripts/fixtures/marketplace");

type Pack = { packExtension: (o: Record<string, unknown>) => Promise<{ outFile: string }> };
let packLib: Pack;
const dirs: string[] = [];
const services: Array<{ service: BackendService; server: http.Server }> = [];

function temp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeAll(async () => {
  packLib = (await import(pathToFileURL(path.join(REPO_ROOT, "scripts/pack-extension.mjs")).href)) as Pack;
});

afterEach(async () => {
  for (const { service, server } of services.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

/** 复制 fixture 并改版本号后打包（不在仓库里留产物）。 */
async function packFixture(name: string, version: string, key = privateKey) {
  const dir = path.join(temp("mp-e2e-src-"), name);
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  for (const file of ["extension.json", "package.json"]) {
    const json = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    json.version = version;
    if (json.site) json.site.version = version;
    fs.writeFileSync(path.join(dir, file), JSON.stringify(json, null, 2));
  }
  // 前端 metadata 的 version 也属于同一份版本事实：只改声明会让构建期一致性检查失败
  // （change: 2026-11-13-add-extension-version-governance）。
  const metadataFile = path.join(dir, "src", "frontend", "metadata.ts");
  if (fs.existsSync(metadataFile)) {
    const source = fs.readFileSync(metadataFile, "utf8");
    fs.writeFileSync(metadataFile, source.replace(/(\bversion:\s*)(["'])([^"']*)\2/g, (_all, prefix, quote) => `${prefix}${quote}${version}${quote}`));
  }
  const out = path.join(temp("mp-e2e-pkg-"), `${name}-${version}.wxt`);
  return (await packLib.packExtension({ dir, out, privateKey: key, repoRoot: REPO_ROOT })).outFile;
}

async function boot(extraConfig = "") {
  const dir = temp("mp-e2e-host-");
  const configFile = path.join(dir, "woohaa.config.yml");
  fs.writeFileSync(configFile, `extensions:\n  marketplace:\n    trustedKeys: "e2e=${publicKeyBase64}"\n${extraConfig}`);
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
  services.push({ service, server });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, managed: path.join(dir, "managed") };
}

async function json(res: Response) {
  return (await res.json()) as Record<string, any>;
}

async function waitJob(base: string, jobId: string) {
  for (let i = 0; i < 200; i += 1) {
    const view = await json(await fetch(`${base}/api/extensions/install/${jobId}`));
    if (view.status !== "running" && view.status !== "queued") return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("任务超时");
}

async function install(base: string, file: string) {
  const res = await fetch(`${base}/api/extensions/install`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: fs.readFileSync(file)
  });
  const body = await json(res);
  return waitJob(base, body.jobId);
}

async function action(base: string, extensionId: string, verb: "uninstall" | "rollback", payload: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/api/extensions/${extensionId}/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return waitJob(base, (await json(res)).jobId);
}

async function currentRelease(base: string) {
  const pointer = await json(await fetch(`${base}/extension-releases/current.json`));
  const href = String(pointer.href ?? pointer.releaseHref ?? `/extension-releases/${pointer.releaseId}.json`);
  const release = await json(await fetch(base + href));
  return { releaseId: String(pointer.releaseId), extensions: JSON.stringify(release) };
}

function managedRecord(managed: string, extensionId: string) {
  const file = path.join(managed, "installations.json");
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")).extensions?.[extensionId];
}

describe("扩展市场端到端（真实宿主 + HTTP）", () => {
  it("纯前端扩展：安装热登记 → 升级 → 回滚 → 卸载，发布目录随之切换", async () => {
    const { base, managed } = await boot();
    const before = await currentRelease(base);
    expect(before.extensions).not.toContain("fixture-panel");

    const v1 = await install(base, await packFixture("fixture-panel", "1.0.0"));
    expect(v1).toMatchObject({ status: "succeeded" });
    const afterInstall = await currentRelease(base);
    expect(afterInstall.releaseId).not.toBe(before.releaseId);
    expect(afterInstall.extensions).toContain("fixture-panel");
    expect(managedRecord(managed, "fixture-panel")).toMatchObject({ current: "1.0.0" });
    // 旧 release 仍可读（已打开页面继续用）。
    expect((await fetch(`${base}/extension-releases/${before.releaseId}.json`)).status).toBe(200);

    const settings = await json(await fetch(`${base}/api/settings`));
    const view = (settings.installedExtensions as Array<Record<string, unknown>>).find((entry) => entry.id === "fixture-panel");
    expect(view).toMatchObject({ managed: true, version: "1.0.0" });

    expect(await install(base, await packFixture("fixture-panel", "1.1.0"))).toMatchObject({ status: "succeeded" });
    expect(managedRecord(managed, "fixture-panel")).toMatchObject({ current: "1.1.0", previous: "1.0.0" });

    expect(await action(base, "fixture-panel", "rollback")).toMatchObject({ status: "succeeded" });
    expect(managedRecord(managed, "fixture-panel")).toMatchObject({ current: "1.0.0" });

    expect(await action(base, "fixture-panel", "uninstall")).toMatchObject({ status: "succeeded" });
    expect(managedRecord(managed, "fixture-panel")).toBeUndefined();
    expect((await currentRelease(base)).extensions).not.toContain("fixture-panel");
  }, 120_000);

  it("含后端扩展：进程内热切换，首次安装即生效（不要求重启）", async () => {
    // C 方向取消了子进程，但换版仍然热生效：扩展层 add/remove 建在 Cordis fiber 上，
    // 每个版本一个目录 → 换版本即换模块 URL，不会命中 ESM 缓存。
    const { base, managed } = await boot();
    const job = await install(base, await packFixture("fixture-echo-provider", "1.0.0"));
    expect(job.status).toBe("succeeded");
    expect(JSON.stringify(job)).not.toMatch(/restart-required/);
    expect(managedRecord(managed, "fixture-echo-provider")).toMatchObject({ current: "1.0.0" });
    // 装配在宿主进程内完成：路由立即可用，且 pid 就是宿主自己。
    const res = await fetch(`${base}/api/extensions/fixture-echo-provider/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
  }, 120_000);

  it("签名不受信与路径穿越包被拒绝，当前版本不变", async () => {
    const { base, managed } = await boot();
    expect(await install(base, await packFixture("fixture-panel", "1.0.0"))).toMatchObject({ status: "succeeded" });
    const release = (await currentRelease(base)).releaseId;

    const other = generateKeyPairSync("ed25519").privateKey;
    const untrusted = await install(base, await packFixture("fixture-panel", "2.0.0", other));
    expect(untrusted).toMatchObject({ status: "failed", failure: { code: "MARKETPLACE_SIGNATURE_UNTRUSTED" } });

    // 手工构造带 ../ 条目的 tar.gz。
    const evil = path.join(temp("mp-e2e-evil-"), "evil.wxt");
    fs.writeFileSync(evil, craftTraversalArchive());
    const traversal = await install(base, evil);
    expect(traversal.status).toBe("failed");
    expect(traversal.failure?.code).toMatch(/MARKETPLACE_ARCHIVE_UNSAFE|MARKETPLACE_PACKAGE_INVALID/);

    expect(managedRecord(managed, "fixture-panel")).toMatchObject({ current: "1.0.0" });
    expect((await currentRelease(base)).releaseId).toBe(release);
    expect(fs.existsSync(path.join(managed, "..", "escaped.txt"))).toBe(false);
  }, 120_000);
});

/** 最小 ustar + gzip：一个名为 ../escaped.txt 的文件。 */
function craftTraversalArchive(): Buffer {
  const content = Buffer.from("pwned\n");
  const header = Buffer.alloc(512);
  header.write("../escaped.txt", 0, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const body = Buffer.concat([content, Buffer.alloc(512 - content.length)]);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}
