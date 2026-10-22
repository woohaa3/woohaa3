/**
 * 同步传输抽象（change: split-web-runtime-services）。
 *
 * `SyncSocket` 是浏览器 provider 与服务端 sync session **共用**的最小传输契约，
 * 因此属于跨单元契约层。只要满足这几条，就能承载同步协议；具体实现（浏览器
 * `WebSocket`、Node `ws`、内存 fake）由各运行单元提供。
 */
export type SyncSocket = {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: Uint8Array) => void): () => void;
  onClose(handler: () => void): () => void;
  /**
   * 连接就绪回调（可选）。
   *
   * 浏览器 `WebSocket` 在 `CONNECTING` 状态下 `send()` 会抛错，因此 provider **必须**等
   * 连接打开后再发出站消息。省略时视为「立即可写」（内存 fake / 已连接的传输）。
   */
  onOpen?: (handler: () => void) => () => void;
  /** 当前是否可写；省略时视为 true。 */
  isOpen?: () => boolean;
  /**
   * 当前底层未发送字节数（可选）。
   *
   * Canvas Session 用它判定慢 consumer 并在超出队列上限时有界关闭；省略时视为 0。
   */
  bufferedAmount?: () => number;
};
