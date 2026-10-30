/**
 * 核心层 · media：内容寻址、导入校验与 `/api/media`。
 *
 * media 只是存储的使用方：字节读写走 `ctx.storage`、取外部地址走 `ctx.exposer`，
 * 都限定在 media namespace，不知道后端是 local、COS 还是服务端。
 * 测试可用内存替身覆盖（`storage` 选项）。
 */
import type { MediaStorage } from "@woohaa3/contracts";
import { createMediaService } from "@woohaa3/media-service";
import { createMediaStorageFromStorage } from "../../ports/media-storage.js";
import type { HostPlugin } from "../context.js";
import { READINESS_ORDER, ROUTE_ORDER } from "../order.js";

export const mediaPlugin: HostPlugin<{ env: Record<string, string | undefined>; storage?: MediaStorage }> = {
  name: "media",
  inject: ["log", "gateway", "storage", "exposer"],
  apply(ctx, { env, storage }) {
    const media = createMediaService({
      env,
      storage: storage ?? createMediaStorageFromStorage(ctx.storage, ctx.exposer),
      logger: ctx.log.scope("media")
    });
    ctx.effect(() => () => media.close());
    ctx.provide("media", media);
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.media, (req, res) => media.handle(req, res)));
    ctx.effect(() => ctx.gateway.readiness(READINESS_ORDER.media, () => media.readiness()));
  }
};
