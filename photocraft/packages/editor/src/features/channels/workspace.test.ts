/**
 * 通道域会话门禁回归（change: 2026-10-22-add-photocraft-channel-workflows，U25/U26）。
 *
 * 只验证本域端口的门禁与结果归属：通道命令走草稿门禁、预览不改正式文档、
 * 失败不刷新工作区。真实命令语义在 `rust/crates/editor-core/src/features/channels/tests.rs`。
 */
import { expect, it, vi } from "vitest";
import type { EditorHandle } from "../../editor-wasm.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import { createSession } from "./workspace.js";

function context(handle: unknown, overrides: Partial<WorkspaceFeatureContext> = {}) {
  const afterWrite = vi.fn(() => ({ ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: 0 } }));
  const fail = vi.fn((failure) => failure);
  const base: WorkspaceFeatureContext = {
    owner: { documentId: null, generation: 0 },
    saving: false,
    frozen: () => null,
    documentGeneration: () => 0,
    blockingDraftExceptVector: () => null,
    writesFrozen: () => false,
    vectorToken: () => ({ generation: 0, session: null }),

    handle: handle as EditorHandle,
    view: { hasDocument: true, document: null, sessionActiveIndex: 0 },
    selectionModifyActive: false,
    retouchActive: false,
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => false,
    blockingDraft: () => null,
    unavailable: () => ({ ok: false, code: "no-document", message: "编辑器尚未加载" }),
    fail,
    afterWrite,
    ...overrides
  };
  return { session: createSession(() => base), afterWrite, fail };
}

function fakeHandle(channels: Record<string, unknown>): unknown {
  return { features: { channels } };
}

const PREVIEW = { ok: true as const, value: { width: 2, height: 1, pixels: new Uint8Array(8) } };

it("没有内核句柄时读取与写入都返回不可用，不调用任何端口", () => {
  const { session, afterWrite } = context(null);
  expect(session.channelSnapshot()).toEqual({ ok: false, code: "no-document", message: "编辑器尚未加载" });
  expect(session.channelThumbnail({ alpha: 0 }, 16)).toMatchObject({ ok: false, code: "no-document" });
  expect(session.channelViewPreview(32)).toMatchObject({ ok: false, code: "no-document" });
  expect(session.previewChannelCommand("image.applyImage", {}, 32)).toMatchObject({ ok: false, code: "no-document" });
  expect(session.channelCommand("channel.new", {})).toMatchObject({ ok: false, code: "no-document" });
  expect(afterWrite).not.toHaveBeenCalled();
});

it("通道写入服从草稿门禁：有草稿时不落命令、不刷新", () => {
  const channels = { channelCommand: vi.fn(), channelCalcPreview: vi.fn(), channelCalcPreviewSummary: vi.fn() };
  const blocked = { ok: false as const, code: "gesture-active", message: "请先结算当前草稿" };
  const { session, afterWrite, fail } = context(fakeHandle(channels), { hasActiveDraft: () => true, blockingDraft: () => blocked });
  expect(session.channelCommand("channel.new", {})).toEqual(blocked);
  expect(session.previewChannelCommand("image.applyImage", {}, 32)).toEqual(blocked);
  expect(channels.channelCommand).not.toHaveBeenCalled();
  expect(channels.channelCalcPreview).not.toHaveBeenCalled();
  expect(afterWrite).not.toHaveBeenCalled();
  expect(fail).not.toHaveBeenCalled();
});

it("预览只读：不写命令、不刷新工作区；确认才重跑命令并刷新一次", () => {
  const params = { source: { channel: { color: 0 } }, blending: "normal", opacity: 80 };
  const summary = { revisionChanged: true, channels: { alpha: [] }, documents: 1 };
  const channels = {
    channelCalcPreview: vi.fn(() => PREVIEW),
    channelCalcPreviewSummary: vi.fn(() => ({ ok: true, value: summary })),
    channelCommand: vi.fn(() => ({ ok: true, value: null }))
  };
  const { session, afterWrite } = context(fakeHandle(channels));
  expect(session.previewChannelCommand("image.applyImage", params, 192)).toEqual({ ok: true, value: { preview: PREVIEW.value, summary } });
  expect(channels.channelCalcPreview).toHaveBeenCalledWith("image.applyImage", params, 192);
  expect(channels.channelCommand).not.toHaveBeenCalled();
  expect(afterWrite).not.toHaveBeenCalled();
  // 确认用当前参数重跑同一条命令，并且只刷新一次。
  expect(session.channelCommand("image.applyImage", params)).toMatchObject({ ok: true });
  expect(channels.channelCommand).toHaveBeenCalledWith("image.applyImage", params);
  expect(afterWrite).toHaveBeenCalledOnce();
});

it("非法参数只回给面板，不把工作区标成失败", () => {
  const failure = { ok: false as const, code: "command-failed", message: "unsupported blending `dissolve`" };
  const channels = { channelCalcPreview: vi.fn(() => failure), channelCalcPreviewSummary: vi.fn(), channelCommand: vi.fn() };
  const { session, fail, afterWrite } = context(fakeHandle(channels));
  expect(session.previewChannelCommand("image.applyImage", { blending: "dissolve" }, 192)).toEqual(failure);
  expect(channels.channelCalcPreviewSummary).not.toHaveBeenCalled();
  expect(fail).not.toHaveBeenCalled();
  expect(afterWrite).not.toHaveBeenCalled();
});

it("确认失败走统一失败出口且不刷新视图", () => {
  const failure = { ok: false as const, code: "command-failed", message: "目标通道不存在" };
  const { session, fail, afterWrite } = context(fakeHandle({ channelCommand: vi.fn(() => failure) }));
  expect(session.channelCommand("image.applyImage", { target: { channel: 9 } })).toEqual(failure);
  expect(fail).toHaveBeenCalledWith(failure);
  expect(afterWrite).not.toHaveBeenCalled();
});

it("读取端口直接返回内核结果（快照、缩略图、通道视图）", () => {
  const snapshot = { composite: "RGB", alpha: [], colors: [], target: { kind: "composite" }, documents: [], documentId: 1, revision: 2 };
  const thumbnail = { ok: true as const, value: { width: 1, height: 1, pixels: new Uint8Array(4) } };
  const channels = {
    channelSnapshot: vi.fn(() => ({ ok: true, value: snapshot })),
    channelThumbnail: vi.fn(() => thumbnail),
    channelViewPreview: vi.fn(() => thumbnail)
  };
  const { session, afterWrite } = context(fakeHandle(channels));
  expect(session.channelSnapshot()).toEqual({ ok: true, value: snapshot });
  expect(session.channelThumbnail({ color: 1 }, 28)).toEqual(thumbnail);
  expect(session.channelViewPreview(192)).toEqual(thumbnail);
  expect(channels.channelThumbnail).toHaveBeenCalledWith({ color: 1 }, 28);
  expect(afterWrite).not.toHaveBeenCalled();
});
