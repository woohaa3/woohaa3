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
