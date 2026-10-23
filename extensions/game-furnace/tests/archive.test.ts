import { describe, expect, it } from "vitest";
import type { MediaObject } from "@woohaa3/contracts";
import { gameFurnaceArchiveDefinition } from "../src/archive.js";
import { createGameFurnaceState, GAME_POLICY_VERSION, type GameFurnaceState } from "../src/shared.js";
import { buildRecordFromManifest, encodeSourcePackage, type GamePackageManifest } from "../src/state/shared/package.js";

async function fixture() {
  const objects = new Map<string, MediaObject>();
  const put = async (bytes: Uint8Array, contentType = "application/json") => {
    const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const key = `sha256-${checksum}`;
    objects.set(key, { bytes, contentType });
    return key;
  };
  const json = (value: unknown) => put(new TextEncoder().encode(JSON.stringify(value)));
  const asset = await put(new Uint8Array([1, 2, 3]), "image/png");
  const file = await put(new TextEncoder().encode("document.body.dataset.loaded='yes'"), "application/javascript");
  const entry = await put(new TextEncoder().encode('<html><script src="./game.js"></script></html>'), "text/html");
  const input = await json({ resources: [{ resourceId: "removed", storageKey: asset }] });
  const manifest: GamePackageManifest = { schemaVersion: 1, buildId: "build-1", title: "游戏", controlsSummary: "点按", entry: "index.html",
    policyVersion: GAME_POLICY_VERSION, inputHash: "hash", sourceHash: "source", dependencyAssetIds: ["asset"],
    resources: [{ resourceId: "removed", assetId: "asset", path: "assets/removed.png", contentType: "image/png", storageKey: asset, usage: "used" }] };
  const manifestKey = await json(manifest);
  const sourceKey = await put(encodeSourcePackage({ schemaVersion: 1, entry: "index.html", html: "<html></html>", manifest,
    site: { schemaVersion: 1, format: "vite", sourceFiles: {}, files: [
      { path: "index.html", storageKey: entry, contentType: "text/html", size: objects.get(entry)!.bytes.length, checksum: entry.slice(7) },
      { path: "game.js", storageKey: file, contentType: "application/javascript", size: objects.get(file)!.bytes.length, checksum: file.slice(7) }
    ] } }));
  const state = createGameFurnaceState("project") as unknown as GameFurnaceState;
  state.generations = [{ generationId: "gen", workerTaskKey: "task", inputHash: "hash", inputManifestAssetId: input, admittedAt: "2026-10-11T00:00:00Z" }];
  state.builds = [buildRecordFromManifest(manifest, { generationId: "gen", manifestAssetId: manifestKey, sourceAssetId: sourceKey, createdAt: "2026-10-11T00:00:00Z" })];
  state.activeBuildId = "build-1";
  const root = await json(state);
  const read = async (key: string) => { const object = objects.get(key); if (!object) throw Error(`missing ${key}`); return object; };
  return { objects, json, read, root, asset, file, entry, input, manifestKey, sourceKey, state };
}

describe("炼丹炉离线归档引用", () => {
  it("当前素材已移除仍收集输入原件、历史清单/源码、冻结素材和 Vite 文件", async () => {
    const f = await fixture();
    expect(f.state.resources).toEqual([]);
    const before = [...f.objects.entries()].map(([key, object]) => [key, [...object.bytes]]);
    const keys = await gameFurnaceArchiveDefinition.collectMediaKeys({ nodeData: { projectStorageKey: f.root }, read: f.read });
    expect(keys).toEqual([f.root, f.asset, f.file, f.entry, f.input, f.manifestKey, f.sourceKey].sort());
    expect([...f.objects.entries()].map(([key, object]) => [key, [...object.bytes]])).toEqual(before);
  });

  it("未知版本不解释/改写，归档明确拒绝虚报完整", async () => {
    const f = await fixture();
    const root = await f.json({ schemaVersion: 999, untouched: "future" });
    const before = f.objects.get(root)!.bytes.slice();
    await expect(gameFurnaceArchiveDefinition.collectMediaKeys({ nodeData: { projectStorageKey: root }, read: f.read })).rejects.toThrow(/未知/);
    expect(f.objects.get(root)!.bytes).toEqual(before);
  });

  it("历史源码缺失失败，空节点无需访问媒体", async () => {
    const f = await fixture();
    f.objects.delete(f.sourceKey);
    await expect(gameFurnaceArchiveDefinition.collectMediaKeys({ nodeData: { projectStorageKey: f.root }, read: f.read })).rejects.toThrow(/missing/);
    expect(await gameFurnaceArchiveDefinition.collectMediaKeys({ nodeData: {}, read: async () => { throw Error("must not read"); } })).toEqual([]);
  });
});
