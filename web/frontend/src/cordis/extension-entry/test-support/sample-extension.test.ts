/**
 * 样例前端 fixture 入口验收
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 5.1 / design D6；
 *  change: 2026-10-10-unify-extension-frontend-entry，任务 2.1/3.1：入口为完整 Cordis plugin，
 *  生产清单由扫描派生且不含 fixture）。
 *
 * 验证站点 reconcile 驱动 fixture 入口的 owner-scoped 进入/释放，且生产清单不含 fixture。
 *
 * @vitest-environment node
 */
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { ApplicationExtensionFrontendEntryRegistry } from "../contract.js";
import { createApplicationExtensionEntryReconciler } from "../reconciler.js";
import { APPLICATION_EXTENSION_FRONTEND_ENTRIES } from "../manifest.js";
import { createSampleFrontendEntry, type SampleFrontendProbe } from "@woohaa3/extension-sample-site/frontend";
import { SAMPLE_SITE_EXTENSION_ID } from "@woohaa3/extension-sample-site/shared";
import type { ApplicationExtensionStatus } from "@woohaa3/contracts";

function status(actualState: ApplicationExtensionStatus["actualState"]): ApplicationExtensionStatus {
  return {
    extensionId: SAMPLE_SITE_EXTENSION_ID,
    desiredEnabled: actualState === "active",
    actualState,
    configVersion: 1,
    extensionRevision: 1,
    activeWorkCount: 0,
    diagnostics: []
  };
}

describe("样例前端 fixture 验收（任务 5.1）", () => {
  it("active 进入、停用释放，且生产扫描清单不含 fixture", async () => {
    const probe: SampleFrontendProbe = { entered: 0, disposed: 0 };
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register(createSampleFrontendEntry(probe));
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });

    reconciler.reconcile([status("active")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probe.entered).toBe(1);
    reconciler.reconcile([status("disabled")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probe.disposed).toBe(1);

    await reconciler.dispose();
    expect(reconciler.activeExtensionIds()).toEqual([]);
    // 生产清单不再构建期扫描；样例 fixture 不在生产集合中，显式注入才生效。
    expect(APPLICATION_EXTENSION_FRONTEND_ENTRIES.some((entry) => entry.extensionId === SAMPLE_SITE_EXTENSION_ID)).toBe(false);
    expect(APPLICATION_EXTENSION_FRONTEND_ENTRIES).toHaveLength(0);
  });
});
