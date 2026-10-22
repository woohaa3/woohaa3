/**
 * Canvas 创建的生命周期与崩溃恢复（change: 2026-10-13-...，任务 11.2 / D1）。
 *
 * 覆盖：reserve（provisioning 不公开）→ 建内容 → finalize → 201；内容创建失败 tombstone；
 * 同一 operation 续作（`resumed`）时复用已有内容补齐 finalize——不创建第二份内容、不公开无主内容。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { PrincipalContext } from "@woohaa3/contracts";
import { handleCreate } from "./canvas-api/lifecycle-routes.js";
import type { CanvasRequestHandlerOptions } from "./canvas-api/types.js";
import type { CanvasLifecyclePort } from "../access/resolve-access.js";

const PRINCIPAL: PrincipalContext = { subject: "u1", identityProvider: "test" };

type Captured = { status: number; body: unknown };
type Calls = { calls: string[]; resumed: boolean; canvasExists: boolean; createFails: boolean };

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

function fakeReq(body: Record<string, unknown> = {}): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return {
    method: "POST",
    url: "/api/canvases",
    headers: {},
    on: (event: string, handler: (chunk?: unknown) => void) => {
      if (event === "data") handler(payload);
      if (event === "end") handler();
      return undefined as never;
    }
  } as unknown as IncomingMessage;
}

function fakeLifecycle(state: Calls): CanvasLifecyclePort {
  return {
    reserve: async () => {
      state.calls.push("reserve");
      return state.resumed ? { ok: true, resumed: true } : { ok: true };
    },
    finalize: async () => {
      state.calls.push("finalize");
      return { ok: true };
    },
    tombstone: async () => {
      state.calls.push("tombstone");
      return { ok: true };
    },
    beginDelete: async () => ({ ok: true }),
    cancelReservation: async () => {
      state.calls.push("cancelReservation");
      return { ok: true };
    }
  } as CanvasLifecyclePort;
}

function options(state: Calls): CanvasRequestHandlerOptions {
  const canvas = { id: "c1", revision: 7, updatedAt: "t1" };
  return {
    service: {
      createCanvas: async () => {
        state.calls.push("createCanvas");
        if (state.createFails) throw new Error("db down");
        return canvas;
      },
      getCanvas: async (canvasId: string) => {
        state.calls.push(`getCanvas:${canvasId}`);
        if (!state.canvasExists) throw Object.assign(new Error("不存在"), { code: "CANVAS_NOT_FOUND" });
        return canvas;
      }
    } as never,
    authenticate: async () => PRINCIPAL,
    access: { authorize: async () => ({ allowed: true, permission: "write" }) } as never,
    lifecycle: fakeLifecycle(state)
  } as CanvasRequestHandlerOptions;
}

const log = () => undefined;

describe("handleCreate 生命周期与崩溃恢复（任务 11.2 / D1）", () => {
  it("常规创建：reserve → createCanvas → finalize → 201", async () => {
    const state: Calls = { calls: [], resumed: false, canvasExists: false, createFails: false };
    const { res, captured } = fakeRes();
    await handleCreate(fakeReq({ canvasId: "c1", title: "画布" }), res, options(state), log);
    expect(captured.status).toBe(201);
    expect(state.calls).toEqual(["reserve", "createCanvas", "finalize"]);
  });

  it("resume（上次已建内容）：复用已有画布并补 finalize，不创建第二份内容", async () => {
    const state: Calls = { calls: [], resumed: true, canvasExists: true, createFails: false };
    const { res, captured } = fakeRes();
    await handleCreate(fakeReq({ canvasId: "c1", operationId: "op1" }), res, options(state), log);
    expect(captured.status).toBe(201);
    expect(state.calls).toEqual(["reserve", "getCanvas:c1", "finalize"]);
    expect(captured.body).toMatchObject({ revision: 7 });
  });

  it("resume（内容其实没建成）：改走创建，仍完成 finalize", async () => {
    const state: Calls = { calls: [], resumed: true, canvasExists: false, createFails: false };
    const { res, captured } = fakeRes();
    await handleCreate(fakeReq({ canvasId: "c1", operationId: "op1" }), res, options(state), log);
    expect(captured.status).toBe(201);
    expect(state.calls).toEqual(["reserve", "getCanvas:c1", "createCanvas", "finalize"]);
  });

  it("resume 时非「画布不存在」的读取故障不吞掉：保留预留、不重复创建、不 tombstone", async () => {
    const state: Calls = { calls: [], resumed: true, canvasExists: false, createFails: false };
    const opts = options(state);
    (opts.service as { getCanvas: unknown }).getCanvas = async () => {
      state.calls.push("getCanvas:c1");
      throw Object.assign(new Error("数据库不可用"), { code: "STORAGE_UNAVAILABLE" });
    };
    const { res } = fakeRes();
    await expect(handleCreate(fakeReq({ canvasId: "c1", operationId: "op1" }), res, opts, log)).rejects.toThrow();
    // 探测失败两次（resume 读取 + 补偿探测）后原样抛错；没有 finalize/cancel/tombstone。
    expect(state.calls).toEqual(["reserve", "getCanvas:c1", "getCanvas:c1"]);
  });

  it("内容创建失败且内容未落库：释放预留（可换 operation 重试）并透传错误", async () => {
    const state: Calls = { calls: [], resumed: false, canvasExists: false, createFails: true };
    const { res } = fakeRes();
    await expect(handleCreate(fakeReq({ canvasId: "c1" }), res, options(state), log)).rejects.toThrow("db down");
    expect(state.calls).toEqual(["reserve", "createCanvas", "getCanvas:c1", "cancelReservation"]);
  });

  it("内容创建报错但内容已落库：按同一 receipt 补齐 finalize 并返回 201", async () => {
    const state: Calls = { calls: [], resumed: false, canvasExists: true, createFails: true };
    const { res, captured } = fakeRes();
    await handleCreate(fakeReq({ canvasId: "c1" }), res, options(state), log);
    expect(captured.status).toBe(201);
    expect(state.calls).toEqual(["reserve", "createCanvas", "getCanvas:c1", "finalize"]);
    expect(captured.body).toMatchObject({ revision: 7 });
  });
});
