import { readFileSync } from "node:fs";
import { createSqliteExtensionDocumentStore, createMongoExtensionDocumentStoreFromUri, createSqliteSiteExtensionConfigStore, extensionDocumentStorePath } from "@woohaa3/application-service";
import { migrateSqliteCanvasBeforeStartup, SqliteCanvasRepository, SqliteYjsRepository, MongoCanvasRepository, MongoYjsRepository, createDurableWriterLock, createSqliteWriterLockStore, resolveCanvasStorageConfig, CANVAS_STORAGE_BACKEND_ENV, MONGODB_DB_ENV, MONGODB_URI_ENV, SqliteNodeHistoryRepository, SqliteEditCompletionRepository, SqliteSnippetRepository, type CanvasStorageUnit, type DurableWriterLockStore } from "@woohaa3/canvas-service";
import type { BootstrapExtension, StorageProvider } from "@woohaa3/contracts";
export type { CanvasStorageUnit } from "@woohaa3/canvas-service";
export type RuntimeStorageProvider = StorageProvider<CanvasStorageUnit>;

/** mongo 连接信息的唯一来源：扩展目录内的部署侧配置文件（键：`uri`、`database`）。 */
export const MONGO_STORAGE_CONFIG_FILE = "config.local.json";
export const MONGO_STORAGE_CONFIG_KEYS = ["uri", "database"] as const;

/** 部署配置错误（稳定错误码 + 扩展目录标签）；启动 fail-fast，不进入部分注册。 */
function storageConfigError(directory: string, reason: string): Error & { code: string } {
  const error = new Error(`${directory} 配置无效：${reason}`) as Error & { code: string };
  error.code = "STORAGE_CONFIG_INVALID";
  return error;
}

/**
 * Mongo durable writer lock 适配（与 sqlite 的 `createSqliteWriterLockStore` 同构）。
 *
 * 这里不再从 `@woohaa3/canvas-service` 取 `createMongoWriterLockStore`：集成分支的
 * `MongoYjsRepository` 尚未实现 `tryAcquireWriterLock` / `currentWriterLock` / `releaseWriterLock`
 * 这个结构端口（`canvas-service` 的 `composition.ts` 同样声明「Mongo writer lock 尚未实现 durable store」）。
 * 保留同一调用形态：仓库具备该端口时正常装配；不具备时按部署配置错误 fail-fast，
 * 而不是静默装配一把没有跨进程语义的锁。
 */
function mongoWriterLockStore(repository: MongoYjsRepository, directory: string): DurableWriterLockStore {
  const port = repository as unknown as Partial<DurableWriterLockStore>;
  for (const method of ["tryAcquire", "currentHolder", "release", "health"] as const) {
    if (typeof port[method] !== "function") {
      throw storageConfigError(directory, `mongo 存储需要 MongoYjsRepository 提供跨进程 durable writer lock（缺 ${method}；canvas-service 尚未实现），当前不可用；请改用 sqlite-storage，或先在 canvas-service 补齐该端口`);
    }
  }
  return {
    tryAcquire: (instanceId, now) => port.tryAcquire!(instanceId, now),
    currentHolder: () => port.currentHolder!(),
    release: (instanceId) => port.release!(instanceId),
    health: () => port.health!()
  };
}

/**
 * 读 mongo 部署侧配置文件（`<扩展目录>/config.local.json`）。
 *
 * 连接信息**只**来自这个文件：`MONGODB_URI` / `MONGODB_DB` 已废弃，设置任意一个即启动失败
 * （不留第二个来源）。文件缺失、键名写错、值不是非空字符串都按配置错误报出文件路径，且不回显值。
 *
 * 只在 `provider.create` 里调用：声明工厂不读运行配置、不建立连接。
 */
export function readMongoStorageConfig(input: {
  path: string | undefined;
  directory: string;
  env: Record<string, string | undefined>;
}): { uri: string; database: string } {
  const { path: file, directory, env } = input;
  const legacy = [MONGODB_URI_ENV, MONGODB_DB_ENV].filter((key) => (env[key] ?? "").trim() !== "");
  if (legacy.length > 0) {
    throw storageConfigError(directory, `${legacy.join("、")} 不再生效：mongo 连接信息只从扩展目录的 ${MONGO_STORAGE_CONFIG_FILE} 读，请删掉这些环境变量`);
  }
  if (file === undefined || file.length === 0) {
    throw storageConfigError(directory, `缺少 ${MONGO_STORAGE_CONFIG_FILE}（部署侧文件，样例见同目录 config.example.json）`);
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOENT") {
      throw storageConfigError(directory, `缺少 ${file}（部署侧文件，样例见同目录 config.example.json）`);
    }
    throw storageConfigError(directory, `读取配置文件失败（${file}）：${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw storageConfigError(directory, `配置文件不是合法 JSON：${file}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw storageConfigError(directory, `配置文件必须是 JSON 对象：${file}`);
  }
  const accepted: readonly string[] = MONGO_STORAGE_CONFIG_KEYS;
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!accepted.includes(key)) throw storageConfigError(directory, `配置文件含未知键 ${key}（只接受 ${accepted.join(" | ")}）：${file}`);
  }
  const entries: Array<[string, unknown]> = [["uri", (parsed as Record<string, unknown>).uri], ["database", (parsed as Record<string, unknown>).database]];
  for (const [key, value] of entries) {
    if (typeof value !== "string" || value.trim().length === 0) throw storageConfigError(directory, `配置文件键 ${key} 必须是非空字符串：${file}`);
  }
  return { uri: ((parsed as Record<string, string>).uri).trim(), database: ((parsed as Record<string, string>).database).trim() };
}

/** 一个工厂持有匹配的 canonical/Yjs/lock/documents；领域服务借用句柄。 */
export function storageBootstrap(backend: "sqlite" | "mongo", env: Record<string, string | undefined>, owners: readonly string[], options: { directory?: string; mongoConfigFile?: string } = {}): BootstrapExtension<RuntimeStorageProvider> {
  // 扩展目录标签（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 4.3）：
  // 缺路径/缺连接串这类部署错误必须能一眼看到是哪个扩展目录。
  const directory = options.directory ?? `${backend}-storage`;
  return { extensionId: `${backend}-storage`, providers: [{ slot: "storage", requires: [], async create() {
    // mongo 连接信息与声明阶段解耦：这里才读配置文件（声明工厂不读运行配置、不建立连接）。
    // 不再读 MONGODB_URI/MONGODB_DB：设置它们会直接失败，连接信息只从扩展目录的配置文件来。
    const mongo = backend === "mongo" ? readMongoStorageConfig({ path: options.mongoConfigFile, directory, env }) : undefined;
    // 先报「声明与实际不符」：比「缺 mongo 配置」更能说明该怎么改。
    const declared = env[CANVAS_STORAGE_BACKEND_ENV];
    if (declared !== undefined && declared.length > 0 && declared !== backend) {
      throw storageConfigError(directory, `${backend}-storage 与 ${CANVAS_STORAGE_BACKEND_ENV}=${declared} 不一致（删掉该变量，或改用与之匹配的存储扩展目录）`);
    }
    const resolved = resolveCanvasStorageConfig(env, { backend, ...(mongo ? { mongo } : {}) });
    if (!resolved.ok) throw storageConfigError(directory, resolved.reason);
    const config = resolved.config;
    const appPath = env.WOOHAA3_APPLICATION_STORE_PATH;
    if (!appPath) throw storageConfigError(directory, "缺少 WOOHAA3_APPLICATION_STORE_PATH");
    if ((env.WOOHAA3_APPLICATION_DOCUMENT_STORE_BACKEND ?? backend) !== backend) throw storageConfigError(directory, `扩展文档存储与画布存储必须使用同一 backend：WOOHAA3_APPLICATION_DOCUMENT_STORE_BACKEND=${env.WOOHAA3_APPLICATION_DOCUMENT_STORE_BACKEND}`);
    const disposers: Array<() => void | Promise<void>> = [];
    const dispose = async () => {
      const errors: unknown[] = [];
      for (const close of disposers.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Storage 释放失败");
    };
    try {
      if (backend === "sqlite") migrateSqliteCanvasBeforeStartup(config.sqlitePath!);
      const settings = createSqliteSiteExtensionConfigStore({ path: appPath });
      disposers.push(() => settings.close());
      const repository = backend === "sqlite" ? new SqliteCanvasRepository({ path: config.sqlitePath! }) : await MongoCanvasRepository.connect({ uri: config.mongoUri!, database: config.mongoDb! });
      disposers.push(() => repository.close());
      const yjsRepository = backend === "sqlite" ? new SqliteYjsRepository({ path: config.sqlitePath! }) : await MongoYjsRepository.connect({ uri: config.mongoUri!, database: config.mongoDb! });
      disposers.push(() => yjsRepository.close());
      const writerLock = createDurableWriterLock(backend === "sqlite" ? createSqliteWriterLockStore(yjsRepository as SqliteYjsRepository) : mongoWriterLockStore(yjsRepository as MongoYjsRepository, directory));
      const documents = backend === "sqlite" ? createSqliteExtensionDocumentStore({ path: extensionDocumentStorePath(appPath), owners }) : createMongoExtensionDocumentStoreFromUri({ uri: config.mongoUri!, database: config.mongoDb!, owners });
      disposers.push(() => documents.close());
      if ("initialize" in documents && typeof documents.initialize === "function") await documents.initialize();
      const listIds = async () => {
        const ids: string[] = [];
        for (let offset = 0; ; offset += 100) {
          const page = await repository.listCanvases({ offset, limit: 100 });
          ids.push(...page.items.map(item => item.id));
          if (offset + page.items.length >= page.total || page.items.length === 0) return ids;
        }
      };
      const listCanvasSummaries: RuntimeStorageProvider["listCanvasSummaries"] = async ids => {
        const summaries = [];
        for (const id of ids) {
          const canvas = (await yjsRepository.loadYjsState(id))?.projection ?? await repository.getCanvas(id);
          if (canvas) summaries.push({ canvasId: id, title: canvas.title ?? "", revision: canvas.revision, updatedAt: canvas.updatedAt, nodeCount: canvas.document.nodes.length });
        }
        return summaries;
      };
      const canvas: CanvasStorageUnit = { repository, yjsRepository, writerLock, storageConfig: config };
      if (backend === "sqlite") {
        const nodeHistory = new SqliteNodeHistoryRepository({ path: config.sqlitePath! });
        disposers.push(() => nodeHistory.close()); canvas.nodeHistoryRepository = nodeHistory;
        const editCompletion = new SqliteEditCompletionRepository({ path: config.sqlitePath! });
        disposers.push(() => editCompletion.close()); canvas.editCompletionRepository = editCompletion;
        const snippets = new SqliteSnippetRepository({ path: config.sqlitePath! });
        disposers.push(() => snippets.close()); canvas.snippetRepository = snippets;
      }
      const value: RuntimeStorageProvider = {
        providerId: `${backend}-storage`, canvas, documents,
        readExtensionConfig: id => settings.get(id)?.values ?? {}, listCanvasSummaries,
        directory: {
          directoryId: `${backend}-storage:directory`, listDiscoverableIds: listIds,
          async list({ cursor, limit }) {
            const offset = cursor === undefined ? 0 : Number(cursor);
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("目录 cursor 非法");
            const size = Math.min(Math.max(limit ?? 100, 1), 100);
            const all = await listCanvasSummaries(await listIds());
            all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.canvasId.localeCompare(b.canvasId));
            const items = all.slice(offset, offset + size).map(({ canvasId, ...summary }) => ({ resource: { kind: "canvas" as const, id: canvasId }, ...summary }));
            return { items, ...(offset + items.length < all.length ? { nextCursor: String(offset + items.length) } : {}) };
          }
        }
      };
      return { value, dispose };
    } catch (error) { try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup]); } throw error; }
  } }] };
}
