/**
 * 域内适配层检查：WASM 句柄与会话包装的错误边界。
 *
 * 这里不创建渲染上下文，只用一个**记录调用**的内核替身验证三件事：
 * 1. 参数按 JSON 传进内核、结果按 JSON 解析回来（wire 形态不被适配层改写）；
 * 2. 内核抛错被转成 `EditorResult` 失败，而不是冒泡成异常；
 * 3. 只读读取（快照/预设/拖绘参数）不会走 `afterWrite`，因此不推进修订与历史。
 */
import { describe, expect, it } from "vitest";
import { createHandle } from "./wasm-handle.js";
import { createSession } from "./workspace.js";
import type { FeatureHandleContext } from "../contracts.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";

function handleContext(instance: Partial<Record<string, unknown>>, calls: string[] = []) {
  const context: FeatureHandleContext = {
    instance: instance as never,
    call: (run) => {
      try { return { ok: true, value: run(instance as never) }; }
      catch (error) { return { ok: false, code: "command-failed", message: String((error as { message?: string }).message ?? error) }; }
    },
  };
  return { context, calls };
}

describe("矢量 WASM 句柄（U08–U16 的域内适配层）", () => {
  it("命令、快照、预设库与拖绘参数都按 JSON 往返，不改写 wire 形态", () => {
    const seen: { id?: string; params?: string; draw?: string } = {};
    const instance = {
      vectorCommand: (id: string, params: string) => { seen.id = id; seen.params = params; return JSON.stringify({ layer: 7 }); },
      vectorSnapshotJson: () => JSON.stringify({ shapes: [], vectorMasks: [], paths: [] }),
      vectorPresetsJson: () => JSON.stringify({ groups: [], custom: [], revision: 2 }),
      vectorDrawParamsJson: (input: string) => { seen.draw = input; return JSON.stringify({ kind: "rect", rect: [0, 0, 10, 10] }); },
    };
    const { context } = handleContext(instance);
    const handle = createHandle(() => context);

    expect(handle.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 10, 10] }))
      .toEqual({ ok: true, value: { layer: 7 } });
    expect(seen.id).toBe("shape.create");
    expect(JSON.parse(seen.params!)).toEqual({ kind: "rect", rect: [0, 0, 10, 10] });

    expect(handle.vectorSnapshot()).toEqual({ ok: true, value: { shapes: [], vectorMasks: [], paths: [] } });
    expect(handle.vectorPresets()).toEqual({ ok: true, value: { groups: [], custom: [], revision: 2 } });

    expect(handle.vectorDrawParams({ kind: "rect", start: [0, 0], end: [10, 10] })).toEqual({ ok: true, value: { kind: "rect", rect: [0, 0, 10, 10] } });
    expect(JSON.parse(seen.draw!)).toEqual({ kind: "rect", start: [0, 0], end: [10, 10] });
  });

  it("内核拒绝被转成失败结果，不冒泡成异常", () => {
    const instance = {
      vectorCommand: () => { throw { code: "command-failed", message: "命令 shape 被拒绝：形状面积为零" }; },
      vectorDrawParamsJson: () => { throw new Error("几何非法"); },
    };
    const { context } = handleContext(instance);
    const handle = createHandle(() => context);

    const rejected = handle.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 0, 0] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toMatch(/面积为零/);

    const invalid = handle.vectorDrawParams({ kind: "rect" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toMatch(/几何非法/);
  });
});

describe("矢量工作区会话（拒绝/只读/一步历史）", () => {
  function workspace(options: {
    handle?: unknown;
    blocked?: { code: string; message: string } | null;
    frozen?: boolean;
    command?: (id: string, params: unknown) => { ok: boolean; value?: unknown; message?: string };
  } = {}) {
    const writes: string[] = [];
    let revision = 0;
    const context = {
      handle: options.handle === null ? null : options.handle ?? {
        vectorCommand: options.command ?? (() => ({ ok: true, value: {} })),
        vectorSnapshot: () => ({ ok: true, value: { shapes: [] } }),
        features: { vectors: {
          vectorPresets: () => ({ ok: true, value: { groups: [], custom: [] } }),
          vectorDrawParams: () => ({ ok: true, value: { kind: "rect" } }),
        } },
      },
      view: {} as never,
      blockingDraft: () => options.blocked ? { ok: false as const, ...options.blocked } : null,
      blockingDraftExceptVector: () => options.blocked ? { ok: false as const, ...options.blocked } : null,
      vectorToken: () => ({ generation: 0, session: 0 }),
      writesFrozen: () => options.frozen === true,
      unavailable: (): { ok: false; code: string; message: string } => ({ ok: false, code: "no-document", message: "没有打开的文档" }),
      fail: <T,>(failure: { code: string; message: string }) => ({ ok: false as const, code: failure.code, message: failure.message }) as unknown as import("../../editor-wasm.js").EditorResult<T>,
      // 只有真正写入才推进修订并记一次提交。
      afterWrite: () => { writes.push("write"); revision += 1; return { ok: true, value: { revision } }; },
    } as unknown as WorkspaceFeatureContext;
    return { session: createSession(() => context), writes, revision: () => revision };
  }

  it("只读读取不产生写入：快照/预设库/拖绘参数都不推进修订", () => {
    const { session, writes, revision } = workspace();
    expect(session.vectorSnapshot().ok).toBe(true);
    expect(session.vectorPresets().ok).toBe(true);
    expect(session.vectorDrawParams({ kind: "rect" }).ok).toBe(true);
    expect(writes).toEqual([]);
    expect(revision()).toBe(0);
  });

  it("一次命令只提交一次写入；被内核拒绝时零写入", () => {
    const accepted = workspace();
    accepted.session.vectorCommand("shape.create", { kind: "rect" });
    expect(accepted.writes).toEqual(["write"]);
    expect(accepted.revision()).toBe(1);

    const rejected = workspace({ command: () => ({ ok: false, message: "命令 shape 被拒绝" }) });
    const result = rejected.session.vectorCommand("shape.create", { kind: "rect" });
    expect(result.ok).toBe(false);
    expect(rejected.writes).toEqual([]);
    expect(rejected.revision()).toBe(0);
  });

  it("未打开的文档与进行中的草稿都在写入前被拦下", () => {
    const closed = workspace({ handle: null });
    expect(closed.session.vectorCommand("shape.create", {}).ok).toBe(false);
    expect(closed.writes).toEqual([]);

    const blocked = workspace({ blocked: { code: "draft-active", message: "有未提交的草稿" } });
    const result = blocked.session.vectorCommand("shape.create", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/未提交/);
    expect(blocked.writes).toEqual([]);
  });

  it("门禁顺序固定：无文档 → 草稿门禁 → 内核 → afterWrite，任何一步失败都不写", () => {
    const order: string[] = [];
    const context = {
      handle: {
        vectorCommand: () => { order.push("kernel"); return { ok: true, value: {} }; },
      },
      view: {} as never,
      blockingDraft: () => { order.push("draft-gate"); return null; },
      blockingDraftExceptVector: () => { order.push("draft-gate"); return null; },
      vectorToken: () => ({ generation: 0, session: 0 }),
      writesFrozen: () => { order.push("frozen-gate"); return false; },
      unavailable: () => { order.push("unavailable"); return { ok: false, code: "no-document", message: "没有打开的文档" }; },
      fail: (failure: { code: string; message: string }) => { order.push("fail"); return { ok: false as const, ...failure }; },
      afterWrite: () => { order.push("afterWrite"); return { ok: true, value: {} }; },
    } as unknown as WorkspaceFeatureContext;

    createSession(() => context).vectorCommand("shape.create", {});
    // 顺序即事务边界：文档/代际/草稿/冻结门禁都在内核之前，`afterWrite` 只在成功后一次。
    expect(order).toEqual(["draft-gate", "frozen-gate", "kernel", "afterWrite"]);

    order.length = 0;
    createSession(() => ({ ...context, handle: null } as unknown as WorkspaceFeatureContext)).vectorCommand("shape.create", {});
    expect(order).toEqual(["unavailable"]);
  });

  it("冻结窗口内拒绝矢量写入并在内核之前返回（与 dispatch 同一门禁）", () => {
    const { session, writes, revision } = workspace({ frozen: true });
    const result = session.vectorCommand("shape.create", { kind: "rect", rect: [0, 0, 4, 4] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("frozen");
      expect(result.message).toMatch(/导出期间/);
    }
    // 冻结期不调用内核、不推进修订：否则交出的产物与实际修订不符。
    expect(writes).toEqual([]);
    expect(revision()).toBe(0);
    // 只读读取不受冻结影响。
    expect(session.vectorSnapshot().ok).toBe(true);
    expect(session.vectorPresets().ok).toBe(true);
  });

  it("文档代际令牌不符的晚到命令被丢弃，内核不被调用", () => {
    const seen: string[] = [];
    const context = {
      handle: { vectorCommand: (id: string) => { seen.push(id); return { ok: true, value: {} }; } },
      view: {} as never,
      blockingDraft: () => null,
      blockingDraftExceptVector: () => null,
      // 当前文档已换到 generation 2 / 活动索引 1。
      vectorToken: () => ({ generation: 2, session: 1 }),
      writesFrozen: () => false,
      unavailable: () => ({ ok: false as const, code: "no-document", message: "没有打开的文档" }),
      fail: <T,>(failure: { code: string; message: string }) => ({ ok: false as const, ...failure }) as unknown as import("../../editor-wasm.js").EditorResult<T>,
      afterWrite: () => ({ ok: true, value: {} }),
    } as unknown as WorkspaceFeatureContext;
    const session = createSession(() => context);

    // 手势在旧文档上开始时捕获的令牌：会话已重建/已换文档，命令必须被丢弃。
    const stale = session.vectorCommand("shape.create", { kind: "rect" }, { generation: 1, session: 0 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale");
    expect(seen).toEqual([]);

    // 只换活动文档也算失效：同一代际但索引不同不能写进后来活动文档。
    const wrongSession = session.vectorCommand("shape.create", { kind: "rect" }, { generation: 2, session: 0 });
    expect(wrongSession.ok).toBe(false);
    expect(seen).toEqual([]);

    // 令牌一致才真正提交。
    expect(session.vectorCommand("shape.create", { kind: "rect" }, { generation: 2, session: 1 }).ok).toBe(true);
    expect(seen).toEqual(["shape.create"]);
  });

  it("只读读取不经过草稿门禁：有草稿时仍能取快照与预设库", () => {
    const order: string[] = [];
    const context = {
      handle: {
        vectorSnapshot: () => { order.push("snapshot"); return { ok: true, value: {} }; },
        features: { vectors: { vectorPresets: () => { order.push("presets"); return { ok: true, value: {} }; } } },
      },
      view: {} as never,
      blockingDraft: () => { order.push("draft-gate"); return { ok: false as const, code: "draft-active", message: "有未提交的草稿" }; },
      blockingDraftExceptVector: () => { order.push("draft-gate"); return { ok: false as const, code: "draft-active", message: "有未提交的草稿" }; },
      vectorToken: () => ({ generation: 0, session: 0 }),
      writesFrozen: () => false,
      unavailable: () => ({ ok: false as const, code: "no-document", message: "没有打开的文档" }),
      fail: <T,>(failure: { code: string; message: string }) => ({ ok: false as const, ...failure }) as unknown as import("../../editor-wasm.js").EditorResult<T>,
      afterWrite: () => { order.push("afterWrite"); return { ok: true, value: {} }; },
    } as unknown as WorkspaceFeatureContext;
    const session = createSession(() => context);
    expect(session.vectorSnapshot().ok).toBe(true);
    expect(session.vectorPresets().ok).toBe(true);
    // 只看不写：读取不被草稿拦下，也不产生写入。
    expect(order).toEqual(["snapshot", "presets"]);
  });
});
