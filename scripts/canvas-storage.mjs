#!/usr/bin/env node
/**
 * 画布存储运维 CLI（任务 8.6）。
 *
 *   node scripts/canvas-storage.mjs health  [--backend sqlite|mongo]
 *   node scripts/canvas-storage.mjs export  --out <file> [--canvas <id>]...
 *   node scripts/canvas-storage.mjs verify  --in <file> [--verify-media]
 *   node scripts/canvas-storage.mjs import  --in <file> [--dry-run] [--replace] [--verify-media] [--offline]
 *
 * 设计约束：
 * - **没有**「按画布直接删除 COS 对象」的命令：内容寻址对象可能被其它画布共享，
 *   生命周期治理必须独立、引用感知并带保留期（design D8）。
 * - 归档是 metadata-only；export/verify/import 都不复制媒体 bytes。
 * - 配置来自环境变量（见 web/services/canvas-service/.env.example）；缺失/非法即失败，绝不回退。
 * - change: split-web-runtime-services 后实现位于 canvas-service / media-service；
 *   change: 2026-10-16-add-storage-extension-point 后媒体对象存储是扩展层后端插件，
 *   本脚本按同一份环境构造 COS 后端的 media namespace 只读视图（未配置即 mediaStorage 缺省）。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const canvasServiceBundle = path.resolve(root, "web/services/canvas-service/dist/index.js");
const applicationServiceBundle = path.resolve(root, "web/services/application-service/dist/index.js");
const cosStorageBundle = path.resolve(root, "web/extensions/cos-storage/dist/backend.js");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function multiArg(name) {
  const values = [];
  process.argv.forEach((token, index) => {
    if (token === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]);
  });
  return values;
}

/** 读站点目录 `.env`（进程环境优先）。 */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function loadModules() {
  for (const bundle of [canvasServiceBundle, applicationServiceBundle]) {
    if (!fs.existsSync(bundle)) {
      fail(`缺少服务构建产物：${path.relative(root, bundle)}\n先运行：pnpm -C web run build:units`);
    }
  }
  const canvas = await import(pathToFileURL(canvasServiceBundle).href);
  const application = await import(pathToFileURL(applicationServiceBundle).href);
  return { canvas, extensionArchiveDefinitions: application.APPLICATION_EXTENSION_ARCHIVE_MANIFEST };
}

async function buildRepository(canvas, env) {
  const resolved = canvas.resolveCanvasStorageConfig(env);
  if (!resolved.ok) fail(`配置无效：${resolved.reason}`);
  const config = resolved.config;
  if (config.backend === "sqlite") {
    const { SqliteCanvasRepository } = await import(pathToFileURL(canvasServiceBundle).href);
    return { repository: new SqliteCanvasRepository({ path: config.sqlitePath }), config };
  }
  const { MongoCanvasRepository } = await import(pathToFileURL(canvasServiceBundle).href);
  return { repository: await MongoCanvasRepository.connect({ uri: config.mongoUri, database: config.mongoDb }), config };
}

/** 与生产读取相同的 published projection；旧数据库无 Yjs 文档时由归档服务回退。 */
async function buildPublishedReader(canvas, config) {
  const repository = config.backend === "sqlite"
    ? new canvas.SqliteYjsRepository({ path: config.sqlitePath })
    : await canvas.MongoYjsRepository.connect({ uri: config.mongoUri, database: config.mongoDb });
  return { repository, publishedReader: canvas.createPublishedReader(repository), close: () => repository.close() };
}

/**
 * 构造归档/校验用的媒体存储视图。
 *
 * 存储后端现在是扩展层插件：这里用 `cos-storage` 的 `resolveCosConfig` 读同一份 `COS_*`
 * 环境，并用 `createCosBackend` 注册的键布局（`${prefix}/${namespace}/${key}`）读写。
 * 未配置或未构建该扩展时返回 undefined —— 与以前一样，媒体校验降级为不可用，不是静默回退。
 */
async function buildMediaStorage(env) {
  if (!fs.existsSync(cosStorageBundle)) return undefined;
  try {
    const cos = await import(pathToFileURL(cosStorageBundle).href);
    const resolved = cos.resolveCosConfig({
      secretId: env.COS_SECRET_ID,
      secretKey: env.COS_SECRET_KEY,
      bucketName: env.COS_BUCKET_NAME,
      bucketUrl: env.COS_BUCKET_URL,
      prefix: env.COS_PREFIX
    });
    if (!resolved.ok) return undefined;
    return mediaStorageFromBackend(cos.createCosBackend(resolved.config), "media");
  } catch {
    return undefined;
  }
}

/**
 * `StorageBackend` → `MediaStorage` 的最小只读视图（运维脚本只需要 get/exists/stat）。
 *
 * 键仍由使用方给，这里补 media namespace；存储 not-found 翻译成媒体侧既有的字符串约定，
 * 与宿主里的正式适配器（web/backend/src/ports/media-storage.ts）保持同一语义。
 */
function mediaStorageFromBackend(backend, namespace) {
  const scope = (key) => `${namespace}/${key}`;
  const notFound = (key) =>
    Object.assign(new Error(`Media object not found: ${key}`), {
      code: "MEDIA_OBJECT_NOT_FOUND",
      name: "MediaObjectNotFoundError",
      key
    });
  const isStorageNotFound = (error) =>
    error?.code === "STORAGE_OBJECT_NOT_FOUND" || error?.name === "StorageObjectNotFoundError";
  return {
    put: (key, bytes, contentType) => backend.put(scope(key), bytes, contentType),
    async get(key) {
      try {
        return await backend.get(scope(key));
      } catch (error) {
        if (isStorageNotFound(error)) throw notFound(key);
        throw error;
      }
    },
    async exists(key) {
      return (await backend.head(scope(key))) !== null;
    },
    async stat(key) {
      const stat = await backend.head(scope(key));
      if (!stat) throw notFound(key);
      return stat;
    }
  };
}

const command = process.argv[2];
if (!command || !["health", "export", "verify", "import"].includes(command)) {
  fail("用法：node scripts/canvas-storage.mjs <health|export|verify|import> [options]");
}

const env = { ...readEnvFile(path.resolve(root, "web/services/canvas-service/.env")), ...process.env };
const { canvas, extensionArchiveDefinitions } = await loadModules();
const mediaStorage = await buildMediaStorage(env);

try {
  if (command === "health") {
    const { repository, config } = await buildRepository(canvas, env);
    const health = await repository.health();
    const diagnostics = canvas.describeCanvasStorageConfig(config, {
      mediaConfigured: Boolean(mediaStorage),
      adapterSchemaVersion: config.backend === "sqlite" ? 1 : 1
    });
    // 非敏感容量指标（任务 7.4）：只含数量与字节聚合。
    const metrics = await canvas.collectCanvasStorageMetrics(repository, {
      mediaReady: health.ok
    });
    process.stdout.write(`${JSON.stringify({ health, diagnostics, metrics }, null, 2)}\n`);
    await repository.close?.();
    process.exit(health.ok ? 0 : 1);
  }

  if (command === "export") {
    const out = arg("out");
    if (!out) fail("export 需要 --out <file>");
    const { repository, config } = await buildRepository(canvas, env);
    const published = await buildPublishedReader(canvas, config);
    const service = new canvas.CanvasArchiveService({ repository, mediaStorage, extensionArchiveDefinitions, publishedReader: published.publishedReader });
    const canvasIds = multiArg("canvas");
    const archive = await service.exportArchive(canvasIds.length > 0 ? canvasIds : undefined);
    fs.writeFileSync(path.resolve(out), JSON.stringify(archive, null, 2));
    process.stdout.write(`已导出 ${archive.canvases.length} 个画布到 ${out}\n`);
    await repository.close?.();
    await published.close();
    process.exit(0);
  }

  if (command === "verify") {
    const input = arg("in");
    if (!input) fail("verify 需要 --in <file>");
    const archive = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
    const service = new canvas.CanvasArchiveService({ repository: new canvas.InMemoryCanvasRepository(), mediaStorage, extensionArchiveDefinitions });
    const result = await service.verifyArchive(archive, { verifyMedia: flag("verify-media") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  }

  if (command === "import") {
    const input = arg("in");
    if (!input) fail("import 需要 --in <file>");
    const archive = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
    const { repository, config } = await buildRepository(canvas, env);
    const published = await buildPublishedReader(canvas, config);
    let release;
    try {
      if (!flag("dry-run")) {
        if (config.backend === "sqlite") {
          const lock = canvas.createDurableWriterLock(canvas.createSqliteWriterLockStore(published.repository));
          const acquired = await lock.acquire(`canvas-archive-${process.pid}`, new Date().toISOString());
          if (!acquired.ok) throw new Error(`导入需要停止画布服务：${acquired.reason}`);
          release = acquired.release;
        } else if (!flag("offline")) {
          throw new Error("Mongo 归档导入需要停止画布服务并指定 --offline（该部署没有持久 writer lock）");
        }
      }
      const service = new canvas.CanvasArchiveService({ repository, mediaStorage, extensionArchiveDefinitions,
        publishedReader: published.publishedReader,
        publication: canvas.createYjsArchivePublication(published.repository) });
      const result = await service.importArchive(archive, {
        dryRun: flag("dry-run"), replace: flag("replace"), verifyMedia: flag("verify-media")
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await release?.();
      await published.close();
      await repository.close?.();
    }
    process.exit(0);
  }
} catch (error) {
  fail(`命令失败：${error instanceof Error ? error.message : String(error)}`);
}
