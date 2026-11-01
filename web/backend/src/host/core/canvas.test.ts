import { describe, expect, it, vi } from "vitest";
import type { CanvasServiceOptions } from "@woohaa3/canvas-service";
import type { HostContext } from "../context.js";
import { canvasPlugin } from "./canvas.js";

const { createCanvasService } = vi.hoisted(() => ({ createCanvasService: vi.fn() }));
vi.mock("@woohaa3/canvas-service", () => ({ createCanvasService }));

// Capture the real host assembly, then run its options through the real Canvas composition.
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
