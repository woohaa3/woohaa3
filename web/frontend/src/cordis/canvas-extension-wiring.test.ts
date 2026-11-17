/**
 * 发布目录被采纳后才对照宿主入口脚本；同一指针重复通知不再换页。
 *
 * @vitest-environment node
 */
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import type { ApplicationExtensionReleasePointer } from "@woohaa3/contracts";
import { ApplicationExtensionFrontendEntryRegistry } from "./extension-entry/contract.js";
import { createPageExtensionReconciler } from "./canvas-extension-wiring.js";
import type { ApplicationExtensionStatusService } from "./services/application-extension-status.js";
import type { ExtensionRuntimeService } from "./extension-runtime/service.js";

const pointer = (id: string): ApplicationExtensionReleasePointer => ({
  releaseId: id.repeat(64).slice(0, 64),
  href: `/extension-releases/${id.repeat(64).slice(0, 64)}.json`
});

function page() {
  let release: ApplicationExtensionReleasePointer | null = null;
  const listeners = new Set<() => void>();
  const replaced: string[] = [];
  let fail = false;
  const status = {
    getSnapshot: () => ({
      revision: 1,
      catalog: [],
      plugins: [],
      error: null,
      loading: false,
      extensionRelease: release
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  } as unknown as ApplicationExtensionStatusService;
  const runtime = {
    async adoptRelease() {
      if (fail) throw new Error("network");
      return { added: [], upgraded: ["image-compare"], removed: [] };
    },
    entry: () => undefined,
    loadDescriptor: async () => ({}),
    staleExtensionIds: () => ["image-compare"]
  } as unknown as ExtensionRuntimeService;
  const reconciler = createPageExtensionReconciler(new Context(), {
    registry: new ApplicationExtensionFrontendEntryRegistry(),
    status,
    runtime,
    replaceDocument: async () => {
      replaced.push(release?.releaseId ?? "");
    }
  });
  return {
    replaced,
    reconciler,
    publish(next: ApplicationExtensionReleasePointer | null) {
      release = next;
      for (const listener of listeners) listener();
    },
    setFail(next: boolean) {
      fail = next;
    }
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("发布采纳后的换页", () => {
  it("新发布才换页；同一指针再来一次不再换", async () => {
    const host = page();
    const first = pointer("a");
    host.publish(first);
    await flush();
    host.publish(first);
    await flush();
    expect(host.replaced).toEqual([first.releaseId]);
    await host.reconciler.dispose();
  });

  it("读取失败不换页，下一次成功才换", async () => {
    const host = page();
    host.setFail(true);
    const first = pointer("b");
    host.publish(first);
    await flush();
    expect(host.replaced).toEqual([]);
    host.setFail(false);
    host.publish(first);
    await flush();
    expect(host.replaced).toEqual([first.releaseId]);
    await host.reconciler.dispose();
  });
});
