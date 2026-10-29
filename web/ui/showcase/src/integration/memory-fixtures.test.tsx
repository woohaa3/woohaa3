import { expect, it, vi } from "vitest";
import { createSettingsFixture } from "./settings-fixture.js";
import { createConfigurationFixture } from "./configuration-fixture.js";
import { createInstallationFixture } from "./installation-fixture.js";
it("settings memory adapter preserves failure drafts, retries, and never returns secret plaintext", async () => {
  const events = vi.fn(); const fixture = createSettingsFixture(events, "error");
  await fixture.backend.load();
  expect((await fixture.backend.save({ "providers.fixture.apiKey": "secret" })).ok).toBe(false);
  expect((await fixture.backend.save({ "providers.fixture.apiKey": "secret" })).ok).toBe(true);
  let state = fixture.backend.getState(); expect(state.status).toBe("ready");
  if (state.status === "ready") expect(state.snapshot.settings.find(s => s.secret)).toMatchObject({ value: null, configured: true });
  await fixture.backend.save({ "providers.fixture.apiKey": null }); state = fixture.backend.getState();
  if (state.status === "ready") expect(state.snapshot.settings.find(s => s.secret)?.configured).toBe(false);
  fixture.hold(); let done = false; const save = fixture.backend.save({ "canvas.label": "更新" }).then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); fixture.settle(); await save; expect(done).toBe(true); fixture.dispose();
});
it("configuration adapter performs memory mutations and reports failed SDK save before retry", async () => {
  const fixture = createConfigurationFixture(vi.fn(), "ready"); fixture.failNext();
  expect((await fixture.sdk.configure({ adapterId: "responses", secret: "secret" })).ok).toBe(false);
  expect((await fixture.sdk.configure({ adapterId: "responses", secret: "secret" })).ok).toBe(true);
  const list = await fixture.sdk.list(); expect(list.ok && list.value.connections[0]?.credentialConfigured).toBe(true);
  await fixture.sdk.clearCredential("memory-sdk");
  const cleared = await fixture.sdk.list(); expect(cleared.ok && cleared.value.connections[0]?.credentialConfigured).toBe(false);
  fixture.failNext(); expect((await fixture.sdk.saveCredential({ connectionId: "memory-sdk", secret: "retry" })).ok).toBe(false);
  expect((await fixture.sdk.saveCredential({ connectionId: "memory-sdk", secret: "retry" })).ok).toBe(true);
  const saved = await fixture.sdk.list(); expect(saved.ok && saved.value.connections[0]?.credentialConfigured).toBe(true);
  await fixture.local.create({ adapterId: "codex-appserver" }); const local = await fixture.local.list(); expect(local.ok && local.value.connections.length).toBe(1);
  await fixture.local.remove("memory-local"); const empty = await fixture.local.list(); expect(empty.ok && empty.value.connections).toEqual([]);
  fixture.dispose();
});
it("installation uses production controllers, retries failure and advances one shared job to completion", async () => {
  const record = vi.fn(); const fixture = createInstallationFixture(record, "error");
  await fixture.controller.load(); await fixture.controller.select("fixture"); await fixture.controller.install();
  expect(fixture.controller.getState().error).toContain("安装失败"); expect(fixture.managed.getState().jobs).toHaveLength(0);
  await fixture.controller.install(); expect(fixture.managed.getState().jobs[0]?.status).toBe("running");
  fixture.settle(); await Promise.resolve(); await Promise.resolve(); expect(fixture.managed.getState().jobs[0]?.status).toBe("succeeded");
  expect(record).toHaveBeenCalledWith("刷新内存插件列表"); fixture.managed.dispose();
});
