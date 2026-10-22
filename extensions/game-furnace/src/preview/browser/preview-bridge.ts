/**
 * 游戏炼丹炉试玩消息桥（任务 8.5）
 * （change: 2026-10-10-add-game-furnace-extension，design D12）。
 *
 * 生成代码与宿主之间的唯一通道是**受校验的自有 iframe 消息**：只接受来自当前试玩 iframe 的
 * `contentWindow`、且携带当前 **nonce** 与 **generation** 的消息，且只允许 `ready` / `error` /
 * `size` 三种白名单消息；其余（含其它 iframe/标签/旧版本伪造的 ready/error）一律忽略。
 *
 * 纯函数：不 import 宿主 store、DOM 或后端实现，便于确定性测试。
 */

/** 白名单消息。 */
export type PreviewBridgeMessage =
  | { kind: "ready" }
  | { kind: "error"; message: string }
  | { kind: "size"; width: number; height: number };

/** 消息桥校验所需的可信上下文。 */
export type PreviewBridgeContext = {
  /** 当前试玩 iframe 的 `contentWindow`（缺省/未挂载时不接受任何消息）。 */
  frameWindow: unknown;
  /** 本次短会话随机 nonce（由宿主生成并注入 iframe）。 */
  nonce: string;
  /** 当前 generation（每次开始/停止/切换自增，旧版本消息因此失效）。 */
  generation: number;
  /** 受控尺寸上限（像素），防止伪造消息撑爆布局。 */
  maxSize?: number;
};

const DEFAULT_MAX_SIZE = 8192;

/**
 * 校验一条 `message` 事件；合法时返回白名单消息，否则返回 `null`（忽略，不产生任何副作用）。
 *
 * 拒绝条件（任一不满足即忽略）：
 * - `event.source` 不是当前 iframe 的 `contentWindow`（含其它 iframe/窗口伪造）；
 * - 消息体不是对象，或 `nonce`/`generation` 不匹配（旧版本/伪造）；
 * - `kind` 不在白名单（无任意应用命令通道）；
 * - `size` 非有限正整数或超出上限；`error` 消息为超长/非字符串。
 */
export function validatePreviewBridgeMessage(
  event: { source: unknown; data: unknown },
  context: PreviewBridgeContext
): PreviewBridgeMessage | null {
  if (!context.frameWindow || event.source !== context.frameWindow) return null;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.nonce !== context.nonce) return null;
  if (record.generation !== context.generation) return null;
  const max = context.maxSize ?? DEFAULT_MAX_SIZE;
  switch (record.kind) {
    case "ready":
      return { kind: "ready" };
    case "error": {
      const message = typeof record.message === "string" ? record.message.slice(0, 300) : "";
      return { kind: "error", message };
    }
    case "size": {
      const width = record.width;
      const height = record.height;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
      if ((width as number) < 0 || (height as number) < 0 || (width as number) > max || (height as number) > max) return null;
      return { kind: "size", width: width as number, height: height as number };
    }
    default:
      return null;
  }
}

/** 生成一次性会话 nonce（优先 crypto，回退到 Math.random，均不进入 canonical/源码包）。 */
export function createPreviewNonce(): string {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`;
}

/** 把 nonce/generation 以片段形式附加到入口 URL（片段不参与服务端路径解析）。 */
export function previewEntryWithBridge(entryUrl: string, nonce: string, generation: number): string {
  return `${entryUrl}#gfn=${encodeURIComponent(nonce)}.${generation}`;
}
