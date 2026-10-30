import { describe, expect, it, vi } from "vitest";
import type { CanvasContentRuntime, ContentConversionServiceDeps, FilmSetConversionRecord } from "@woohaa3/contracts";
import type { CanvasServiceOptions } from "@woohaa3/canvas-service";
import { createCanvasService as composeCanvas } from "../../../../services/canvas-service/src/composition.js";
import { InMemoryCanvasRepository } from "../../../../services/canvas-service/src/storage/core/in-memory-repository.js";
import { InMemoryYjsDocumentRepository } from "../../../../services/canvas-service/src/sync/in-memory-yjs-repository.js";
import type { HostContext } from "../context.js";
import { canvasPlugin } from "./canvas.js";

const { createCanvasService } = vi.hoisted(() => ({ createCanvasService: vi.fn() }));
vi.mock("@woohaa3/canvas-service", () => ({ createCanvasService }));

// Capture the real host assembly, then run its options through the real Canvas composition.
async function assemble(enabled: boolean, policyPresent: boolean) {
  createCanvasService.mockResolvedValue({ close: vi.fn() });
  let allowed = true;
  const authorize = vi.fn(async () => ({ allowed }));
  const runtime = { enabled };
  const ctx = {
    access: {
      runtime,
      authenticator: vi.fn(),
      providers: {
        resourceAccessPolicy: () => policyPresent ? { authorize } : null,
        resourceLifecyclePolicy: () => null,
        resourceDirectory: () => null
      }
    },
    media: { port: () => ({}) },
    task: { port: () => ({}) },
    log: { scope: () => vi.fn() },
    get: () => undefined,
    effect: vi.fn(), provide: vi.fn(), on: vi.fn()
  } as unknown as HostContext;
  await canvasPlugin.apply(ctx, { env: {} });
  const options = createCanvasService.mock.lastCall![0] as CanvasServiceOptions;
  let deps: ContentConversionServiceDeps | undefined;
  const contentRuntime = {
    conversion: {
      createInMemoryRegistry: () => ({}),
      createService: (input: ContentConversionServiceDeps) => { deps = input; return {}; }
    }
  } as unknown as CanvasContentRuntime;
  const service = await composeCanvas({
    ...options,
    repository: new InMemoryCanvasRepository(),
    yjsRepository: new InMemoryYjsDocumentRepository(),
    contentRuntime,
    enableNodeHistory: false,
    logger: undefined
  });
  expect(deps?.authorize).toBeTypeOf("function");
  return { service, check: deps!.authorize!, options, authorize, revoke: () => { allowed = false; } };
}

const record = { canvasId: "canvas-1", subject: "owner" } as FilmSetConversionRecord;

describe("host Canvas background conversion authorization", () => {
  it("explicit local mode reaches the background conversion without requiring an ACL", async () => {
    const app = await assemble(false, false);
    try {
      expect(app.options.accessRuntime?.enabled).toBe(false);
      expect(await app.check(record)).toBe(true);
      expect(app.authorize).not.toHaveBeenCalled();
    } finally { await app.service.close(); }
  });

  it("managed mode rechecks write permission and rejects revocation", async () => {
    const app = await assemble(true, true);
    try {
      expect(await app.check(record)).toBe(true);
      app.revoke();
      expect(await app.check(record)).toBe(false);
      expect(await app.check({ ...record, subject: undefined })).toBe(false);
      expect(app.authorize).toHaveBeenLastCalledWith(expect.objectContaining({ permission: "write", principal: expect.objectContaining({ subject: "owner" }) }));
    } finally { await app.service.close(); }
  });

  it("missing policy in managed mode does not become a local permission bypass", async () => {
    const app = await assemble(true, false);
    try { expect(await app.check(record)).toBe(false); }
    finally { await app.service.close(); }
  });
});

// 远端删除端口：宿主只按声明扫描 `canvas-upstream:*` capability，不认识具体扩展。
async function deleteRemoteWith(providers: Record<string, unknown>) {
  createCanvasService.mockResolvedValue({ close: vi.fn() });
  const host = {
    snapshot: () =>
      Object.keys(providers).map((capability) => ({
        extensionId: "ext",
        capabilities: [capability],
        handlers: [],
        httpHandlers: [],
        resources: []
      })),
    resolveCapability: (capability: string) => providers[capability]
  };
  const ctx = {
    access: {
      runtime: { enabled: false },
      authenticator: vi.fn(),
      providers: { resourceAccessPolicy: () => null, resourceLifecyclePolicy: () => null, resourceDirectory: () => null }
    },
    media: { port: () => ({}) },
    task: { port: () => ({}) },
    log: { scope: () => vi.fn() },
    get: (key: string) => key === "application" ? { service: { host: () => host } } : undefined,
    effect: vi.fn(), provide: vi.fn(), on: vi.fn()
  } as unknown as HostContext;
  await canvasPlugin.apply(ctx, { env: {} });
  const options = createCanvasService.mock.lastCall![0] as CanvasServiceOptions;
  expect(options.deleteRemote).toBeTypeOf("function");
  return options.deleteRemote!;
}

describe("host Canvas remote deletion", () => {
  it("hands an upstream canvas to the provider and reports its answer", async () => {
    const deleteCanvas = vi.fn(async () => "deleted" as const);
    const provider = { providerId: "remote", resolve: async () => null, deleteCanvas };
    const deleteRemote = await deleteRemoteWith({ "canvas-upstream:remote": provider });
    expect(await deleteRemote("canvas-1")).toBe("deleted");
    expect(deleteCanvas).toHaveBeenCalledWith("canvas-1");
  });

  it("treats a throwing provider as unavailable so the local copy is not deleted alone", async () => {
    const provider = {
      providerId: "remote",
      resolve: async () => null,
      deleteCanvas: async () => { throw new Error("boom"); }
    };
    const deleteRemote = await deleteRemoteWith({ "canvas-upstream:remote": provider });
    expect(await deleteRemote("canvas-1")).toBe("unavailable");
  });

  it("skips when no provider offers deletion", async () => {
    const provider = { providerId: "remote", resolve: async () => null };
    const deleteRemote = await deleteRemoteWith({ "canvas-upstream:remote": provider });
    expect(await deleteRemote("canvas-1")).toBe("skipped");
  });

  it("keeps looking past providers without deletion and non-upstream capabilities", async () => {
    const deleteCanvas = vi.fn(async () => "not-found" as const);
    const deleteRemote = await deleteRemoteWith({
      "canvas-upstream:first": { providerId: "first", resolve: async () => null },
      "canvas-source:other": { providerId: "other", resolve: async () => null, deleteCanvas },
      "canvas-upstream:second": { providerId: "second", resolve: async () => null, deleteCanvas }
    });
    expect(await deleteRemote("canvas-1")).toBe("not-found");
    expect(deleteCanvas).toHaveBeenCalledTimes(1);
  });
});
