import { describe, expect, it } from "vitest";
import { withVersionEvidence, isLegacyRecord, versionEvidence } from "./version-evidence.js";
import type { InstallationRecord } from "./types.js";

const base: InstallationRecord = {
  current: "2.0.0",
  previous: "1.0.0",
  sourceId: "local-file",
  packageDigest: "sha256:new",
  filesDigest: "sha256:new-files",
  trust: "certified:test-only:publisher",
  versions: {
    "1.0.0": { filesDigest: "sha256:old-files", packageDigest: "sha256:old", trust: "signed:0123456789abcdef" },
    "2.0.0": { filesDigest: "sha256:new-files", packageDigest: "sha256:new", trust: "certified:test-only:publisher" }
  }
};

describe("version evidence", () => {
  it("uses the per-version evidence when switching to another version", () => {
    const next = withVersionEvidence(base, "1.0.0");
    expect(next.filesDigest).toBe("sha256:old-files");
    expect(next.packageDigest).toBe("sha256:old");
    expect(next.trust).toBe("signed:0123456789abcdef");
  });

  it("keeps the current version fields when nothing changed", () => {
    expect(withVersionEvidence(base, "2.0.0")).toMatchObject({ filesDigest: "sha256:new-files", trust: "certified:test-only:publisher" });
  });

  // 兼容窗口：改版之前的记录没有 versions。切回旧版本时必须清掉上一版本的摘要，
  // 否则 installed() 会拿新版本摘要去比旧目录，把正常回滚判成内容被改。
  it("clears stale digests for records written before per-version evidence existed", () => {
    const legacy: InstallationRecord = { current: "2.0.0", previous: "1.0.0", sourceId: "local-file", packageDigest: "sha256:new", filesDigest: "sha256:new-files", trust: "signed:0123456789abcdef" };
    expect(isLegacyRecord(legacy)).toBe(true);
    const next = withVersionEvidence(legacy, "1.0.0");
    expect(next.filesDigest).toBeUndefined();
    // packageDigest 是归档身份，必须保留：它是 legacy 精确迁移唯一的凭据。
    expect(next.packageDigest).toBe("sha256:new");
    expect(next.trust).toBeUndefined();
    expect(next.current).toBe("2.0.0");
    expect(versionEvidence(legacy, "1.0.0")).toBeUndefined();
  });

  it("treats a record with versions but no digest as legacy", () => {
    expect(isLegacyRecord({ current: "1.0.0", sourceId: "local-file" })).toBe(true);
    expect(isLegacyRecord(base)).toBe(false);
  });
});
