/** 市场扩展点契约（change: 2026-10-21-add-extension-marketplace-point）。 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EXTENSION_INSTALL_PHASES,
  MARKETPLACE_FAILURE_CODES,
  MARKETPLACE_LOCAL_FILE_SOURCE_ID,
  isMarketplaceFailureCode
} from "./index";
import type { HostMarketplaceService, MarketplaceSource, ReleaseRef } from "../extension/services/host/marketplace.js";
import type { HostExtensionContext } from "../extension/service.js";
import type { InstalledExtensionView } from "../settings/index";

describe("marketplace 契约", () => {
  it("失败码与阶段是稳定常量", () => {
    expect(MARKETPLACE_FAILURE_CODES).toContain("MARKETPLACE_SIGNATURE_INVALID");
    expect(MARKETPLACE_FAILURE_CODES).toContain("MARKETPLACE_RESTART_UNSUPPORTED");
    expect(new Set(MARKETPLACE_FAILURE_CODES).size).toBe(MARKETPLACE_FAILURE_CODES.length);
    expect(EXTENSION_INSTALL_PHASES[0]).toBe("queued");
    expect(EXTENSION_INSTALL_PHASES).toContain("commit");
    expect(MARKETPLACE_LOCAL_FILE_SOURCE_ID).toBe("local-file");
  });

  it("isMarketplaceFailureCode 拒绝未知值", () => {
    expect(isMarketplaceFailureCode("MARKETPLACE_DIGEST_MISMATCH")).toBe(true);
    expect(isMarketplaceFailureCode("nope")).toBe(false);
    expect(isMarketplaceFailureCode(1)).toBe(false);
  });

  it("类型形状：ctx.marketplace 与来源", () => {
    expectTypeOf<HostExtensionContext["marketplace"]>().toEqualTypeOf<HostMarketplaceService>();
    expectTypeOf<ReturnType<HostMarketplaceService["register"]>>().toEqualTypeOf<() => void>();
    expectTypeOf<MarketplaceSource["resolve"]>().returns.resolves.toEqualTypeOf<ReleaseRef | null>();
    expectTypeOf<InstalledExtensionView["managed"]>().toEqualTypeOf<boolean | undefined>();
  });
});
