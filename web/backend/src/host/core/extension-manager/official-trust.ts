/**
 * 官方扩展市场的内置信任根（change: 2026-10-21-add-extension-marketplace-point 后续修正）。
 *
 * 只放公钥：私钥在发布侧（服务端 data/marketplace-signing.key 一类 0600 文件），
 * 永远不随客户端、dev 或 release 打包。公钥随同一份后端代码进入 dev、Web release 与
 * 桌面宿主，不需要每个部署再手工抄一次 extensions.marketplace.trustedKeys。
 *
 * 信任模型不变：这份内置 key 只证明「包由官方发布者签名」；来源（服务端）声明或下发的
 * keyId 仍然不会自动进入信任根。轮换时保留旧 key 至少一个发布周期，避免已发布的包突然失效。
 */
import type { TrustedKey } from "./types.js";

/**
 * 构建期注入的信任根（build profile 的 `extensionTrust.officialKeys`）。
 *
 * esbuild 的 define 会在产物里把这个标识符替换成字面量；没有注入时保持 `undefined`，
 * 由下面的内置常量兜底——公开仓单仓构建、测试与未配 profile 的部署行为不变。
 * 轮换公钥因此不需要改公开仓源码。
 */
declare const __WOOHAA3_OFFICIAL_TRUST_KEYS__: readonly TrustedKey[] | undefined;

/** 源码内置的官方公钥（Ed25519 SPKI DER base64；keyId = sha256(SPKI DER) 前 16 hex）。 */
const BUILTIN_OFFICIAL_TRUSTED_KEYS: readonly TrustedKey[] = Object.freeze([
  Object.freeze({
    keyId: "aadb5d097b0d9234",
    publicKey: "MCowBQYDK2VwAyEA9BSsnRjDqAC9oW4PmDez8mNNi5cSJY3aocXRu20o47E="
  })
]);

/** 读取构建期注入值；形状不合法时视为未注入（畸形信任根不应让整个宿主启动失败）。 */
function buildTimeTrustedKeys(): readonly TrustedKey[] | null {
  if (typeof __WOOHAA3_OFFICIAL_TRUST_KEYS__ === "undefined") return null;
  const injected = __WOOHAA3_OFFICIAL_TRUST_KEYS__;
  if (!Array.isArray(injected) || injected.length === 0) return null;
  const keys = injected
    .filter((key): key is TrustedKey => Boolean(key) && typeof key.keyId === "string" && typeof key.publicKey === "string")
    .map((key) => Object.freeze({ keyId: key.keyId, publicKey: key.publicKey }));
  return keys.length > 0 ? Object.freeze(keys) : null;
}

/** 生效的官方信任根：profile 注入优先，否则源码内置。 */
export const OFFICIAL_MARKETPLACE_TRUSTED_KEYS: readonly TrustedKey[] = buildTimeTrustedKeys() ?? BUILTIN_OFFICIAL_TRUSTED_KEYS;
