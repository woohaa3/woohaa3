/**
 * 实例绑定（change: 2026-10-21-isolate-extension-host-process，D4/D6）：把一个子进程实例的 RPC 端点
 * 接到宿主侧——处理子进程上报的 ctx.*（ready / health / log / diagnostic / generation / gateway）、
 * 存储代理与鉴权回调，并在宿主镜像它的 Provider 登记与路由。
 *
 * 镜像对象（Provider 桩、路由表）的「目标实例」通过 `target()` 现取：蓝绿切换只需替换目标指针，
 * 不必重建桩（D10 第 3 步）。绑定只**收集**登记；真正放进 `ctx.generation` / gateway 由代理插件按
 * 当前活跃绑定决定（崩溃、切换时整体撤换）。
 */
import {
  EXTENSION_HOST_METHODS,
  type ExtensionHostCapabilities,
  type ExtensionHostHealthSnapshot,
  type ExtensionHostProviderRegistration,
  type ExtensionHostRouteRegistration,
  type HostStorageService
} from "@woohaa3/contracts";
import { decodeLarge, encodeLarge, RpcError, type RpcEndpoint } from "../rpc/index.js";
import { routeAllowed } from "./descriptor.js";

export type ReadyResult = { ok: true } | { ok: false; error: { code: string; message: string } };

export type InstanceBindingEvents = {
  /** 子进程登记 / 替换 Provider（同 providerId 视为替换）。 */
  onProviderRegistered?(registration: ExtensionHostProviderRegistration): void;
  onProviderUnregistered?(providerId: string): void;
  onRouteAdded?(route: ExtensionHostRouteRegistration): void;
  onRouteRemoved?(routeId: string): void;
  onHealth?(health: ExtensionHostHealthSnapshot): void;
};

export type InstanceBinding = {
  readonly rpc: RpcEndpoint;
  /** 子进程 apply 完成（或失败）的回报。 */
  readonly ready: Promise<ReadyResult>;
  /** 首次健康上报（子进程首帧必发）。 */
  readonly firstHealth: Promise<ExtensionHostHealthSnapshot>;
  health(): ExtensionHostHealthSnapshot | undefined;
  providers(): ReadonlyMap<string, ExtensionHostProviderRegistration>;
  routes(): ReadonlyMap<string, ExtensionHostRouteRegistration>;
  /** 解除全部处理器（实例结束或被替换时）。 */
  dispose(): void;
};

export type InstanceBindingOptions = {
  extensionId: string;
  instanceId: string;
  rpc: RpcEndpoint;
  /** 实例结束信号：未回报 ready / 首次健康的等待者在此以失败收尾。 */
  exited: Promise<unknown>;
  capabilities: ExtensionHostCapabilities;
  log: (event: Record<string, unknown>) => void;
  /** 宿主存储（`storageNamespaces` 为空时不提供任何存储代理）。 */
  storage?: HostStorageService;
  /** 子进程 `ctx.access.assertAction` 回调（按 requestId 鉴权，见 gateway-forward）。 */
  assertForRequest?: (params: unknown) => Promise<null>;
  events?: InstanceBindingEvents;
};

export function bindInstance(options: InstanceBindingOptions): InstanceBinding {
  const { rpc, capabilities, extensionId, instanceId } = options;
  const log = (event: Record<string, unknown>) => options.log({ extension: extensionId, instanceId, ...event });
  const providers = new Map<string, ExtensionHostProviderRegistration>();
  const routes = new Map<string, ExtensionHostRouteRegistration>();
  let health: ExtensionHostHealthSnapshot | undefined;
  const offs: Array<() => void> = [];

  let resolveReady!: (result: ReadyResult) => void;
  const ready = new Promise<ReadyResult>((resolve) => {
    resolveReady = resolve;
  });
  let resolveHealth!: (snapshot: ExtensionHostHealthSnapshot) => void;
  const firstHealth = new Promise<ExtensionHostHealthSnapshot>((resolve) => {
    resolveHealth = resolve;
  });

  offs.push(
    rpc.onNotification(EXTENSION_HOST_METHODS.ctxReady, (params) => {
      const value = params as Partial<ReadyResult> | undefined;
      resolveReady(value?.ok === true ? { ok: true } : { ok: false, error: { code: String((value as { error?: { code?: unknown } })?.error?.code ?? "activation-failed"), message: String((value as { error?: { message?: unknown } })?.error?.message ?? "扩展激活失败") } });
    }),
    rpc.onNotification(EXTENSION_HOST_METHODS.ctxHealth, (params) => {
      const snapshot = (params ?? null) as ExtensionHostHealthSnapshot;
      health = snapshot;
      resolveHealth(snapshot);
      options.events?.onHealth?.(snapshot);
    }),
    rpc.onNotification(EXTENSION_HOST_METHODS.ctxLog, (params) => {
      const { module, ...event } = (params ?? {}) as Record<string, unknown>;
      log({ ...event, origin: "extension", ...(typeof module === "string" ? { scope: module } : {}) });
    }),
    rpc.onNotification(EXTENSION_HOST_METHODS.ctxDiagnostic, (params) => {
      log({ event: "extension-host-diagnostic", ...((params ?? {}) as Record<string, unknown>) });
    }),
    rpc.onNotification(EXTENSION_HOST_METHODS.ctxGenerationRegister, (params) => {
      const registration = params as ExtensionHostProviderRegistration;
      if (!registration || typeof registration.providerId !== "string") return;
      providers.set(registration.providerId, registration);
      options.events?.onProviderRegistered?.(registration);
    }),
    rpc.onNotification(EXTENSION_HOST_METHODS.ctxGenerationUnregister, (params) => {
      const providerId = (params as { providerId?: unknown })?.providerId;
      if (typeof providerId !== "string" || !providers.delete(providerId)) return;
      options.events?.onProviderUnregistered?.(providerId);
    }),
    rpc.onNotification(EXTENSION_HOST_METHODS.ctxGatewayRoute, (params) => {
      const route = params as ExtensionHostRouteRegistration;
      if (!route || typeof route.prefix !== "string" || typeof route.routeId !== "string") return;
      // 宿主侧复核：越权前缀不进路由表（子进程侧已先拦，这里是纵深防御）。
      if (!routeAllowed(capabilities, route.prefix)) {
        log({ event: "extension-host-route-denied", prefix: route.prefix, code: "permission-denied" });
        return;
      }
      routes.set(route.routeId, route);
      options.events?.onRouteAdded?.(route);
    }),
    rpc.onNotification(EXTENSION_HOST_METHODS.ctxGatewayUnroute, (params) => {
      const routeId = (params as { routeId?: unknown })?.routeId;
      if (typeof routeId !== "string" || !routes.delete(routeId)) return;
      options.events?.onRouteRemoved?.(routeId);
    }),
    rpc.handle(EXTENSION_HOST_METHODS.ctxAccessAssert, (params) => {
      if (!options.assertForRequest) throw new RpcError("permission-denied", "宿主未提供鉴权");
      return options.assertForRequest(params);
    })
  );

  // 存储代理（D4）：只代理 storageNamespaces 里的命名空间；其余一律 permission-denied。
  const bucketFor = (params: unknown) => {
    const { namespace, scope } = (params ?? {}) as { namespace?: unknown; scope?: unknown };
    if (typeof namespace !== "string" || !capabilities.storageNamespaces.includes(namespace)) {
      throw new RpcError("permission-denied", `未授予存储命名空间：${String(namespace)}`);
    }
    if (!options.storage) throw new RpcError("extension-host-unsupported", "宿主存储不可用");
    return options.storage.bucket(namespace, scope as never);
  };
  const storageHandler = (method: string, run: (bucket: ReturnType<typeof bucketFor>, params: Record<string, unknown>) => Promise<unknown>) =>
    rpc.handle(method, async (raw) => {
      const params = await decodeLarge<Record<string, unknown>>(rpc, raw);
      const bucket = bucketFor(params);
      return encodeLarge(rpc, await run(bucket, params));
    });
  offs.push(
    storageHandler(EXTENSION_HOST_METHODS.storageHead, (bucket, p) => bucket.head(String(p.key))),
    storageHandler(EXTENSION_HOST_METHODS.storageGet, (bucket, p) => bucket.get(String(p.key))),
    storageHandler(EXTENSION_HOST_METHODS.storagePut, async (bucket, p) => {
      const body = p.body as { bytes?: Uint8Array; contentType?: string } | undefined;
      if (!(body?.bytes instanceof Uint8Array)) throw new RpcError("rpc-protocol-error", "storage.put 缺少字节");
      await bucket.put(String(p.key), body.bytes, String(body.contentType ?? "application/octet-stream"));
      return null;
    }),
    storageHandler(EXTENSION_HOST_METHODS.storageDelete, async (bucket, p) => {
      if (!bucket.delete) throw new RpcError("extension-host-unsupported", "当前存储后端不支持删除");
      await bucket.delete(String(p.key));
      return null;
    }),
    storageHandler(EXTENSION_HOST_METHODS.storageExpose, (bucket, p) => bucket.expose(String(p.key), (p.options ?? {}) as never)),
    // presign 在 bucket 视图上的等价面就是 expose（主存储 presign 优先）。
    storageHandler(EXTENSION_HOST_METHODS.storagePresign, (bucket, p) => bucket.expose(String(p.key), (p.options ?? {}) as never))
  );

  // 实例结束：未回报 ready 的等待者以失败收尾（已 resolve 的不受影响）。
  void options.exited.then(() => {
    resolveReady({ ok: false, error: { code: "extension-crashed", message: "扩展子进程在激活完成前退出" } });
    resolveHealth(null);
  });

  return {
    rpc,
    ready,
    firstHealth,
    health: () => health,
    providers: () => providers,
    routes: () => routes,
    dispose() {
      for (const off of offs.splice(0)) off();
    }
  };
}
