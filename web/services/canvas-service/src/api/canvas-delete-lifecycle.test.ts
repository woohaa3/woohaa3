/**
 * Canvas 原生删除的生命周期与撤权（change: 2026-10-13-...，任务 5.2）。
 *
 * 覆盖：先进入 `deleting` 中间态 → 删权威内容 → 断开实时会话 → 保存 tombstone；
 * 删除失败时复原为 active（可恢复）；生命周期提供者故障时不半删。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { PrincipalContext } from "@woohaa3/contracts";
import { handleDelete } from "./canvas-api/lifecycle-routes.js";
import type { CanvasRequestHandlerOptions } from "./canvas-api/types.js";
import type { CanvasLifecyclePort } from "../access/resolve-access.js";

const PRINCIPAL: PrincipalContext = { subject: "u1", identityProvider: "test" };

type Captured = { status: number; body: unknown };

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    setHeader: () => undefined,
    end: (payload?: string) => {
      captured.body = payload ? JSON.parse(payload) : undefined;
    },
    get statusCode() {
      return captured.status;
    },
    set statusCode(value: number) {
      captured.status = value;
    }
  } as unknown as ServerResponse;
  return { res, captured };
}

function fakeReq(): IncomingMessage {
  return { method: "DELETE", url: "/api/canvases/c1?expectedRevision=3", headers: {} } as unknown as IncomingMessage;
}

type LifecycleCalls = { calls: string[]; fail: null | "beginDelete" | "deleteCanvas" | "provider" };

function fakeLifecycle(state: LifecycleCalls): CanvasLifecyclePort {
  return {
    reserve: async () => ({ ok: true }),
    finalize: async () => {
      state.calls.push("finalize");
      return { ok: true };
    },
    tombstone: async () => {
      state.calls.push("tombstone");
      return { ok: true };
    },
    beginDelete: async () => {
      state.calls.push("beginDelete");
      if (state.fail === "provider") return { ok: false, code: "provider-unavailable", message: "provider 故障" };
      return { ok: true };
    }
  } as CanvasLifecyclePort;
}

function options(state: LifecycleCalls, extra: { beginUnsupported?: boolean } = {}): CanvasRequestHandlerOptions {
  const lifecycle = fakeLifecycle(state);
  if (extra.beginUnsupported) {
    (lifecycle as { beginDelete: unknown }).beginDelete = async () => {
      state.calls.push("beginDelete");
      return { ok: false, code: "unsupported", message: "不支持" };
    };
  }
  return {
    service: {
      deleteCanvas: async () => {
        state.calls.push("deleteCanvas");
        if (state.fail === "deleteCanvas") throw new Error("db down");
      }
    } as never,
    authenticate: async () => PRINCIPAL,
    access: { authorize: async () => ({ allowed: true, permission: "delete" }) } as never,
    lifecycle,
    closeSessions: (canvasId: string, reason: string) => { state.calls.push(`closeSessions:${canvasId}:${reason}`); }
  } as CanvasRequestHandlerOptions;
}

const log = () => undefined;

describe("handleDelete 生命周期与撤权（任务 5.2）", () => {
  it("顺序为 beginDelete → deleteCanvas → closeSessions → tombstone，并返回 204", async () => {
    const state = { calls: [] as string[], fail: null } as LifecycleCalls;
    const { res, captured } = fakeRes();
    await handleDelete(fakeReq(), res, "c1", options(state), log);
    expect(captured.status).toBe(204);
    expect(state.calls).toEqual(["beginDelete", "deleteCanvas", "closeSessions:c1:canvas-deleted", "tombstone"]);
  });

  it("权威删除失败时复原为 active（finalize），不 tombstone、不关会话", async () => {
    const state = { calls: [] as string[], fail: "deleteCanvas" } as LifecycleCalls;
    const { res } = fakeRes();
    await expect(handleDelete(fakeReq(), res, "c1", options(state), log)).rejects.toThrow();
    expect(state.calls).toEqual(["beginDelete", "deleteCanvas", "finalize"]);
  });

  it("生命周期 provider 故障时返回 503 且不删权威内容", async () => {
    const state = { calls: [] as string[], fail: "provider" } as LifecycleCalls;
    const { res, captured } = fakeRes();
    await handleDelete(fakeReq(), res, "c1", options(state), log);
    expect(captured.status).toBe(503);
    expect(state.calls).toEqual(["beginDelete"]);
  });

  it("provider 不支持 deleting 中间态时按旧路径继续删除", async () => {
    const state = { calls: [] as string[], fail: null } as LifecycleCalls;
    const { res, captured } = fakeRes();
    await handleDelete(fakeReq(), res, "c1", options(state, { beginUnsupported: true }), log);
    expect(captured.status).toBe(204);
    expect(state.calls).toEqual(["beginDelete", "deleteCanvas", "closeSessions:c1:canvas-deleted", "tombstone"]);
  });
});
