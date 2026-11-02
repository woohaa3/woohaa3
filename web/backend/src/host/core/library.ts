/**
 * 核心层 · library：素材库的装配与路由登记。
 *
 * 服务本体在 `library-store.ts`（索引）与 `api/library-api.ts`（HTTP）里，这里只做三件事：
 * 1. 从任务库同目录推出索引文件路径（不新增环境变量，照 telemetry 的做法）；
 * 2. 把 `/api/library/*` 登记进 gateway；
 * 3. 令牌从环境变量读，**没配置就不开放写操作**（见 `library-api.ts` 的说明）。
 *
 * 它 inject `media`：下载与内容寻址都交给媒体层，这里不碰字节。
 */
import path from "node:path";
import { createLibraryApi } from "../../api/library-api.js";
import { readStorePath } from "../../composition/config.js";
import { createLibraryStore } from "./library-store.js";
import type { HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";

/** 素材库索引文件：与任务库、遥测库同目录。 */
export function libraryStorePath(env: Record<string, string | undefined>): string {
  return path.join(path.dirname(readStorePath(env)), "library.json");
}

/**
 * 读访问令牌。
 *
 * 部署时由启动脚本写入；开发期可以在 shell 里自己设。
 * 空值是有意义的状态：**接口仍然注册**（`/ping` 与列表要能用来诊断），
 * 但写操作返回 503 并说明原因 —— 比「服务不存在」更容易排查。
 */
export function readLibraryToken(env: Record<string, string | undefined>): string {
  return (env.WOOHAA3_LIBRARY_TOKEN ?? "").trim();
}

export const libraryPlugin: HostPlugin<{ env: Record<string, string | undefined> }> = {
  name: "library",
  inject: ["gateway", "media"],
  apply(ctx, { env }) {
    const api = createLibraryApi({
      store: createLibraryStore(libraryStorePath(env)),
      // 后端媒体端口：下载、校验、内容寻址都在它内部完成。
      media: ctx.media.port(),
      token: readLibraryToken(env)
    });
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.library, (req, res) => api(req, res)));
  }
};
