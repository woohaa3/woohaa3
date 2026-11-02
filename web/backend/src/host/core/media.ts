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
import { createMediaImageDerivativeGenerator } from "./media-derivative-generator.js";

export const mediaPlugin: HostPlugin<{ env: Record<string, string | undefined>; storage?: MediaStorage }> = {
  name: "media",
  inject: ["log", "gateway", "storage", "exposer"],
  apply(ctx, { env, storage }) {
    const logger = ctx.log.scope("media");
    // 预览缩略图：没有这个执行器，`?variant=thumbnail` 一律 415，前端只能回退原图
    // （资源页一屏几十张 4K PNG，单张 8–23 MB）。拿不到解码产物时返回 undefined，
    // 行为退回原样，不影响媒体读写本身。
    const derivativeGenerator = createMediaImageDerivativeGenerator({ log: logger });
    const media = createMediaService({
      env,
      storage: storage ?? createMediaStorageFromStorage(ctx.storage, ctx.exposer),
      logger,
      ...(derivativeGenerator ? { derivativeGenerator } : {})
    });
    ctx.effect(() => () => media.close());
    ctx.provide("media", media);
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.media, (req, res) => media.handle(req, res)));
    ctx.effect(() => ctx.gateway.readiness(READINESS_ORDER.media, () => media.readiness()));
  }
};
