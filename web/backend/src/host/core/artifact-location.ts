/**
 * 产物「此刻落在哪个后端」的诊断查询（只读、**仅供展示**）。
 *
 * 为什么允许跨后端：读写路径上禁止跨后端猜（归属错了要修归属，否则读写会对同一对象给出
 * 不同答案）；但这里回答的是「它现在在哪」，而位置**本来就会变**——用户改过
 * `storage.primary`、画布归属变过、或者对象只在外发副本里。对一个已经写完的对象，只有
 * 逐个后端问一遍才答得出来，而且这个答案不会被任何写路径复用。
 *
 * 顺序：先问当前路由到的后端（绝大多数情况一次命中），未命中再按注册顺序问其余后端。
 * 不缓存：下一次打开面板时位置可能已经变了。
 */
import type { HostStorageService, StorageScope } from "@woohaa3/contracts";

export type ArtifactLocation = {
  /** 承载字节的后端 id。 */
  backendId: string;
  /** 后端使用的键（已含 namespace）。 */
  key: string;
  /** `media://<backendId>/<key>`；后端实现了 `locatorOf` 时用它的值。 */
  locator: string;
};

export type LocateArtifactOptions = {
  storage: HostStorageService;
  /** media namespace 内的稳定键。 */
  storageKey: string;
  scope?: StorageScope;
  /** 诊断日志出口。 */
  logger?: (event: Record<string, unknown>) => void;
};

/** media namespace：与 `media-service` 的键布局一致。 */
const MEDIA_NAMESPACE = "media";

export async function locateArtifact(options: LocateArtifactOptions): Promise<ArtifactLocation | null> {
  const { storage, storageKey, scope } = options;
  const log = options.logger ?? (() => undefined);
  const bucket = storage.bucket(MEDIA_NAMESPACE, scope);
  const key = `${MEDIA_NAMESPACE}/${storageKey}`;

  // 先问路由到的后端，再按注册顺序问其余：主存储通常一次命中，避免每次都把所有后端问一遍。
  const routedId = bucket.backendId();
  const candidates = [
    routedId,
    ...storage.list().map((backend) => backend.backendId).filter((id) => id !== routedId)
  ];

  for (const backendId of candidates) {
    const backend = storage.resolve(backendId);
    if (!backend) continue;
    try {
      if ((await backend.head(key, scope)) === null) continue;
    } catch (error) {
      // 单个后端不可用（凭据过期、网络）不该让诊断整体失败：记一笔，继续问下一个。
      log({
        event: "artifact-locate-failed",
        backendId,
        reason: error instanceof Error ? error.name : "unknown"
      });
      continue;
    }
    const locator = (await backend.locatorOf?.(key, scope)) ?? `media://${backendId}/${key}`;
    if (backendId !== routedId) {
      log({ event: "artifact-locate-elsewhere", backendId, routedId, storageKey });
    }
    return { backendId, key, locator };
  }

  log({ event: "artifact-locate-missed", routedId, storageKey });
  return null;
}
