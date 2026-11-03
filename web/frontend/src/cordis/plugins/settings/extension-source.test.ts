import { describe, expect, it } from "vitest";
import type { InstalledExtensionView } from "@woohaa3/contracts";
import { extensionSource, extensionTrustBadge, signedKeyId } from "./extension-source.js";

const managed = (overrides: Partial<InstalledExtensionView> = {}): InstalledExtensionView =>
  ({
    id: "demo",
    label: "Demo",
    description: "",
    directory: "/tmp/demo",
    writable: true,
    managed: true,
    sourceId: "woohaa-server",
    trust: "signed:abc123",
    ...overrides
  }) as InstalledExtensionView;

describe("extensionSource", () => {
  it("内置：未受管或没有 installed 都算内置", () => {
    expect(extensionSource(undefined)).toEqual({ id: "builtin", label: "内置", tone: "builtin" });
    expect(extensionSource(managed({ managed: false }))).toEqual({ id: "builtin", label: "内置", tone: "builtin" });
  });

  it("已知来源给中文名，本地文件单独的音色", () => {
    expect(extensionSource(managed())).toEqual({ id: "woohaa-server", label: "团队市场", tone: "market" });
    expect(extensionSource(managed({ sourceId: "github-release" }))).toEqual({ id: "github-release", label: "GitHub", tone: "market" });
    expect(extensionSource(managed({ sourceId: "local-file" }))).toEqual({ id: "local-file", label: "本地文件", tone: "local" });
  });

  it("未知 sourceId 原样显示，不冒充内置也不被吞成「市场」", () => {
    expect(extensionSource(managed({ sourceId: "my-private-registry" }))).toEqual({ id: "my-private-registry", label: "my-private-registry", tone: "market" });
    expect(extensionSource(managed({ sourceId: undefined }))).toEqual({ id: "unknown", label: "unknown", tone: "market" });
  });
});

describe("extensionTrustBadge", () => {
  it("非受管或没有签名信息时不显示徽标", () => {
    expect(extensionTrustBadge(undefined)).toBeNull();
    expect(extensionTrustBadge(managed({ managed: false }))).toBeNull();
    expect(extensionTrustBadge(managed({ trust: undefined }))).toBeNull();
  });

  it("已验证 / 未验证区分音色", () => {
    expect(extensionTrustBadge(managed())).toEqual({ label: "已验证", tone: "verified" });
    expect(extensionTrustBadge(managed({ trust: "unsigned" }))).toEqual({ label: "未验证", tone: "unsigned" });
    expect(extensionTrustBadge(managed({ trust: "certified:test-only:publisher" }))).toEqual({ label: "已验证", tone: "verified" });
  });

  it("signedKeyId 取 signed: 之后的部分", () => {
    expect(signedKeyId("signed:afd67694dd46ddcd")).toBe("afd67694dd46ddcd");
    expect(signedKeyId("unsigned")).toBeNull();
    expect(signedKeyId(undefined)).toBeNull();
  });
});
