/**
 * 核心层 · media：内容寻址、导入校验与 `/api/media`。
 *
 * media 只是存储的使用方：字节读写走 `ctx.storage`、取外部地址走 `ctx.exposer`，
 * 都限定在 media namespace，不知道后端是 local、COS 还是服务端。
 * 测试可用内存替身覆盖（`storage` 选项）。
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { MediaStorage } from "@woohaa3/contracts";
import { createMediaService } from "@woohaa3/media-service";
import { createMediaStorageFromStorage } from "../../ports/media-storage.js";
import type { HostPlugin } from "../context.js";
import { READINESS_ORDER, ROUTE_ORDER } from "../order.js";

/**
 * 受控下载的 DNS 解析钩子。
 *
 * `guardedDownload` 同时校验「字面 host」与「解析结果」，但解析结果只在注入了
 * `resolveHost` 时才检查。不注入时，一个指向 `127.0.0.1` 或云元数据地址的公网域名
 * 能直接穿过去——守卫看起来在位，实际只挡了写死的 IP。所以生产装配必须注入。
 */
const resolveDownloadHost = async (hostname: string): Promise<string[]> => {
  const family = isIP(hostname);
  if (family !== 0) return [hostname];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

/** 仅测试：锁定「装配确实注入了 DNS 解析」这一事实。 */
export const resolveDownloadHostForTest = resolveDownloadHost;

export const mediaPlugin: HostPlugin<{ env: Record<string, string | undefined>; storage?: MediaStorage }> = {
  name: "media",
  inject: ["log", "gateway", "storage", "exposer"],
  apply(ctx, { env, storage }) {
    const media = createMediaService({
      env,
      storage: storage ?? createMediaStorageFromStorage(ctx.storage, ctx.exposer),
      resolveHost: resolveDownloadHost,
      logger: ctx.log.scope("media")
    });
    ctx.effect(() => () => media.close());
    ctx.provide("media", media);
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.media, (req, res) => media.handle(req, res)));
    ctx.effect(() => ctx.gateway.readiness(READINESS_ORDER.media, () => media.readiness()));
  }
};
