/**
 * 本机宿主 HTTP 服务的连接时间参数（**唯一来源**）。
 *
 * 放在 `.mjs` 而不是 TypeScript，是因为四个生产入口里有三个是脚本形态
 * （`scripts/serve-web.mjs`、`scripts/lib/web-host-runtime.mjs`、`scripts/lib/desktop-host-runtime.mjs`），
 * 它们运行在宿主的原始源码目录、不经过构建管道；TypeScript 侧的 `web/backend/src/server.ts`
 * 反向引用这里，保证四处参数永远一致。
 *
 * **为什么要显式设置**：Node 的 `server.keepAliveTimeout` 缺省是 **5 秒**。本机宿主面对的客户端
 * 经常在两次请求之间有较长的空档——导入大场景包、等待用户在大文件选择框里操作、生成任务轮询之外的
 * 静默期——一旦空档超过 5 秒，服务端会主动关闭空闲的 keep-alive 连接，而浏览器侧的连接池可能仍把
 * 它当作可复用连接发下一个请求，结果是 `ECONNRESET`：用户看到「网络错误」，服务端日志里却没有任何
 * 异常（连接在进入请求处理之前就被关闭了）。
 *
 * 实测案例：`scene-package-integration` 连续导入三个场景包，第二个包生成耗时约 6–9 秒，
 * 期间连接空闲超过 5 秒，导入 `image` 包时稳定 `ECONNRESET`；把 `keepAliveTimeout` 提到 2 分钟后
 * 连续三次运行均通过。
 *
 * 本机宿主只服务单个用户的本机浏览器，长空闲是正常使用形态而不是异常，因此：
 *
 * - `keepAliveTimeoutMs` 放到 2 分钟，覆盖导入/操作空档；
 * - `headersTimeoutMs` 必须**显著大于** `keepAliveTimeoutMs`（Node 要求），否则长连接会在读头阶段超时；
 * - `requestTimeoutMs` 保持 0（不限制），因为大场景包上传与长轮询请求本来就可能持续很久。
 *
 * 这些是**服务端**参数；浏览器端的连接复用策略不受本仓控制，所以服务端必须容忍长空闲。
 */
export const HOST_HTTP_TIMING = Object.freeze({
  /** 空闲 keep-alive 连接保留时长（毫秒）。 */
  keepAliveTimeoutMs: 120_000,
  /** 等待完整请求头的上限，必须大于 `keepAliveTimeoutMs`（毫秒）。 */
  headersTimeoutMs: 125_000,
  /** 整个请求的上限；0 表示不限制（大包上传与长轮询需要）。 */
  requestTimeoutMs: 0
});

/**
 * 把 `HOST_HTTP_TIMING` 应用到 HTTP / HTTPS 服务实例，并返回同一个实例。
 *
 * 用法：`const server = applyHostHttpTiming(http.createServer(handler));`
 *
 * 只设置三个既有的 Node 属性，不包装 server、不监听事件——调用方原有的 `error` / `upgrade` /
 * `listen` 行为完全不变。
 */
export function applyHostHttpTiming(server) {
  server.keepAliveTimeout = HOST_HTTP_TIMING.keepAliveTimeoutMs;
  server.headersTimeout = HOST_HTTP_TIMING.headersTimeoutMs;
  server.requestTimeout = HOST_HTTP_TIMING.requestTimeoutMs;
  return server;
}
