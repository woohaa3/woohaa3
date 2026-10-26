import { createHash } from "node:crypto";
import type { CanvasService } from "@woohaa3/canvas-service";
import type {
  ApplicationExtensionOwnedCanvases, ExtensionDocumentStore, PrincipalContext,
  ResourceLifecyclePolicy, ExtensionCanvasCommitInput
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const codeOf = (error: unknown) => (error as { code?: string })?.code ?? "unavailable";

type Ownership = { extensionId: string; principalId: string; title: string; phase: "creating" | "active" };
export type ExtensionCanvasAuthority = {
  /** Called on every operation; deployment can revoke this authority without a browser session. */
  principal(): Promise<PrincipalContext | null>;
  authorize(principal: PrincipalContext, canvasId: string, permission: "read" | "write"): Promise<void>;
  lifecycle?: () => ResourceLifecyclePolicy | null;
};

/** No extension receives the registry store or gets to supply an acting principal. */
export function createExtensionOwnedCanvases(options: {
  canvas: CanvasService;
  registry: ExtensionDocumentStore;
  extensionId: string;
  authority: ExtensionCanvasAuthority;
}): ApplicationExtensionOwnedCanvases {
  const { canvas, registry, extensionId, authority } = options;
  const storage = () => canvas.composition?.service ?? failure("unavailable", "画布存储不可用");
  const keyOf = (id: string) => `canvas:${hash(id)}`;
  const validId = (id: string) => {
    if (typeof id !== "string" || !id.trim() || id.length > 256) failure("invalid-id", "画布标识非法");
  };
  const principal = async () => {
    const p = await authority.principal();
    return p ?? failure("unauthorized", "宿主未授予扩展后台身份");
  };
  const owned = async (id: string, p: PrincipalContext) => {
    validId(id);
    const record = await registry.get<Ownership>(keyOf(id));
    if (!record.found || record.document.value.extensionId !== extensionId || record.document.value.principalId !== p.subject) {
      return failure("ownership-conflict", "画布不属于当前扩展或后台主体");
    }
    return record.document;
  };
  const withRoom = async <T>(id: string, run: (room: import("@woohaa3/canvas-service").CanvasRoom) => Promise<T>): Promise<T> => {
    const registry = canvas.sync?.registry ?? failure("unavailable", "画布同步权威不可用");
    const lease = await registry.acquire(id);
    try { return await run(lease.room); } finally { lease.release(); }
  };
  const check = async (id: string, permission: "read" | "write") => {
    const p = await principal();
    const record = await owned(id, p);
    if (record.value.phase !== "active") failure("not-ready", "画布创建尚未完成");
    await authority.authorize(p, id, permission);
    return p;
  };
  const read = async ({ canvasId }: { canvasId: string }) => {
    await check(canvasId, "read");
    return withRoom(canvasId, async room => {
      await check(canvasId, "read");
      const result = room.exportCanvas();
      return result.ok ? result.canvas : failure("unavailable", result.message);
    });
  };
  return {
    async ensure({ canvasId, title }) {
      validId(canvasId);
      if (typeof title !== "string" || !title.trim() || title.length > 120) failure("invalid-title", "画布标题非法");
      const p = await principal();
      let record = await registry.get<Ownership>(keyOf(canvasId));
      if (!record.found) {
        try {
          await storage().getCanvas(canvasId);
          failure("ownership-conflict", "指定 ID 已被既有画布占用");
        } catch (error) { if (codeOf(error) !== "CANVAS_NOT_FOUND") throw error; }
        const claim = await registry.batch([{ op: "set", key: keyOf(canvasId), expectedRevision: null,
          value: { extensionId, principalId: p.subject, title, phase: "creating" } }]);
        if (!claim.ok && claim.code !== "revision-conflict") failure("unavailable", "无法登记画布所有权");
        record = await registry.get<Ownership>(keyOf(canvasId));
      }
      const current = await owned(canvasId, p);
      if (current.value.phase === "creating") {
        const operationId = `extension-canvas:${hash([extensionId, canvasId])}`;
        const lifecycle = authority.lifecycle?.();
        const input = { principal: p, resource: { kind: "canvas" as const, id: canvasId }, operationId };
        if (lifecycle) {
          const reserved = await lifecycle.reserve(input);
          if (!reserved.ok) failure(reserved.code, reserved.message);
        }
        // Replaying the same storage operation proves provenance after a creation crash.
        // An unrelated canvas that raced with our claim is rejected by the repository.
        await storage().createCanvas({ canvasId, title: current.value.title, operationId });
        if (lifecycle) {
          const finalized = await lifecycle.finalize(input);
          if (!finalized.ok) failure(finalized.code, finalized.message);
        }
        const activated = await registry.batch([{ op: "set", key: keyOf(canvasId), expectedRevision: current.revision,
          value: { ...current.value, phase: "active" } }]);
        if (!activated.ok) {
          const latest = await owned(canvasId, p);
          if (latest.value.phase !== "active") failure("revision-conflict", "画布登记被并发修改");
        }
      }
      const snapshot = await read({ canvasId });
      return { canvasId, revision: snapshot.revision };
    },
    read,
    async commit(input: ExtensionCanvasCommitInput) {
      const { canvasId, requestId, expectedRevision, commands } = input;
      if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 256 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(commands) || commands.length > 100) {
        return { ok: false, code: "invalid-request", message: "提交身份、版本或命令数量非法" };
      }
      await check(canvasId, "write");
      const requestKey = `request:${hash([extensionId, canvasId, requestId])}`;
      const payloadHash = hash({ canvasId, expectedRevision, commands });
      const stored = await registry.batch([{ op: "set", key: requestKey, expectedRevision: null, value: { payloadHash } }]);
      if (!stored.ok) {
        if (stored.code !== "revision-conflict") failure("unavailable", "无法保存请求身份");
        const previous = await registry.get<{ payloadHash: string }>(requestKey);
        if (!previous.found || previous.document.value.payloadHash !== payloadHash) return { ok: false, code: "request-id-reused", message: "同一请求身份使用了不同输入" };
      }
      return withRoom(canvasId, async room => {
        const commandId = `extension-canvas:${hash([extensionId, canvasId, requestId])}`;
        const result = await room.submitDerived({ commandId, derive: async snapshot => {
          if (snapshot.revision !== expectedRevision) return { ok: false, code: "revision-conflict", message: "画布版本已变化" };
          const p = await check(canvasId, "write");
          return { ok: true, batch: { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId, baseRevision: snapshot.revision,
            actorId: p.subject, commandId, commands } };
        } }, { authorize: async () => { try { await check(canvasId, "write"); return true; } catch { return false; } } });
        return result.ok ? { ok: true, status: result.duplicate ? "duplicate" : "committed", revision: result.revision } : { ok: false, code: result.code, message: result.message };
      });
    }
  };
}
