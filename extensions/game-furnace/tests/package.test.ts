import { describe, expect, it } from "vitest";
import { collectResourceReferences, decodeGameResult, injectAssetMap, validateGameHtml } from "../src/authoring/shared/output.js";
import { decodeSourcePackage, encodeSourcePackage, resourceRelativePath } from "../src/state/shared/package.js";
import { normalizeResource } from "../src/shared.js";

const png = normalizeResource({
  resourceId: "res-hero",
  kind: "image",
  name: "主角",
  payload: { kind: "asset", assetIds: ["asset-1"] },
  metadata: { mime: "image/png", size: 1 }
});

const VALID_GAME = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>const c=document.getElementById('g');let score=0;function loop(){score++;draw();requestAnimationFrame(loop)}</script>
</body></html>`;

describe("game-furnace package codec", () => {
  it("确定资源路径", () => {
    expect(resourceRelativePath(png)).toBe("assets/res-hero.png");
  });

  it("解析 JSON 结果对象", () => {
    const decoded = decodeGameResult(JSON.stringify({ schemaVersion: 1, title: "t", controlsSummary: "方向键", entry: "index.html", html: VALID_GAME, resourceIds: ["res-hero"] }));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.title).toBe("t");
  });

  it("解析单 HTML 代码块", () => {
    const decoded = decodeGameResult("```html\n" + VALID_GAME + "\n```");
    expect(decoded.ok).toBe(true);
  });

  it("拒绝空输出与多候选", () => {
    expect(decodeGameResult("").ok).toBe(false);
    expect(decodeGameResult("```html\na\n```\n```html\nb\n```").ok).toBe(false);
  });

  it("拒绝畸形成功（缺入口/脚本）", () => {
    // 缺 entry 的 JSON 结果解码失败。
    expect(decodeGameResult(JSON.stringify({ schemaVersion: 1, html: VALID_GAME, resourceIds: [] })).ok).toBe(false);
    // 缺脚本的 HTML 能解码（规范化），但静态校验拒绝，不宣称可玩。
    const noScript = decodeGameResult(JSON.stringify({ schemaVersion: 1, entry: "index.html", html: "<html><body><p>no script</p></body></html>", resourceIds: [] }));
    expect(noScript.ok).toBe(true);
    expect(validateGameHtml({ html: "<html><body><p>no script</p></body></html>", allowedResourcePaths: new Set(), knownResourceIds: new Set() }).ok).toBe(false);
  });

  it("静态校验：体积/入口/内联/外部依赖/资源引用", () => {
    const allowed = new Set(["assets/res-hero.png"]);
    expect(validateGameHtml({ html: VALID_GAME, allowedResourcePaths: allowed, knownResourceIds: new Set(["res-hero"]) }).ok).toBe(true);
    // 外部脚本
    expect(validateGameHtml({ html: `<html><body><script src="https://cdn.example/x.js"></script></body></html>`, allowedResourcePaths: allowed, knownResourceIds: new Set() }).ok).toBe(false);
    // 网络访问
    expect(validateGameHtml({ html: `<html><body><script>fetch('https://evil')</script></body></html>`, allowedResourcePaths: allowed, knownResourceIds: new Set() }).ok).toBe(false);
    // 未声明资源
    expect(validateGameHtml({ html: `<html><body><img src="assets/other.png"><script>1</script></body></html>`, allowedResourcePaths: allowed, knownResourceIds: new Set() }).ok).toBe(false);
    // 存储/顶层导航
    expect(validateGameHtml({ html: `<html><body><script>localStorage.x=1</script></body></html>`, allowedResourcePaths: allowed, knownResourceIds: new Set() }).ok).toBe(false);
  });

  it("资源引用收集与 GAME_ASSETS 注入转义", () => {
    expect(collectResourceReferences(`<img src="assets/res-hero.png">`)).toEqual(["assets/res-hero.png"]);
    const injected = injectAssetMap("<html><head></head><body><script>1</script></body></html>", { hero: "assets/res-hero.png" });
    expect(injected).toContain("window.GAME_ASSETS=Object.freeze(");
  });

  it("源码包往返", () => {
    const manifest = {
      schemaVersion: 1 as const,
      buildId: "build-1",
      title: "t",
      controlsSummary: "",
      entry: "index.html" as const,
      policyVersion: "p",
      inputHash: "h",
      sourceHash: "s",
      dependencyAssetIds: ["asset-1"],
      resources: [{ resourceId: "res-hero", path: "assets/res-hero.png", assetId: "asset-1", contentType: "image/png", usage: "used" as const }]
    };
    const bytes = encodeSourcePackage({ schemaVersion: 1, entry: "index.html", html: VALID_GAME, manifest });
    const decoded = decodeSourcePackage(bytes);
    expect(decoded.html).toBe(VALID_GAME);
    expect(decoded.manifest.buildId).toBe("build-1");
  });

  it("manifest 冻结资源 storageKey 往返保留，缺省时省略（任务 7.8）", () => {
    const manifest = {
      schemaVersion: 1 as const,
      buildId: "build-frozen",
      title: "t",
      controlsSummary: "",
      entry: "index.html" as const,
      policyVersion: "p",
      inputHash: "h",
      sourceHash: "s",
      dependencyAssetIds: ["asset-1"],
      resources: [
        { resourceId: "res-hero", path: "assets/res-hero.png", assetId: "asset-1", contentType: "image/png", usage: "used" as const, storageKey: "sha256-freeze" },
        { resourceId: "res-hero2", path: "assets/res-hero2.png", assetId: "asset-2", contentType: "image/png", usage: "unused" as const }
      ]
    };
    const decoded = decodeSourcePackage(encodeSourcePackage({ schemaVersion: 1, entry: "index.html", html: VALID_GAME, manifest }));
    expect(decoded.manifest.resources[0]!.storageKey).toBe("sha256-freeze");
    expect(decoded.manifest.resources[1]!.storageKey).toBeUndefined();
  });
});
