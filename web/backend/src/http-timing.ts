/**
 * 本机宿主 HTTP 服务的连接时间参数。
 *
 * 实现与常量都在 `scripts/lib/host-http-timing.mjs`：四个生产入口里有三个是 `.mjs` 脚本
 * （`serve-web.mjs`、`web-host-runtime.mjs`、`desktop-host-runtime.mjs`），它们运行未构建的源码，
 * 因此唯一来源必须放在脚本侧；这里只做类型化转出，避免两处各写一份参数然后漂移。
 *
 * 参数含义、为什么必须是 2 分钟、实测的 `ECONNRESET` 案例，见那个文件的注释。
 */
export { HOST_HTTP_TIMING, applyHostHttpTiming } from "../../../scripts/lib/host-http-timing.mjs";
