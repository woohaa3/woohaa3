/**
 * Extension 浏览器产物 / 发布目录 / ABI 契约测试
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.1/1.5 / design D4/D5/D6/D2）。
 *
 * 重点验证：
 * - metadata/artifact/release 严格解码拒绝非法字段、路径穿越、重复 identity、ABI 不一致；
 * - artifact files/entry/styles/imports 闭包校验，外部依赖残留被拒；
 * - 发布地址只接受同源固定前缀、无 query/fragment；
 * - ABI 精确整数匹配（含 React major 与协议版本）。
 */
import { describe, expect, it } from "vitest";
import {
  decodeExtensionBrowserArtifactManifest,
  decodeExtensionReleaseCatalog,
  EXTENSION_BROWSER_PROTOCOL_VERSION,
  EXTENSION_SDK_ABI_VERSION,
  HOST_REACT_MAJOR,
  isArtifactCompatibleWithHost,
  isValidPublishedExtensionUrl,
  metadataToEntrySummary,
  type ExtensionBrowserArtifactManifest,
  type ExtensionFrontendMetadata
} from "../../index.js";

const SHA = "a".repeat(64);
const ARTIFACT_ID = "b".repeat(64);

const METADATA: ExtensionFrontendMetadata = {
  extensionId: "sample-ext",
  version: "0.1.0",
  label: "样例扩展",
  description: "用于测试的扩展。",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};

function validManifest(overrides: Partial<ExtensionBrowserArtifactManifest> = {}): ExtensionBrowserArtifactManifest {
  return {
    schemaVersion: EXTENSION_BROWSER_PROTOCOL_VERSION,
    artifactId: ARTIFACT_ID,
    metadata: METADATA,
    protocolVersion: EXTENSION_BROWSER_PROTOCOL_VERSION,
    sdkAbi: EXTENSION_SDK_ABI_VERSION,
    reactMajor: HOST_REACT_MAJOR,
    entry: "entry.js",
    styles: ["styles.css"],
    requiredSdkGroups: ["core", "ui"],
    requiredSdkExports: ["Button"],
    files: [
      { path: "entry.js", bytes: 10, gzipBytes: 10, sha256: SHA, kind: "entry" },
      { path: "chunk.js", bytes: 10, gzipBytes: 10, sha256: SHA, kind: "private-chunk" },
      { path: "styles.css", bytes: 10, gzipBytes: 10, sha256: SHA, kind: "style" }
    ],
    imports: [
      { from: "entry.js", specifier: "./chunk.js", resolved: "chunk.js" },
      { from: "chunk.js", specifier: "./styles.css", resolved: "styles.css" }
    ],
    ...overrides
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("artifact manifest 严格解码（任务 1.1/3.5）", () => {
  it("接受合法 manifest 并保持字段集", () => {
    const decoded = decodeExtensionBrowserArtifactManifest(validManifest());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.artifactId).toBe(ARTIFACT_ID);
  });

  it("拒绝 schema/protocol/ABI 不一致与非法 artifactId", () => {
    expect(decodeExtensionBrowserArtifactManifest({ ...validManifest(), schemaVersion: 2 }).ok).toBe(false);
    expect(decodeExtensionBrowserArtifactManifest({ ...validManifest(), protocolVersion: 2 }).ok).toBe(false);
    expect(decodeExtensionBrowserArtifactManifest({ ...validManifest(), artifactId: "not-hex" }).ok).toBe(false);
  });

  it("拒绝路径穿越与非安全相对路径", () => {
    const manifest = validManifest({ files: [{ path: "../evil.js", bytes: 1, gzipBytes: 1, sha256: SHA, kind: "entry" }], entry: "../evil.js", styles: [], imports: [] });
    expect(decodeExtensionBrowserArtifactManifest(manifest).ok).toBe(false);
    const absolute = validManifest({ files: [{ path: "/abs.js", bytes: 1, gzipBytes: 1, sha256: SHA, kind: "entry" }], entry: "/abs.js", styles: [], imports: [] });
    expect(decodeExtensionBrowserArtifactManifest(absolute).ok).toBe(false);
    const query = validManifest({ files: [{ path: "entry.js?x=1", bytes: 1, gzipBytes: 1, sha256: SHA, kind: "entry" }], entry: "entry.js?x=1", styles: [], imports: [] });
    expect(decodeExtensionBrowserArtifactManifest(query).ok).toBe(false);
  });

  it("entry/styles 必须在 files 中，且 hash 必须为 sha256", () => {
    expect(decodeExtensionBrowserArtifactManifest(validManifest({ entry: "missing.js" })).ok).toBe(false);
    expect(decodeExtensionBrowserArtifactManifest(validManifest({ styles: ["missing.css"] })).ok).toBe(false);
    const badHash = validManifest();
    badHash.files[0] = { ...badHash.files[0]!, sha256: "xyz" };
    expect(decodeExtensionBrowserArtifactManifest(badHash).ok).toBe(false);
  });

  it("依赖图中的外部残留依赖被拒绝", () => {
    const withExternal = validManifest({
      imports: [{ from: "entry.js", specifier: "react", resolved: null }]
    });
    expect(decodeExtensionBrowserArtifactManifest(withExternal).ok).toBe(false);
    const missingTarget = validManifest({
      imports: [{ from: "entry.js", specifier: "./nope.js", resolved: "nope.js" }]
    });
    expect(decodeExtensionBrowserArtifactManifest(missingTarget).ok).toBe(false);
  });

  it("metadata SDK ABI 必须与 manifest.sdkAbi 一致", () => {
    const mismatch = { ...validManifest(), metadata: { ...METADATA, sdkAbi: 99 } };
    expect(decodeExtensionBrowserArtifactManifest(mismatch).ok).toBe(false);
  });

  it("metadata 组合约束：browser-local 不得 required / 站点不得 browser-local activation", () => {
    const badRequired = validManifest({
      metadata: { ...METADATA, configScope: "browser-local", activation: "browser-local", required: true }
    });
    expect(decodeExtensionBrowserArtifactManifest(badRequired).ok).toBe(false);
    const badActivation = validManifest({ metadata: { ...METADATA, configScope: "site", activation: "browser-local" } });
    expect(decodeExtensionBrowserArtifactManifest(badActivation).ok).toBe(false);
  });

  it("settingsPanel 是可选的布尔标记，其它类型拒绝", () => {
    const declared = decodeExtensionBrowserArtifactManifest(
      validManifest({ metadata: { ...METADATA, settingsPanel: true } })
    );
    expect(declared.ok).toBe(true);
    if (declared.ok) expect(declared.value.metadata.settingsPanel).toBe(true);

    const undeclared = decodeExtensionBrowserArtifactManifest(validManifest());
    expect(undeclared.ok).toBe(true);
    if (undeclared.ok) expect("settingsPanel" in undeclared.value.metadata).toBe(false);

    const invalid = validManifest({ metadata: { ...METADATA, settingsPanel: "yes" as never } });
    expect(decodeExtensionBrowserArtifactManifest(invalid).ok).toBe(false);
  });
});

describe("发布目录严格解码（任务 1.1/4.1）", () => {
  function validCatalog() {
    return {
      schemaVersion: EXTENSION_BROWSER_PROTOCOL_VERSION,
      releaseId: SHA,
      hostSdkAbi: EXTENSION_SDK_ABI_VERSION,
      entries: [
        {
          metadata: METADATA,
          artifactId: ARTIFACT_ID,
          entryURL: "/extensions/sample-ext/" + ARTIFACT_ID + "/entry.js",
          styleURLs: ["/extensions/sample-ext/" + ARTIFACT_ID + "/styles.css"],
          protocolVersion: EXTENSION_BROWSER_PROTOCOL_VERSION,
          sdkAbi: EXTENSION_SDK_ABI_VERSION,
          reactMajor: HOST_REACT_MAJOR,
          requiredSdkGroups: ["core"],
          requiredSdkExports: ["Button"]
        }
      ]
    };
  }

  it("接受合法目录", () => {
    const decoded = decodeExtensionReleaseCatalog(validCatalog());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.entries).toHaveLength(1);
  });

  it("拒绝非法的同源/固定前缀地址", () => {
    const catalog = validCatalog();
    catalog.entries[0]!.entryURL = "https://evil.example/x.js";
    expect(decodeExtensionReleaseCatalog(catalog).ok).toBe(false);
    const relative = validCatalog();
    relative.entries[0]!.entryURL = "//evil.example/x.js";
    expect(decodeExtensionReleaseCatalog(relative).ok).toBe(false);
    const query = validCatalog();
    query.entries[0]!.entryURL = "/extensions/x/entry.js?v=2";
    expect(decodeExtensionReleaseCatalog(query).ok).toBe(false);
  });

  it("拒绝重复 extensionId / artifactId", () => {
    const catalog = validCatalog();
    catalog.entries.push(clone(catalog.entries[0]!));
    expect(decodeExtensionReleaseCatalog(catalog).ok).toBe(false);
  });

  it("entry.sdkAbi 与 metadata.sdkAbi 必须一致", () => {
    const catalog = validCatalog();
    catalog.entries[0]!.sdkAbi = 99 as unknown as typeof EXTENSION_SDK_ABI_VERSION;
    expect(decodeExtensionReleaseCatalog(catalog).ok).toBe(false);
  });

  it("isValidPublishedExtensionUrl 只接受绝对同源路径", () => {
    expect(isValidPublishedExtensionUrl("/extensions/a/b.js")).toBe(true);
    expect(isValidPublishedExtensionUrl("extensions/a/b.js")).toBe(false);
    expect(isValidPublishedExtensionUrl("/a/../b.js")).toBe(false);
    expect(isValidPublishedExtensionUrl("/a//b.js")).toBe(false);
  });
});

describe("ABI 精确匹配与投影（任务 1.5）", () => {
  it("协议/SDK/React 任一不匹配即不兼容", () => {
    const base = { protocolVersion: EXTENSION_BROWSER_PROTOCOL_VERSION, sdkAbi: EXTENSION_SDK_ABI_VERSION, reactMajor: HOST_REACT_MAJOR };
    expect(isArtifactCompatibleWithHost(base)).toBe(true);
    expect(isArtifactCompatibleWithHost({ ...base, sdkAbi: 2 })).toBe(false);
    expect(isArtifactCompatibleWithHost({ ...base, reactMajor: 19 })).toBe(false);
    expect(isArtifactCompatibleWithHost({ ...base, protocolVersion: 2 })).toBe(false);
  });

  it("metadata 投影为管理入口摘要", () => {
    expect(metadataToEntrySummary(METADATA)).toEqual({
      extensionId: "sample-ext",
      configScope: "site",
      activation: "server-active"
    });
  });
});

describe("插件图标（extension metadata.icon）", () => {
  it("声明的白名单图标名透传；未声明时不带该字段", () => {
    const declared = decodeExtensionBrowserArtifactManifest(
      validManifest({ metadata: { ...METADATA, icon: "provider" } })
    );
    expect(declared.ok).toBe(true);
    if (declared.ok) expect(declared.value.metadata.icon).toBe("provider");

    const undeclared = decodeExtensionBrowserArtifactManifest(validManifest());
    expect(undeclared.ok).toBe(true);
    if (undeclared.ok) expect("icon" in undeclared.value.metadata).toBe(false);
  });

  it("品牌图形路径同样透传，任意地址与目录穿越被拒", () => {
    const asset = decodeExtensionBrowserArtifactManifest(
      validManifest({ metadata: { ...METADATA, icon: "/plugin-icons/litellm.png" } })
    );
    expect(asset.ok).toBe(true);
    if (asset.ok) expect(asset.value.metadata.icon).toBe("/plugin-icons/litellm.png");

    for (const icon of ["https://evil.example/logo.png", "//evil.example/logo.png", "/plugin-icons/../x.png"]) {
      expect(decodeExtensionBrowserArtifactManifest(validManifest({ metadata: { ...METADATA, icon: icon as never } })).ok, icon).toBe(false);
    }
  });

  it("白名单之外的名字按非法 metadata 拒绝", () => {
    const decoded = decodeExtensionBrowserArtifactManifest(
      validManifest({ metadata: { ...METADATA, icon: "not-an-icon" as never } })
    );
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.message).toContain("icon");
  });
});
