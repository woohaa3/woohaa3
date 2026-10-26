/**
 * 内置官方市场公钥与信任根合并（dev / release 同一份后端代码）。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mergeTrustedKeys, parseTrustedKeys } from "./index.js";
import { OFFICIAL_MARKETPLACE_TRUSTED_KEYS } from "./official-trust.js";

describe("official marketplace trust", () => {
  it("内置公钥的 keyId 与 SPKI DER 派生值一致", () => {
    for (const key of OFFICIAL_MARKETPLACE_TRUSTED_KEYS) {
      const der = Buffer.from(key.publicKey, "base64");
      expect(createHash("sha256").update(der).digest("hex").slice(0, 16)).toBe(key.keyId);
    }
  });

  it("本机配置只能追加信任根，不能移除或替换内置公钥", () => {
    const official = OFFICIAL_MARKETPLACE_TRUSTED_KEYS[0]!;
    const merged = mergeTrustedKeys(OFFICIAL_MARKETPLACE_TRUSTED_KEYS, [
      { keyId: official.keyId, publicKey: "attacker" },
      { keyId: "corp", publicKey: "CORP" }
    ]);
    expect(merged).toEqual([official, { keyId: "corp", publicKey: "CORP" }]);
  });

  it("本机配置为空时仍然信任内置公钥", () => {
    expect(mergeTrustedKeys(OFFICIAL_MARKETPLACE_TRUSTED_KEYS, parseTrustedKeys(""))).toEqual([
      ...OFFICIAL_MARKETPLACE_TRUSTED_KEYS
    ]);
  });
});
