import type { ServerCanvas } from "@woohaa3/contracts";
import { describe, expect, it, vi } from "vitest";
import { mergeCanvasContentRuntimes } from "./canvas-content.js";
import { slotImplementationSource } from "./bootstrap.js";
import type { LoadedExtensionHost } from "./manifest.js";
const declaration = (extensionId: string) => ({ extensionId, runtime: {
  managedLifecycles: [{ extensionId, schemaVersion: 1 as const, plan: () => ({ nodes: [] }) }],
  managedMigrations: [{ extensionId, schemaVersion: 1 as const, migrate: (canvas: ServerCanvas) => ({ canvas, changed: false }) }]
} });
describe("trusted content runtime composition", () => {
  it("aggregates lifecycle and migration declarations from multiple extensions", () => {
    const result = mergeCanvasContentRuntimes([declaration("test.b"), declaration("test.a")]);
    expect(result?.managedLifecycles?.map(a => a.extensionId)).toEqual(["test.a", "test.b"]);
    expect(result?.managedMigrations).toHaveLength(2);
    expect(() => mergeCanvasContentRuntimes([declaration("test.a"), declaration("test.a")])).toThrow("conflict");
    expect(() => mergeCanvasContentRuntimes([{ ...declaration("test.a"), extensionId: "test.forged" }])).toThrow("owner-mismatch");
  });
  it("injects only trusted migration implementations before storage declarations open repositories", async () => {
    const createSlotDeclarations = vi.fn(async () => []);
    const host = { slotEntries: [{ extensionId: "test.storage" }], createSlotDeclarations,
      createCanvasContent: async () => [declaration("test.entities")] } as unknown as LoadedExtensionHost;
    await slotImplementationSource(host, { TEST: "yes" })!.createDeclarations({ "test.storage": { retained: true, managedMigrations: ["forged"] } });
    expect(createSlotDeclarations).toHaveBeenCalledWith({ "test.storage": { retained: true, managedMigrations: declaration("test.entities").runtime.managedMigrations.map(m => expect.objectContaining({ extensionId: m.extensionId, schemaVersion: 1 })) } }, { TEST: "yes" });
  });
});
