import { decodeCanvasWorkspaceHandle } from "@woohaa3/contracts";
import type { CanvasWorkspaces } from "./canvas-workspaces.js";

const invalid = (): never => { throw Object.assign(new Error("工作目录请求格式无效"), { code: "workspace-forbidden" }); };
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 32768): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > limit) return invalid();
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) return invalid();
  return value as number;
}

/** The socket is authenticated, but malformed handles must still never reach path resolution. */
export function workspaceRpc(service: CanvasWorkspaces, method: string, value: unknown): unknown {
  if (method === "workspace.settings" || method === "workspace.leases") {
    object(value ?? {}, []);
    return method === "workspace.settings" ? service.settings() : service.leases();
  }
  if (["workspace.acquire", "workspace.lookup", "workspace.settle", "workspace.location", "workspace.clean"].includes(method)) {
    const p = object(value, ["owner", "canvasId", ...(["workspace.location", "workspace.clean"].includes(method) ? [] : ["requestId"]), ...(method === "workspace.settle" ? ["outcome"] : [])]);
    const canvas = { owner: text(p.owner, 512), canvasId: text(p.canvasId, 512) };
    if (method === "workspace.location") return service.location(canvas);
    if (method === "workspace.clean") return service.clean(canvas);
    const identity = { ...canvas, requestId: text(p.requestId, 512) };
    if (method === "workspace.acquire") return service.acquire(identity);
    if (method === "workspace.lookup") return service.lookup(identity);
    if (!["active", "terminal", "unknown", "cancelled"].includes(String(p.outcome))) return invalid();
    return service.settle({ ...identity, outcome: p.outcome as "active" | "terminal" | "unknown" | "cancelled" });
  }
  if (method === "workspace.migrate") {
    const p = object(value, ["operationId", "targetPath", "expectedRootRevision"]);
    return service.migrate({ operationId: text(p.operationId, 256), targetPath: text(p.targetPath), expectedRootRevision: integer(p.expectedRootRevision, 1) });
  }
  if (method === "workspace.cancelMigration") return service.cancelMigration(text(object(value, ["operationId"]).operationId, 256));
  const p = object(value, ["handle", ...({
    "workspace.release": ["outcome"], "workspace.list": ["path"], "workspace.assetBytes": ["path"],
    "workspace.read": ["path"], "workspace.mkdir": ["path"], "workspace.write": ["input"],
    "workspace.execute": ["input"], "workspace.query": ["input"], "workspace.stop": ["executionId"]
  }[method] ?? [])]);
  const handle = decodeCanvasWorkspaceHandle(p.handle);
  if (!handle) return invalid();
  switch (method) {
    case "workspace.release":
      if (p.outcome !== "terminal" && p.outcome !== "unknown") return invalid();
      return service.release(handle, p.outcome);
    case "workspace.cancel": return service.cancel(handle);
    case "workspace.list": return service.list(handle, p.path === undefined ? undefined : text(p.path));
    case "workspace.assetBytes": return service.assetBytes(handle, text(p.path));
    case "workspace.read": return service.read(handle, text(p.path));
    case "workspace.mkdir": return service.mkdir(handle, text(p.path));
    case "workspace.write": {
      const input = object(p.input, ["path", "content", "expectedHash"]);
      if (typeof input.content !== "string" || (input.expectedHash !== undefined && input.expectedHash !== null && (typeof input.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedHash)))) return invalid();
      return service.write(handle, { path: text(input.path), content: input.content, ...(input.expectedHash !== undefined ? { expectedHash: input.expectedHash as string | null } : {}) });
    }
    case "workspace.execute": {
      const input = object(p.input, ["operationId", "command", "args", "cwd", "shell"]);
      if ((input.args !== undefined && (!Array.isArray(input.args) || input.args.some(a => typeof a !== "string" || a.includes("\0")))) || (input.shell !== undefined && typeof input.shell !== "boolean")) return invalid();
      return service.execute(handle, { operationId: text(input.operationId, 256), command: text(input.command), ...(input.args !== undefined ? { args: input.args as string[] } : {}), ...(input.cwd !== undefined ? { cwd: text(input.cwd) } : {}), ...(input.shell !== undefined ? { shell: input.shell as boolean } : {}) });
    }
    case "workspace.query": {
      const input = object(p.input, ["executionId", "after"]);
      return service.query(handle, { executionId: text(input.executionId, 64), ...(input.after !== undefined ? { after: integer(input.after, 0) } : {}) });
    }
    case "workspace.stop": return service.stop(handle, text(p.executionId, 64));
    default: return invalid();
  }
}
