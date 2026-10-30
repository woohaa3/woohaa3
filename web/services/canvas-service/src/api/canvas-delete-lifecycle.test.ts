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

type LifecycleCalls = {
  calls: string[];
  fail: null | "beginDelete" | "deleteCanvas" | "provider";
  /** 本机是否存在这张画布；`false` 模拟「只在远端」的目录条目。 */
  localExists?: boolean;
  /** 本机权威 revision（与请求里的 expectedRevision=3 对比）。 */
  revision?: number;
  /** 远端删除结果；`undefined` 表示未注入远端删除端口。 */
  remote?: "deleted" | "skipped" | "not-found" | "forbidden" | "unavailable";
};

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
      getCanvas: async () => {
        if (state.localExists === false) {
          throw Object.assign(new Error("画布不存在"), { name: "CanvasStorageError", code: "CANVAS_NOT_FOUND" });
        }
        return { id: "c1", revision: state.revision ?? 3 } as never;
      },
      deleteCanvas: async () => {
        state.calls.push("deleteCanvas");
        if (state.fail === "deleteCanvas") throw new Error("db down");
      }
    } as never,
    authenticate: async () => PRINCIPAL,
    access: { authorize: async () => ({ allowed: true, permission: "delete" }) } as never,
    lifecycle,
    ...(state.remote === undefined
      ? {}
      : {
          deleteRemote: async () => {
            state.calls.push("deleteRemote");
            return state.remote!;
          }
        }),
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

  it("属于远端的画布先删远端，再删本机内容", async () => {
    const state = { calls: [] as string[], fail: null, remote: "deleted" } as LifecycleCalls;
    const { res, captured } = fakeRes();
    await handleDelete(fakeReq(), res, "c1", options(state), log);
    expect(captured.status).toBe(204);
    expect(state.calls).toEqual([
      "deleteRemote",
      "beginDelete",
      "deleteCanvas",
      "closeSessions:c1:canvas-deleted",
      "tombstone"
    ]);
  });

  it("远端删除失败时中止，本机内容保持可重试", async () => {
    const state = { calls: [] as string[], fail: null, remote: "unavailable" } as LifecycleCalls;
    const { res, captured } = fakeRes();
    await handleDelete(fakeReq(), res, "c1", options(state), log);
    expect(captured.status).toBe(503);
    expect(state.calls).toEqual(["deleteRemote"]);
  });

  it("没有删除权时返回 403，不进入本地删除", async () => {
    const state = { calls: [] as string[], fail: null, remote: "forbidden" } as LifecycleCalls;
    const { res, captured } = fakeRes();
    await handleDelete(fakeReq(), res, "c1", options(state), log);
    expect(captured.status).toBe(403);
    expect(state.calls).toEqual(["deleteRemote"]);
  });

  it("只在远端的画布可以删除：不需要本地 revision，删远端后关会话并返回 204", async () => {
    const state = { calls: [] as string[], fail: null, localExists: false, remote: "deleted" } as LifecycleCalls;
    const { res, captured } = fakeRes();
    const req = { method: "DELETE", url: "/api/canvases/remote-only", headers: {} } as unknown as IncomingMessage;
    await handleDelete(req, res, "remote-only", options(state), log);
    expect(captured.status).toBe(204);
    expect(state.calls).toEqual(["deleteRemote", "closeSessions:remote-only:canvas-deleted"]);
  });

  it("只在远端、但远端也没删到（未连接）时返回 404，不假装成功", async () => {
    const state = { calls: [] as string[], fail: null, localExists: false, remote: "skipped" } as LifecycleCalls;
    const { res } = fakeRes();
    const req = { method: "DELETE", url: "/api/canvases/remote-only", headers: {} } as unknown as IncomingMessage;
    await expect(handleDelete(req, res, "remote-only", options(state), log)).rejects.toMatchObject({
      code: "CANVAS_NOT_FOUND"
    });
    expect(state.calls).toEqual(["deleteRemote"]);
  });

  it("本机 revision 不匹配时在远端删除之前拒绝（不留半删状态）", async () => {
    const state = { calls: [] as string[], fail: null, revision: 4, remote: "deleted" } as LifecycleCalls;
    const { res } = fakeRes();
    await expect(handleDelete(fakeReq(), res, "c1", options(state), log)).rejects.toMatchObject({
      code: "REVISION_CONFLICT"
    });
    expect(state.calls).toEqual([]);
  });
});
