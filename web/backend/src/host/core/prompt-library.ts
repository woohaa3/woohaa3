/**
 * 核心层 · prompt-library：提示词库的装配与路由登记。
 *
 * 服务本体在 `api/prompt-library-api.ts`（上游取数 + 进程内缓存），这里只把
 * `/api/prompt-library` 登记进 gateway。
 *
 * **不 inject 任何服务**：它不碰存储、不碰媒体，只发一个出站 GET。也因此不进就绪检查 ——
 * 上游挂了不该拖垮宿主启动，前端在面板里看到「加载失败」即可。
 */
import { createPromptLibraryApi } from "../../api/prompt-library-api.js";
import type { HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";

export const promptLibraryPlugin: HostPlugin = {
  name: "prompt-library",
  inject: ["gateway", "log"],
  apply(ctx) {
    // `scope(module)` 直接返回写日志的函数（不是 logger 对象）；一行事件就够，失败原因前端也会显示。
    const log = ctx.log.scope("prompt-library");
    const handle = createPromptLibraryApi({ logger: log });
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.promptLibrary, (req, res) => handle(req, res)));
  }
};
