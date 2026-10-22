import { expect, it, vi } from "vitest";
import { createRuntimeExecutableResolver } from "./runtime-executable.js";
it("uses an installed managed Codex for discovery and leases it for execution without installing", async () => {
  const release = vi.fn(); const inspect = vi.fn(async () => ({ status: "ready", entry: "/managed/codex" }));
  const resolve = vi.fn(async () => ({ entry: "/managed/codex", release }));
  const resolver = createRuntimeExecutableResolver({ local: () => null, getManager: () => ({ inspect, resolve }) });
  expect(await resolver.executableFor("codex-appserver")).toBe("/managed/codex");
  expect(resolve).not.toHaveBeenCalled();
  const lease = await resolver.acquire("codex-appserver");
  expect(lease?.entry).toBe("/managed/codex"); lease?.release(); expect(release).toHaveBeenCalledOnce();
  expect(await resolver.executableFor("opencode-server")).toBeNull();
});
it("preserves existing local executables and leaves missing runtime uninstalled", async () => {
  const inspect = vi.fn(async () => ({ status: "missing" }));
  const resolve = vi.fn();
  const resolver = createRuntimeExecutableResolver({ local: id => id === "opencode-server" ? "/local/opencode" : null, getManager: () => ({ inspect, resolve }) });
  expect(await resolver.executableFor("opencode-server")).toBe("/local/opencode");
  expect((await resolver.acquire("opencode-server"))?.entry).toBe("/local/opencode");
  expect(await resolver.executableFor("codex-appserver")).toBeNull(); expect(resolve).not.toHaveBeenCalled();
});
