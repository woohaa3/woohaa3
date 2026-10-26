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

/** 官方发布公钥（Ed25519 SPKI DER base64；keyId = sha256(SPKI DER) 前 16 hex）。 */
export const OFFICIAL_MARKETPLACE_TRUSTED_KEYS: readonly TrustedKey[] = Object.freeze([
  Object.freeze({
    keyId: "aadb5d097b0d9234",
    publicKey: "MCowBQYDK2VwAyEA9BSsnRjDqAC9oW4PmDez8mNNi5cSJY3aocXRu20o47E="
  })
]);
