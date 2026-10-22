/**
 * 画布媒体补传注册表：状态机、作用域透传与失败处置。
 *
 * 这些用例锁住「同步中 → 已同步/失败」这条对外可见的状态语义，以及补传失败不抛给调用方。
 */
import { describe, expect, it, vi } from "vitest";
import type { HostContext } from "../context.js";
import { collectCanvasMediaKeys, createCanvasMediaBackfill } from "./canvas-media-backfill.js";

function fakeContext(input: {
  replicate: (namespace: string, key: string, options: { targetBackendId: string; scope?: { canvasId: string }; sourceBackendId?: string }) => Promise<boolean>;
  hasServer?: boolean;
}) {
  const storage = {
    resolve: (id: string) => (input.hasServer === false ? undefined : id === "server" ? { backendId: "server" } : undefined),
    primaryId: () => "cos",
    replicate: vi.fn(input.replicate)
  };
  const ctx = {
    log: { scope: () => () => undefined },
    get: (name: string) => (name === "storage" ? storage : undefined)
  } as unknown as HostContext;
  return { ctx, storage };
}

// 真实文档里的键都是内容寻址形态（contracts 的 isValidStorageKey）；夹具也必须合法，
// 否则补传会按「不是稳定键」跳过，测不到想测的行为。
const KEY_A = "generation-outputs/" + "a".repeat(64) + ".mp4";
const KEY_B = "sha256-" + "b".repeat(64);
const canvas = { assets: [{ metadata: { storageKey: KEY_A } }, { metadata: { storageKey: KEY_B } }] };

describe("createCanvasMediaBackfill", () => {
  it("没有 server 后端时不做任何事，也不产生状态", () => {
    const { ctx, storage } = fakeContext({ hasServer: false, replicate: async () => true });
    const port = createCanvasMediaBackfill(ctx, async () => canvas as never);
    port.run("c1");
    expect(port.stateOf("c1")).toBeUndefined();
    expect(storage.replicate).not.toHaveBeenCalled();
  });

  it("按画布作用域补传，完成后状态为 synced 并计数", async () => {
    const { ctx, storage } = fakeContext({ replicate: async () => true });
    const port = createCanvasMediaBackfill(ctx, async () => canvas as never);
    port.run("c1");
    // 同步阶段先可见：目录据此显示「同步中」。
    expect(port.stateOf("c1")?.state).toBe("syncing");
    await vi.waitFor(() => expect(port.stateOf("c1")?.state).toBe("synced"));
    expect(port.stateOf("c1")).toMatchObject({ total: 2, copied: 2, failed: 0 });
    expect(storage.replicate).toHaveBeenCalledTimes(2);
    expect(storage.replicate.mock.calls[0]?.[2]).toMatchObject({
      targetBackendId: "server",
      scope: { canvasId: "c1" },
      sourceBackendId: "cos"
    });
  });

  it("补传失败会计入 failed 并标记为 failed，不抛给调用方", async () => {
    const { ctx } = fakeContext({
      replicate: async (_namespace, key) => {
        if (key === KEY_B) throw Object.assign(new Error("boom"), { code: "http-413" });
        return true;
      }
    });
    const port = createCanvasMediaBackfill(ctx, async () => canvas as never);
    port.run("c1");
    await vi.waitFor(() => expect(port.stateOf("c1")?.state).toBe("failed"));
    expect(port.stateOf("c1")).toMatchObject({ total: 2, copied: 1, failed: 1 });
  });

  it("画布尚未装载时不驻留状态（目录回落文档同步状态），并允许之后重跑", async () => {
    const load = vi.fn(async () => {
      throw new Error("CANVAS_NOT_FOUND");
    });
    const { ctx } = fakeContext({ replicate: async () => true });
    const port = createCanvasMediaBackfill(ctx, load);
    port.run("c1");
    await vi.waitFor(() => expect(port.stateOf("c1")).toBeUndefined());
    expect(load).toHaveBeenCalled();
  });
});

describe("collectCanvasMediaKeys", () => {
  /**
   * 稳定键的身份由键本身决定，引用位置随功能变（assets、nodeData.imageEdit.project、录制产物…）。
   * 按字段枚举每加一个功能就要补一次，漏一次就是协作者打开时 404；这条用例锁住「按值扫」。
   */
  it("扫出 assets 与 nodeData 里的所有稳定键，忽略无关字符串", () => {
    const sha = (char: string) => "sha256-" + char.repeat(64);
    const generated = "generation-outputs/" + "c".repeat(64) + ".png";
    const canvas = {
      assets: [{ metadata: { storageKey: sha("a") } }],
      nodeData: {
        n1: { imageEdit: { project: sha("b") } },
        n2: { refs: [generated, "not-a-storage-key", "sha256-short"] }
      }
    } as never;

    expect([...collectCanvasMediaKeys(canvas)].sort()).toEqual([generated, sha("a"), sha("b")].sort());
  });

  it("同一键出现多次只补一次（内容寻址，去重后按画布计数）", () => {
    const sha = "sha256-" + "d".repeat(64);
    const canvas = { assets: [{ metadata: { storageKey: sha } }], nodeData: { n1: { project: sha } } } as never;
    expect([...collectCanvasMediaKeys(canvas)]).toEqual([sha]);
  });
});
