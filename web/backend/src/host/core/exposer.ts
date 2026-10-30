/**
 * 核心层 · exposer：`ctx.exposer` 扩展点（对外地址）。
 *
 * 与 `ctx.storage` 拆开的原因是两个生命周期不同：
 * - 存储缺失 → 宿主整体不可用，进就绪门槛；
 * - 对外地址缺失 → 只影响「把 URL 交给远端」的那类任务（生成 API 拉参考素材），宿主照常启动。
 * 所以本插件**不注册** `gateway.readiness`；它也从不决定字节写到哪里。
 *
 * 与 `ctx.storage` 的关系是单向的：本服务读存储（`bucket` / `resolve` / `current`），
 * 反过来不成立——storage 不认识 exposer，`storage.expose` 这个设置只由这里读取。
 *
 * 解析顺序（与设计稿一致）：
 * ① 当前后端（含画布路由）有 `presign` → 就地签名，不复制；
 * ② 否则选中 `storage.expose` 指到的提供者；`requiresReplica` 时缺对象先复制过去再签；
 * ③ 都没有 → `StorageExposeUnavailableError`。
 *
 * 隐式提供者：任何带 `presign` 的后端同时也是一个提供者（`exposerId = backendId`，
 * `requiresReplica: true`）。这样 cos / server 不必各写一份 exposer，历史配置值继续有效。
 */
import {
  StorageExposeUnavailableError,
  type HostExposerService,
  type HostStorageService,
  type StorageExposeInput,
  type StorageExposer
} from "@woohaa3/contracts";
import type { HostPlugin } from "../context.js";

export type ExposerSettings = {
  /** `storage.expose`；空值表示只用当前后端自己的签名能力。 */
  expose(): string | undefined;
};

export type ExposerRegistryOptions = {
  settings: ExposerSettings;
  storage: HostStorageService;
  logger?: (event: Record<string, unknown>) => void;
};

export function createExposerRegistry(options: ExposerRegistryOptions): HostExposerService {
  const log = options.logger ?? (() => undefined);
  const storage = options.storage;
  const registered = new Map<string, StorageExposer>();

  /** 未显式选择时的兜底：注册方声明 `default: true` 的提供者（按注册顺序取第一个）。 */
  const defaultIdOf = (): string | undefined => {
    for (const exposer of registered.values()) {
      if (exposer.default === true) return exposer.exposerId;
    }
    return undefined;
  };

  const selectedIdOf = (): string | undefined => {
    const value = options.settings.expose()?.trim();
    return value ? value : undefined;
  };

  /** 后端自带签名能力时，它同时就是一个提供者（无需插件再注册一份）。 */
  const implicitFor = (backendId: string): StorageExposer | undefined => {
    const backend = storage.resolve(backendId);
    const presign = backend?.presign;
    if (!backend || !presign) return undefined;
    return {
      exposerId: backend.backendId,
      ...(backend.label ? { label: backend.label } : {}),
      ...(backend.ownerExtensionId ? { ownerExtensionId: backend.ownerExtensionId } : {}),
      requiresReplica: true,
      targetBackendId: backend.backendId,
      expose: (input) => {
        const expires = input.expiresSeconds;
        return presign.call(
          backend,
          `${input.namespace}/${input.key}`,
          expires === undefined ? undefined : { expiresSeconds: expires },
          input.scope
        );
      }
    };
  };

  const resolve = (exposerId: string): StorageExposer | undefined =>
    registered.get(exposerId) ?? implicitFor(exposerId);

  return {
    register(exposer) {
      if (registered.has(exposer.exposerId)) throw new Error(`对外地址提供者已注册：${exposer.exposerId}`);
      registered.set(exposer.exposerId, exposer);
      log({
        event: "exposer-registered",
        exposerId: exposer.exposerId,
        label: exposer.label,
        requiresReplica: exposer.requiresReplica,
        targetBackendId: exposer.targetBackendId
      });
      return () => {
        if (registered.get(exposer.exposerId) === exposer) {
          registered.delete(exposer.exposerId);
          log({ event: "exposer-unregistered", exposerId: exposer.exposerId });
        }
      };
    },
    unregister(exposerId) {
      if (registered.delete(exposerId)) log({ event: "exposer-unregistered", exposerId });
    },
    list() {
      // 注册项在前（顺序即插件的注册顺序），隐式项补齐后端自带的能力。
      const out: StorageExposer[] = [...registered.values()];
      for (const backend of storage.list()) {
        if (registered.has(backend.backendId)) continue;
        const implicit = implicitFor(backend.backendId);
        if (implicit) out.push(implicit);
      }
      return out;
    },
    resolve,
    selectedId: () => selectedIdOf() ?? defaultIdOf(),
    available(namespace, scope) {
      const current = storage.current(namespace, scope);
      // 画布级覆盖优先：空串 = 这张画布明确不对外。
      if (current.exposure !== undefined) {
        const override = current.exposure.trim();
        return override === "" ? false : resolve(override) !== undefined;
      }
      if (current.presign) return true;
      const id = selectedIdOf() ?? defaultIdOf();
      if (!id) return false;
      return resolve(id) !== undefined;
    },
    async expose(input: StorageExposeInput) {
      const scoped = `${input.namespace}/${input.key}`;
      const current = storage.current(input.namespace, input.scope);
      // 画布级覆盖优先于部署默认，也优先于「当前后端就地签」：那是这张画布明确写下的选择，
      // 例如把这张画布的地址改由某个 CDN 提供者出、或显式关掉对外地址。
      const override = current.exposure;
      if (override !== undefined && override.trim() === "") {
        throw new StorageExposeUnavailableError("这张画布未启用对外地址（画布存储形态的 exposure 为空）");
      }
      // ① 就地签：字节不用搬家，这也是「只存本地也能对外」的入口——前提是后端自己能出地址。
      if (override === undefined && current.presign) {
        return current.presign(
          scoped,
          input.expiresSeconds === undefined ? undefined : { expiresSeconds: input.expiresSeconds },
          input.scope
        );
      }

      // ② 画布覆盖 / 部署默认选中的提供者 / 注册方声明的内置默认。
      const id = override !== undefined ? override.trim() : (selectedIdOf() ?? defaultIdOf());
      if (!id) throw new StorageExposeUnavailableError();

      const exposer = resolve(id);
      if (!exposer) {
        // 区分「没注册」与「注册了但签不了」：两者的修法完全不同。
        if (storage.resolve(id)) {
          throw new StorageExposeUnavailableError(`对外存储后端 ${id} 没有签名能力：请改配支持 presign 的后端`);
        }
        throw new StorageExposeUnavailableError(`对外存储后端未注册：${id}（设置 storage.expose）`);
      }

      if (exposer.requiresReplica) {
        const targetId = exposer.targetBackendId ?? exposer.exposerId;
        const target = storage.resolve(targetId);
        if (!target) {
          throw new StorageExposeUnavailableError(`对外存储后端未注册：${targetId}（设置 storage.expose）`);
        }
        // 缺对象才复制：key 内容寻址，复制幂等、可缓存。
        if ((await target.head(scoped, input.scope)) === null) {
          // 读来源走 bucket：它带「读时回填」，同步前生成的资产可能还在主存储里。
          const object = await storage.bucket(input.namespace, input.scope).get(input.key);
          await target.put(scoped, object.bytes, object.contentType ?? "application/octet-stream", input.scope);
          log({ event: "storage-expose-copy", namespace: input.namespace, backendId: targetId, size: object.bytes.byteLength });
        }
      }

      return exposer.expose(input);
    }
  };
}

/** 核心层插件：提供 `ctx.exposer`。刻意不挂就绪检查（缺地址能力不该拖垮宿主）。 */
export const exposerPlugin: HostPlugin = {
  name: "exposer",
  inject: ["log", "config", "storage"],
  apply(ctx) {
    const service = createExposerRegistry({
      settings: {
        expose: () => {
          // 新键优先；`storage.expose` 是升级前的旧键，留着读一版，避免已配的部署升级后
          // 突然「没有对外地址」。
          const next = ctx.config.get("exposer.primary");
          if (typeof next === "string" && next.trim() !== "") return next;
          const legacy = ctx.config.get("storage.expose");
          return typeof legacy === "string" && legacy.trim() !== "" ? legacy : undefined;
        }
      },
      storage: ctx.storage,
      logger: ctx.log.scope("exposer")
    });
    ctx.provide("exposer", service);
  }
};
