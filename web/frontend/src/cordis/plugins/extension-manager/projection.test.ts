import { describe, expect, it } from "vitest";
import { projectExtensionManagerRows } from "./projection.js";

const catalog = [
  { id: "hello-marketplace", name: "市场示例插件", description: "", required: false, configurable: true },
  { id: "other", name: "Other", description: "", required: false, configurable: true }
] as never;

describe("projectExtensionManagerRows", () => {
  it("失败行带上真实原因，界面才有东西可显示", () => {
    const rows = projectExtensionManagerRows(catalog, {
      assembled: { "hello-marketplace": true },
      desired: { "hello-marketplace": true },
      failed: new Set(["hello-marketplace"]),
      failures: { "hello-marketplace": "无法加载扩展包：HTTP 404" }
    });
    expect(rows[0]).toMatchObject({ id: "hello-marketplace", status: "failed", failureReason: "无法加载扩展包：HTTP 404" });
  });

  it("没有原因时不编造文案，也不给正常行加字段", () => {
    const rows = projectExtensionManagerRows(catalog, {
      assembled: { other: true },
      desired: { other: true },
      failed: new Set(["hello-marketplace"])
    });
    expect(rows[0]).toMatchObject({ id: "hello-marketplace", status: "failed" });
    expect(rows[0]!.failureReason).toBeUndefined();
    expect(rows[1]).toMatchObject({ id: "other", status: "active" });
    expect(rows[1]!.failureReason).toBeUndefined();
  });
});
