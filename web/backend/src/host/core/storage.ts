/**
 * 核心层 · storage：`ctx.storage` 扩展点。
 *
 * core 只有注册表、按设置选用和按能力路由：后端插件（local / cos·s3 / server）向这里注册，
 * media 与 task 只拿 `bucket(namespace, scope?)` 视图读写字节和取外部地址。主存储与对外后端都来自
 * 设置（`storage.primary` 缺省 `local`、`storage.expose` 可空），`bucket` 每次调用现查，
 * 热切换对使用方无感。
 *
 * 「画布作用域」（`StorageScope`）是使用方透传下来的「这次读写属于哪张画布」。宿主通过
 * `route(namespace, canvasId)` 回答「这张画布该用哪个后端」（典型实现：已同步到远端的画布 →
 * `server`），命中且后端已注册就用它，否则回落 `storage.primary`。
 *
 * 路由之后还有「读时回填」：路由后端不认识同步前就存在的旧对象（它们只在主存储里），于是读路径
 * 先按主存储读出来返回，再 best-effort 补一份到路由后端——存量资产不必等一次显式迁移就能在
 * 远端可用。补传失败只记日志：这次读已经成功，不能因为「顺便补传」失败而变成错误。
 *
 * 「能不能被外部访问」只问后端有没有 `presign`，不问它是不是 COS。
 */
import {
  StorageExposeUnavailableError,
  isStorageObjectNotFoundError,
  type HostStorageService,
  type StorageBackend,
  type StorageBucket,
  type StorageObject,
  type StorageObjectStream,
  type StorageScope
} from "@woohaa3/contracts";
import type { HostPlugin } from "../context.js";
import { READINESS_ORDER } from "../order.js";

export type StorageSettings = {
  /** `storage.primary`；空值时按 `local` 处理。 */
  primary(): string;
  /** `storage.expose`；空值表示只用主存储的签名能力。 */
  expose(): string | undefined;
};

export type StorageRegistryOptions = {
  settings: StorageSettings;
  /**
   * 画布路由：这张 namespace + 画布**是否由画布托管后端承载**。
   *
   * core 不认识「画布同步到了哪里」，只认两件事：宿主说「这张画布归远端」，以及某个已注册
   * 后端声明了 `canvasScoped`（承载画布托管存储）。承载者是谁由后端自己声明，core 不背任何
   * 具体后端 id；没有声明者或路由未命中时一律回落 `storage.primary`。
   *
   * 每次调用现查：画布刚启用/停用远端同步立即生效。
   */
  route?: (namespace: string, canvasId: string) => boolean;
  logger?: (event: Record<string, unknown>) => void;
};

export const DEFAULT_PRIMARY_STORAGE = "local";

/** 一次调用解析出的后端：`isPrimary` 为 false 时读路径才需要「读时回填」。 */
type ResolvedBackend = {
  backend: StorageBackend;
  id: string;
  isPrimary: boolean;
};

/** 纯注册表 + 路由；不持有任何后端实现（后端都是扩展层插件）。 */
export function createStorageRegistry(options: StorageRegistryOptions): HostStorageService {
  const log = options.logger ?? (() => undefined);
  const backends = new Map<string, StorageBackend>();

  const primaryId = (): string => options.settings.primary().trim() || DEFAULT_PRIMARY_STORAGE;
  const exposeIdOf = (): string | undefined => {
    const value = options.settings.expose()?.trim();
    return value ? value : undefined;
  };

  const primary = (): StorageBackend => {
    const id = primaryId();
    const backend = backends.get(id);
    if (!backend) throw new Error(`主存储后端未注册：${id}（设置 storage.primary）`);
    return backend;
  };

  /**
   * 声明承载画布托管存储的后端 id（至多一个）。
   *
   * 按注册顺序取第一个：多个后端同时声明是接入方的配置错误，注册时已经告警，这里不再猜。
   */
  const canvasBackendIdOf = (): string | undefined => {
    for (const backend of backends.values()) {
      if (backend.canvasScoped === true) return backend.backendId;
    }
    return undefined;
  };

  /**
   * 画布路由：宿主说「归远端」且**确有承载者**时才命中，否则未命中（回落主存储）。
   */
  const routedIdOf = (namespace: string, scope?: StorageScope): string | undefined => {
    const canvasId = scope?.canvasId?.trim();
    if (!canvasId) return undefined;
    if (options.route?.(namespace, canvasId) !== true) return undefined;
    const id = canvasBackendIdOf();
    return id && backends.has(id) ? id : undefined;
  };

  /** 每次调用现查的后端：路由命中就用它，否则主存储（主存储没注册时抛可诊断错误）。 */
  const resolveBackend = (namespace: string, scope?: StorageScope): ResolvedBackend => {
    const routedId = routedIdOf(namespace, scope);
    if (routedId !== undefined) {
      return { backend: backends.get(routedId)!, id: routedId, isPrimary: routedId === primaryId() };
    }
    return { backend: primary(), id: primaryId(), isPrimary: true };
  };

  /**
   * 读时回填：路由后端里没有、主存储里有；把对象补一份到路由后端。
   *
   * 只有「同步前就存在的旧对象」会走这里。**必须吞掉失败**：这次读取已经从主存储拿到了，
   * 不能因为顺便补传失败而把一次成功读取变成错误；下次读会再试一次。
   */
  const backfill = async (
    target: StorageBackend,
    targetId: string,
    namespace: string,
    key: string,
    scope: StorageScope | undefined,
    known?: StorageObject
  ): Promise<void> => {
    try {
      const object = known ?? (await primary().get(key, scope));
      await target.put(key, object.bytes, object.contentType ?? "application/octet-stream", scope);
      log({ event: "storage-routed-backfill", namespace, backendId: targetId, size: object.bytes.byteLength });
    } catch (error) {
      log({
        event: "storage-routed-backfill-failed",
        namespace,
        backendId: targetId,
        reason: error instanceof Error ? error.name : "unknown",
        ...(typeof (error as { code?: unknown })?.code === "string" ? { code: (error as { code: string }).code } : {})
      });
    }
  };

  /**
   * 按当前后端读对象，并带「读时回填」：路由后端未命中就回主存储读，再补传到路由后端。
   *
   * get 与 expose 的复制步骤共用它——否则 expose 一条「同步前生成的资产」会因为路由后端
   * 还没有这个对象而失败，哪怕主存储里明明有。
   *
   * 主存储未命中就是未命中：不跨后端起猜。归属由宿主持久记录（`ctx.canvas.remoteCanvasIds`），
   * 路由错了是归属的 bug，不能靠「多试一个后端」掩盖——那会让写路径与读路径对同一个对象
   * 给出不同答案。
   */
  const readObject = async (
    current: ResolvedBackend,
    namespace: string,
    key: string,
    scope?: StorageScope
  ): Promise<StorageObject> => {
    if (current.isPrimary) return current.backend.get(key, scope);
    try {
      return await current.backend.get(key, scope);
    } catch (error) {
      if (!isStorageObjectNotFoundError(error)) throw error;
      const object = await primary().get(key, scope);
      await backfill(current.backend, current.id, namespace, key, scope, object);
      return object;
    }
  };

  /** 统一流式读取：后端有 `openRead` 就用它，否则读全文再切片。 */
  const readStream = async (
    backend: StorageBackend,
    key: string,
    scope: StorageScope | undefined,
    range?: { start: number; end: number }
  ): Promise<StorageObjectStream> => {
    if (backend.openRead) return backend.openRead(key, range, scope);
    const object = await backend.get(key, scope);
    const bytes = range ? object.bytes.subarray(range.start, range.end + 1) : object.bytes;
    return { bytes: (async function* () { yield bytes; })(), cancel() {} };
  };

  const bucket = (namespace: string, scope?: StorageScope): StorageBucket => {
    // 使用方给 namespace 内的 key；core 拼 namespace，后端只加自己的前缀（COS 即 `${prefix}/${namespace}/${key}`）。
    const keyOf = (key: string) => `${namespace}/${key}`;
    const exposeTarget = (): { backend: StorageBackend; id: string } => {
      const id = exposeIdOf();
      if (!id) throw new StorageExposeUnavailableError();
      const backend = backends.get(id);
      if (!backend?.presign) {
        throw new StorageExposeUnavailableError(
          backend
            ? `对外存储后端 ${id} 没有签名能力：请改配支持 presign 的后端`
            : `对外存储后端未注册：${id}（设置 storage.expose）`
        );
      }
      return { backend, id };
    };
    return {
      namespace,
      ...(scope ? { scope } : {}),
      backendId: () => routedIdOf(namespace, scope) ?? primaryId(),
      // 方法统一返回 Promise：主存储没配好时以 rejected promise 暴露原因，调用方 await/catch 一处处理。
      async head(key) {
        const scoped = keyOf(key);
        const current = resolveBackend(namespace, scope);
        const stat = await current.backend.head(scoped, scope);
        if (stat !== null) return stat;
        if (current.isPrimary) return null;
        // 路由后端不认识它：读主存储的旧对象，并顺手补传到路由后端（best-effort）。
        const fallback = await primary().head(scoped, scope);
        if (fallback === null) return null;
        await backfill(current.backend, current.id, namespace, scoped, scope);
        return fallback;
      },
      async get(key) {
        return readObject(resolveBackend(namespace, scope), namespace, keyOf(key), scope);
      },
      async openRead(key, range) {
        const scoped = keyOf(key);
        const current = resolveBackend(namespace, scope);
        // 主存储直接读：未命中就是未命中（归属错了要修归属，不能在这里跨后端猜）。
        if (current.isPrimary) return readStream(current.backend, scoped, scope, range);
        try {
          return await readStream(current.backend, scoped, scope, range);
        } catch (error) {
          if (!isStorageObjectNotFoundError(error)) throw error;
          // 旧对象在这里回落到主存储；补传需要完整字节，所以整读一次再按区间切。
          const object = await primary().get(scoped, scope);
          await backfill(current.backend, current.id, namespace, scoped, scope, object);
          const bytes = range ? object.bytes.subarray(range.start, range.end + 1) : object.bytes;
          return { bytes: (async function* () { yield bytes; })(), cancel() {} };
        }
      },
      async put(key, bytes, contentType) {
        const current = resolveBackend(namespace, scope);
        await current.backend.put(keyOf(key), bytes, contentType, scope);
      },
      async putStream(key, bytes, contentType, options) {
        const { backend } = resolveBackend(namespace, scope);
        if (!backend.putStream) throw new Error("当前存储后端不支持流式写入");
        await backend.putStream(keyOf(key), bytes, contentType, options, scope);
      },
      async delete(key) {
        const current = resolveBackend(namespace, scope);
        // 不支持删除是能力缺失，不是「删了但没删掉」：明确报错，别让调用方以为数据没了。
        if (!current.backend.delete) throw new Error(`存储后端不支持删除：${current.backend.backendId}`);
        await current.backend.delete(keyOf(key), scope);
      },
      canExpose: () => {
        const mainId = routedIdOf(namespace, scope) ?? primaryId();
        const main = backends.get(mainId);
        if (main?.presign) return true;
        const id = exposeIdOf();
        if (!id || id === mainId) return false;
        return typeof backends.get(id)?.presign === "function";
      },
      async expose(key, presignOptions) {
        const scoped = keyOf(key);
        const current = resolveBackend(namespace, scope);
        // ① 当前后端能签名就直接签（现在的 COS 部署走这条）。
        if (current.backend.presign) return current.backend.presign(scoped, presignOptions, scope);
        // ② 否则用对外后端：缺对象就从当前后端复制过去再签名；key 内容寻址，复制幂等、可缓存。
        const { backend: target, id } = exposeTarget();
        const known = await target.head(scoped, scope);
        if (!known) {
          // 来源走读时回填：同步前生成的资产可能还在主存储里。
          const object = await readObject(current, namespace, scoped, scope);
          await target.put(scoped, object.bytes, object.contentType ?? "application/octet-stream", scope);
          log({ event: "storage-expose-copy", namespace, backendId: id, size: object.bytes.byteLength });
        }
        return target.presign!(scoped, presignOptions, scope);
      }
    };
  };

  return {
    register(backend) {
      if (backends.has(backend.backendId)) throw new Error(`存储后端已注册：${backend.backendId}`);
      // 画布托管存储只能有一个承载者：两个接入同时声明时按注册顺序用先到的，
      // 并留下告警——这种配置错误会表现成"同一张画布一半数据在 A、一半在 B"。
      const claimed = backend.canvasScoped === true ? canvasBackendIdOf() : undefined;
      backends.set(backend.backendId, backend);
      log({ event: "storage-backend-registered", backendId: backend.backendId, label: backend.label, presign: typeof backend.presign === "function", canvasScoped: backend.canvasScoped === true });
      if (claimed !== undefined && claimed !== backend.backendId) {
        log({
          event: "storage-canvas-backend-conflict",
          backendId: backend.backendId,
          usingBackendId: claimed,
          message: "已有后端正承载画布托管存储：新的声明被忽略（按注册顺序取第一个）"
        });
      }
      return () => {
        if (backends.get(backend.backendId) === backend) {
          backends.delete(backend.backendId);
          log({ event: "storage-backend-unregistered", backendId: backend.backendId });
        }
      };
    },
    unregister(backendId) {
      if (backends.delete(backendId)) log({ event: "storage-backend-unregistered", backendId });
    },
    list: () => [...backends.values()],
    resolve: (backendId) => backends.get(backendId),
    async readLocator(locator) {
      // locator 的解析只在这里发生：拆出 backendId 交给对应后端，使用方看不到键布局。
      const rest = locator.startsWith("media://") ? locator.slice("media://".length) : "";
      const slash = rest.indexOf("/");
      if (slash <= 0 || slash === rest.length - 1) throw new Error(`locator 形状不合法：${locator}`);
      const backendId = rest.slice(0, slash);
      const backend = backends.get(backendId);
      if (!backend) throw new Error(`locator 指向未注册的存储后端：${backendId}`);
      if (typeof backend.readLocator !== "function") {
        throw new Error(`存储后端 ${backendId} 不支持按 locator 读取`);
      }
      return backend.readLocator(locator);
    },
    bucket,
    async replicate(namespace, key, replicateOptions) {
      const targetId = replicateOptions.targetBackendId?.trim();
      if (!targetId) throw new Error("storage.replicate 缺少目标后端 id");
      const target = backends.get(targetId);
      if (!target) throw new Error(`存储后端未注册：${targetId}（storage.replicate 的目标后端）`);

      // 来源：显式指定优先（回填存量资产时要显式给主存储），否则按画布路由，最后才是主存储。
      const sourceId = replicateOptions.sourceBackendId?.trim() || routedIdOf(namespace, replicateOptions.scope) || primaryId();
      const source = backends.get(sourceId);
      if (!source) throw new Error(`存储后端未注册：${sourceId}（storage.replicate 的来源后端）`);
      if (source === target) return false;

      const scoped = `${namespace}/${key}`;
      // 内容寻址：目标已有同一对象就是幂等命中，不再读来源、不再写。
      if ((await target.head(scoped, replicateOptions.scope)) !== null) return false;
      const object = await source.get(scoped, replicateOptions.scope);
      await target.put(scoped, object.bytes, object.contentType ?? "application/octet-stream", replicateOptions.scope);
      log({
        event: "storage-replicate",
        namespace,
        backendId: targetId,
        sourceBackendId: sourceId,
        size: object.bytes.byteLength
      });
      return true;
    },
    primaryId,
    exposeId: exposeIdOf,
    readiness() {
      const id = primaryId();
      return backends.has(id)
        ? { ready: true }
        : { ready: false, reason: `主存储后端未注册：${id}（设置 storage.primary）` };
    }
  };
}

/**
 * 这张画布是否**属于远端存储**（持久归属，答案来自画布服务的持久记录）。
 *
 * 只问归属，不问链路状态：`syncStateOf` 回答的是「此刻同步到哪一步」，断线、房间未加载、
 * 空闲回收都会让它变空——用它选后端，会在这些时刻把托管存储里的对象当本地对象找，
 * 把已生成成功的产物报成不存在。
 */
function isRemoteCanvas(
  canvas: { remoteCanvasIds: () => readonly string[] } | undefined,
  canvasId: string
): boolean {
  return canvas?.remoteCanvasIds().includes(canvasId) ?? false;
}

/** 核心层插件：提供 `ctx.storage`，并把「主存储是否可用」挂进就绪检查。 */
export const storagePlugin: HostPlugin = {
  name: "storage",
  inject: ["log", "gateway", "config"],
  apply(ctx) {
    const service = createStorageRegistry({
      settings: {
        primary: () => String(ctx.config.get("storage.primary") ?? DEFAULT_PRIMARY_STORAGE),
        expose: () => {
          const value = ctx.config.get("storage.expose");
          return typeof value === "string" && value.trim() !== "" ? value : undefined;
        }
      },
      // canvas 在本插件之后装载，因此按 key 懒取：路由只在真正读写时被问到。
      //
      // 判据是**归属**（这张画布属于远端），不是**链路状态**（此刻连没连上）。
      // 用链路状态判会出真实故障：远端生成的结果由服务端写进托管存储，客户端采纳时
      // 若因为「链路暂时不在」回落主存储，就会去一个根本没有该对象的地方找，把成功
      // 生成的结果报成「核验失败」。归属由宿主持久记录（`canvas-storage-ownership`），
      // 重启后、画布未打开时同样成立。
      // 承载者由后端自己声明 `canvasScoped`；没有声明者（没接远端）时自动回落主存储。
      route: (_namespace, canvasId) => isRemoteCanvas(ctx.get("canvas"), canvasId),
      logger: ctx.log.scope("storage")
    });
    ctx.provide("storage", service);
    ctx.effect(() => ctx.gateway.readiness(READINESS_ORDER.storage, async () => service.readiness()));
  }
};
