/** Internal worker ABI. Resource identity includes the authorised canvas URL and variant. */
export const IMAGE_WORKER_VERSION = 2;
export const IMAGE_INPUT_LIMIT = 32 * 1024 * 1024;

/**
 * 解码作业。
 *
 * 压缩字节由**页面侧**读取后随作业传入：网络读取与解码使用两个独立的页级并发额度，
 * Worker 只做 CPU 计算，不再自己发请求。这样读取不再占用解码线程，解码也不再被 RTT 卡住。
 *
 * `url` 仍保留：它是作业的授权与内容身份（同 URL 合并、失败归因），Worker 只用它做校验，
 * 不再用它发请求。`bytes` 缺失时按旧 ABI 处理（Worker 自行读取，仅测试/兼容路径）。
 */
export type ImageJob = {
  version: 2;
  id: number;
  generation: number;
  url: string;
  maxEdge: number;
  encoded: boolean;
  allowThreads?: boolean;
  region?: { x: number; y: number; width: number; height: number };
  /** 已由页面侧读取并校验来源的压缩字节。 */
  bytes?: ArrayBuffer;
};
export type ImageResult = { width: number; height: number; sourceWidth: number; sourceHeight: number; pixels: Uint8Array; png?: Uint8Array; memoryBytes: number; mode?: "single" | "threaded"; computeThreads?: number };
export type ImageReply = { version: 2; id: number; generation: number } & (
  | { ok: true; result: ImageResult }
  | { ok: false; message: string; transient: boolean }
);
