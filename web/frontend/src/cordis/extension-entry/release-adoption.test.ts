/**
 * 受管扩展热登记测试（change: 2026-10-21-add-extension-marketplace-point，任务 6.3 / design D8）。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { EXTENSION_SDK_ABI_VERSION, type ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { ApplicationExtensionFrontendEntryRegistry } from "./contract.js";
import { createExtensionReleaseAdoption, type ReleaseChangedPayload } from "./release-adoption.js";

const metadata = (extensionId: string, activation: ExtensionFrontendMetadata["activation"]): ExtensionFrontendMetadata => ({
  extensionId,
  version: "1.0.0",
  label: extensionId,
  description: extensionId,
  activation,
  configScope: activation === "browser-local" ? "browser-local" : "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
});

function harness(delta: { added: string[]; upgraded: string[]; removed: string[] } | null | Error) {
  const entries = new Map([
    ["site-ext", { metadata: metadata("site-ext", "server-active"), artifactId: "a" }],
    ["local-ext", { metadata: metadata("local-ext", "browser-local"), artifactId: "b" }]
  ]);
  const registry = new ApplicationExtensionFrontendEntryRegistry();
  const events: ReleaseChangedPayload[] = [];
  let reconciles = 0;
  let adopts = 0;
  const adoption = createExtensionReleaseAdoption({
    runtime: {
      adoptRelease: async () => {
        adopts += 1;
        if (delta instanceof Error) throw delta;
        return delta;
      },
      entry: (id) => entries.get(id) as never,
      loadDescriptor: async () => ({}) as never,
      staleExtensionIds: () => (delta && !(delta instanceof Error) ? delta.upgraded : [])
    },
    registry,
    reconcile: () => {
      reconciles += 1;
    },
    emit: (payload) => events.push(payload)
  });
  return { adoption, registry, events, reconciles: () => reconciles, adopts: () => adopts };
}

const pointer = { releaseId: "1".repeat(64), href: `/extension-releases/${"1".repeat(64)}.json` };

describe("createExtensionReleaseAdoption", () => {
  it("新增 server-active 条目登记入口并 reconcile；browser-local 不在本页装配；发出事件", async () => {
    const h = harness({ added: ["local-ext", "site-ext"], upgraded: ["old"], removed: [] });
    await h.adoption.observe(pointer);
    expect(h.registry.has("site-ext")).toBe(true);
    expect(h.registry.has("local-ext")).toBe(false);
    expect(h.reconciles()).toBe(1);
    expect(h.events).toEqual([{ releaseId: pointer.releaseId, href: pointer.href, added: ["local-ext", "site-ext"], upgraded: ["old"], removed: [], pendingReopen: ["old"] }]);
  });

  it("同一 releaseId 只处理一次；空指针忽略", async () => {
    const h = harness({ added: ["site-ext"], upgraded: [], removed: [] });
    await h.adoption.observe(pointer);
    await h.adoption.observe(pointer);
    await h.adoption.observe(null);
    expect(h.adopts()).toBe(1);
    expect(h.events).toHaveLength(1);
  });

  it("读取失败不登记、不发事件，下一次通知重试", async () => {
    const h = harness(new Error("network"));
    await h.adoption.observe(pointer);
    expect(h.events).toEqual([]);
    expect(h.registry.has("site-ext")).toBe(false);
    await h.adoption.observe(pointer);
    expect(h.adopts()).toBe(2);
  });

  it("dispose 撤销本模块登记的入口", async () => {
    const h = harness({ added: ["site-ext"], upgraded: [], removed: [] });
    await h.adoption.observe(pointer);
    h.adoption.dispose();
    expect(h.registry.has("site-ext")).toBe(false);
  });
});
