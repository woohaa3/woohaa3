/**
 * 文字域会话门禁回归（change: 2026-10-22-add-photocraft-typography-workflows）。
 *
 * 面板不直接碰内核：写命令必须先过共享草稿门禁，成功后统一发布修订；查询不发布也不改内容。
 * 这里用替身上下文验证这三条边界，不启动 WASM。
 */
import { expect, it, vi } from "vitest";
import { createSession } from "./workspace.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorViewModel } from "../../editor-view-model.js";

const view = { hasDocument: true, document: { revision: 4 }, sessionActiveIndex: null } as unknown as EditorViewModel;

function setup(options: { blocked?: boolean; failure?: boolean } = {}) {
  const calls: { command: string; params: unknown }[] = [];
  const queries: { query: string; params: unknown }[] = [];
  const handle = {
    features: {
      type: {
        typeCommand: vi.fn((id: string, params: unknown) => {
          calls.push({ command: id, params });
          return options.failure ? { ok: false as const, code: "command-failed", message: "内核拒绝" } : { ok: true as const, value: { changed: true } };
        }),
        typeQuery: vi.fn((id: string, params: unknown) => {
          queries.push({ query: id, params });
          return { ok: true as const, value: { runs: [] } };
        })
      }
    }
  };
  const afterWrite = vi.fn(() => ({ ok: true as const, value: view }));
  const fail = vi.fn((failure: { message: string }) => ({ ok: false as const, code: "failed", message: failure.message }));
  const context = {
    handle,
    view,
    blockingDraft: () =>
      options.blocked ? { ok: false as const, code: "text-active", message: "请先完成文字编辑" } : null,
    unavailable: () => ({ ok: false as const, code: "no-document", message: "编辑器尚未就绪" }),
    fail,
    afterWrite
  } as unknown as WorkspaceFeatureContext;
  return { session: createSession(() => context), handle, calls, queries, afterWrite, fail };
}

it("写命令先过草稿门禁，成功后统一发布修订", () => {
  const { session, calls, afterWrite } = setup();
  const result = session.typeCommand("type.warpText", { layer: 1, style: "arc" });
  expect(result.ok).toBe(true);
  expect(calls).toEqual([{ command: "type.warpText", params: { layer: 1, style: "arc" } }]);
  expect(afterWrite).toHaveBeenCalledOnce();
});

it("文字草稿未结束时拒绝写入，不调用内核也不发布", () => {
  const { session, calls, afterWrite } = setup({ blocked: true });
  const result = session.typeCommand("type.antiAlias.crisp", { layer: 1 });
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.code).toBe("text-active");
  expect(calls).toEqual([]);
  expect(afterWrite).not.toHaveBeenCalled();
});

it("内核拒绝时把失败原样交给调用方，不发布修订", () => {
  const { session, afterWrite } = setup({ failure: true });
  const result = session.typeCommand("type.convertToShape", { layer: 9 });
  expect(result.ok).toBe(false);
  expect(afterWrite).not.toHaveBeenCalled();
});

it("查询不经过草稿门禁，也不发布修订", () => {
  const { session, queries, afterWrite } = setup({ blocked: true });
  const result = session.typeQuery("type.info", { layer: 2 });
  expect(result.ok).toBe(true);
  expect(queries).toEqual([{ query: "type.info", params: { layer: 2 } }]);
  expect(afterWrite).not.toHaveBeenCalled();
});

it("没有内核时写命令与查询都回报未就绪", () => {
  const session = createSession(() => ({
    handle: null,
    view,
    unavailable: () => ({ ok: false as const, code: "no-document", message: "编辑器尚未就绪" })
  } as unknown as WorkspaceFeatureContext));
  expect(session.typeCommand("type.info", {}).ok).toBe(false);
  expect(session.typeQuery("type.info", {}).ok).toBe(false);
});
