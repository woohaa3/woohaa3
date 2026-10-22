/**
 * 媒体读写作用域解析（画布资产远端托管）。
 *
 * 媒体服务不理解画布路由：只把调用方声明的画布 id 做形状校验后转成
 * MediaStorageScope，具体落哪个后端由 core 存储决定（见 contracts 的 StorageScope）。
 * 非法或空 id 一律视为「无画布」，由调用方决定是忽略（public 路由）还是拒绝（内部协议）。
 */
import type { MediaStorageScope } from "@woohaa3/contracts";

/** 画布 id 长度上限，与 contracts 的 isBoundedId 默认上限一致。 */
export const MAX_CANVAS_ID_LENGTH = 200;

/**
 * 画布 id 形状：以字母/数字开头，只含字母数字与 . _ : - 。
 *
 * 远端存储会把画布 id 当作对象键前缀（canvasId/...），因此这里排除路径分隔符、空白与
 * 控制字符，避免同一个 id 在键空间里产生歧义。
 */
const CANVAS_ID_PATTERN = new RegExp("^[A-Za-z0-9][A-Za-z0-9._:-]{0," + (MAX_CANVAS_ID_LENGTH - 1) + "}$");

/** 形状校验；非法返回 undefined（不抛错）。 */
export function canvasIdOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return CANVAS_ID_PATTERN.test(value) ? value : undefined;
}

/** 查询参数/协议字段 → 存储作用域；非法或空一律「无作用域」。 */
export function canvasScopeOf(value: unknown): MediaStorageScope | undefined {
  const canvasId = canvasIdOf(value);
  return canvasId === undefined ? undefined : { canvasId };
}

/** 可选 canvasId 的解码结果：缺省表示「与画布无关」，非法必须由调用方拒绝。 */
export type DecodedCanvasScope =
  | { ok: true; scope?: MediaStorageScope }
  | { ok: false; message: string };

/**
 * 可选 canvasId → 存储作用域（内部协议与扩展资源路由共用的唯一口径）。
 *
 * - 字段缺省：与画布无关，返回无作用域（保持旧行为）；
 * - 合法 id：返回 `{ canvasId }`，由存储层按画布路由；
 * - 非法 id：`ok: false`，**不能静默当成「无作用域」** —— 调用方否则会误以为字节写到了
 *   画布后端，或从主存储的错键上读而报不存在。
 */
export function decodeCanvasScope(value: unknown): DecodedCanvasScope {
  if (value === undefined) return { ok: true };
  const scope = canvasScopeOf(value);
  if (!scope) return { ok: false, message: "canvasId 必须是合法的画布 id（1-200 位字母数字与 ._: -）" };
  return { ok: true, scope };
}
