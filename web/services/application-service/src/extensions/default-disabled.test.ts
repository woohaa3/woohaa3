import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";
import { createSqliteSiteExtensionConfigStore } from "./config-store.js";
import { createSqliteExtensionWorkRepository } from "../repository/extension-work-repository.js";
import { createApplicationExtensionHost } from "./host.js";
import { createSiteExtensionControlPlane } from "./control-plane.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function open(dir: string, extensionId: string) {
  const store = createSqliteSiteExtensionConfigStore({ path: path.join(dir, "config.sqlite") });
  const work = createSqliteExtensionWorkRepository({ path: path.join(dir, "work.sqlite") });
  const metadata: ApplicationExtensionMetadata = { extensionId, name: extensionId, description: "isolated regression", version: "1", managementScope: "site", host: "application", defaultEnabled: false, configSchema: { schemaId: "test", schemaVersion: 1 }, dependencies: [], capabilities: [] };
  const plane = createSiteExtensionControlPlane({ host: createApplicationExtensionHost(), store, workStore: work,
    metadata: { list: () => [metadata], get: id => id === extensionId ? metadata : undefined }, definitions: [{ extensionId, activate: () => ({}) }] });
  const write = (enabled: boolean) => plane.write({ extensionId, enabled, expectedRevision: store.revision(), values: { preserved: 7 }, secretRefs: ["preserved-ref"], actor: "test" });
  return { plane, store, work, write, close() { store.close(); work.close(); } };
}
it.each(["game-furnace", "creature-video-assets"])("%s: absent default false, saved booleans, restart, explicit enable and draining preserve data", async extensionId => {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa-default-off-")); dirs.push(dir);
  let current = open(dir, extensionId);
  await current.plane.reconcile();
  expect(current.plane.status(extensionId)?.desiredEnabled).toBe(false);
  expect(current.plane.status(extensionId)?.actualState).not.toBe("active");
  expect(current.store.get(extensionId)).toBeUndefined();
  expect(await current.write(true)).toMatchObject({ ok: true });
  current.close(); current = open(dir, extensionId); await current.plane.reconcile();
  expect(current.plane.status(extensionId)).toMatchObject({ desiredEnabled: true, actualState: "active" });
  expect(current.store.get(extensionId)).toMatchObject({ desiredEnabled: true, values: { preserved: 7 }, secretRefs: ["preserved-ref"] });
  const admitted = current.plane.workLease(extensionId)!.admit(); expect(admitted.ok).toBe(true); if (!admitted.ok) throw Error("admission failed");
  expect(await current.write(false)).toMatchObject({ ok: true });
  expect(current.plane.status(extensionId)?.actualState).toBe("draining");
  current.close(); current = open(dir, extensionId); await current.plane.reconcile();
  expect(current.plane.status(extensionId)).toMatchObject({ desiredEnabled: false, actualState: "draining" });
  expect(current.plane.workLease(extensionId)!.admit().ok).toBe(false);
  current.plane.workLease(extensionId)!.resume(admitted.workId)!.settle("succeeded");
  await current.plane.reconcile(); expect(current.plane.status(extensionId)?.actualState).toBe("disabled");
  expect(current.store.get(extensionId)).toMatchObject({ desiredEnabled: false, values: { preserved: 7 }, secretRefs: ["preserved-ref"] });
  expect(await current.write(true)).toMatchObject({ ok: true }); expect(current.plane.status(extensionId)?.actualState).toBe("active");
  await current.plane.dispose(); current.close();
});
