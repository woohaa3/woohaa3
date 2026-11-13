/**
 * `host-http-timing.mjs` 的类型声明。
 *
 * 该模块是宿主 HTTP 服务的连接时间参数（纯 ESM，由 `node --test` 覆盖），被四个生产入口消费：
 * 三个 `.mjs` 脚本与 `web/backend/src/server.ts`。本文件让 TS 侧有准确签名，不把 `allowJs` 打开。
 */

export declare const HOST_HTTP_TIMING: Readonly<{
  /** 空闲 keep-alive 连接保留时长（毫秒）。 */
  keepAliveTimeoutMs: number;
  /** 等待完整请求头的上限，必须大于 `keepAliveTimeoutMs`（毫秒）。 */
  headersTimeoutMs: number;
  /** 整个请求的上限；0 表示不限制（大包上传与长轮询需要）。 */
  requestTimeoutMs: number;
}>;

/** 只设置 Node 既有的三个时间属性，返回同一个实例；不包装、不监听事件。 */
export declare function applyHostHttpTiming<T extends {
  keepAliveTimeout: number;
  headersTimeout: number;
  requestTimeout: number;
}>(server: T): T;
