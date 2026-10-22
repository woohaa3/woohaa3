import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";
import { extensionReleaseStatic } from "../../../vite.config.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "woohaa-release-build-"));
  roots.push(root);
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), '<html><head></head><body><script type="module" src="/main.js"></script></body></html>');
  writeFileSync(join(root, "main.js"), 'document.body.dataset.build = "first";');
  return { root, dist };
}

async function buildFixture(root: string) {
  await build({ root, configFile: false, logLevel: "silent", plugins: [extensionReleaseStatic(root, "/", () => null)] });
}

describe("宿主构建与独立扩展发布", () => {
  it("连续宿主构建保留不可变清单与扩展，只清理过期宿主资源", async () => {
    const { root, dist } = fixture();
    const href = `/extension-releases/${"a".repeat(64)}.json`;
    const artifact = join(dist, "extensions", "demo", "b".repeat(64), "index.js");
    mkdirSync(join(dist, "extension-releases"), { recursive: true });
    mkdirSync(join(artifact, ".."), { recursive: true });
    writeFileSync(join(dist, href), '{"release":"immutable"}');
    writeFileSync(artifact, 'export const immutable = true;');
    writeFileSync(join(dist, "index.html"), `<html><head><link rel="woohaa-extension-release" href="${href}"></head></html>`);
    writeFileSync(join(dist, "assets", "stale.js"), "stale");
    writeFileSync(join(dist, "old-renderer.html"), "stale");

    await buildFixture(root);
    expect(existsSync(join(dist, "assets", "stale.js"))).toBe(false);
    expect(existsSync(join(dist, "old-renderer.html"))).toBe(false);
    const firstAssets = readdirSync(join(dist, "assets"));
    writeFileSync(join(root, "main.js"), 'document.body.dataset.build = "second";');
    await buildFixture(root);

    expect(readFileSync(join(dist, href), "utf8")).toBe('{"release":"immutable"}');
    expect(readFileSync(artifact, "utf8")).toBe('export const immutable = true;');
    expect(readFileSync(join(dist, "index.html"), "utf8").match(/rel="woohaa-extension-release"/g)).toHaveLength(1);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain(href);
    expect(firstAssets.every((file) => !existsSync(join(dist, "assets", file)))).toBe(true);
  });

  it("旧 HTML 的清单已缺失时，不将悬空发布指针复制进新 HTML", async () => {
    const { root, dist } = fixture();
    writeFileSync(join(dist, "index.html"), `<html><head><link rel="woohaa-extension-release" href="/extension-releases/${"a".repeat(64)}.json"></head></html>`);
    await buildFixture(root);
    expect(readFileSync(join(dist, "index.html"), "utf8")).not.toContain("woohaa-extension-release");
  });
});
