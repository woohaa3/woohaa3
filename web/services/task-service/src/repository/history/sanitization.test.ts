/**
 * 任务历史保留参考 provenance
 * （change: 2026-11-06-require-identity-reference，任务 2.2）。
 */
import { describe, expect, it } from "vitest";
import { sanitizeRequest } from "./sanitization.js";

describe("任务请求摘要的参考身份", () => {
  it("保留 assetId、来源节点、slot 与顺序，不保留执行期 URL", () => {
    const summary = sanitizeRequest({
      prompt: "同一角色近景",
      parameters: {},
      inputs: [
        {
          role: "reference_image",
          mediaKind: "image",
          mediaType: "image/png",
          assetId: "asset-a",
          storageKey: "sha256-" + "a".repeat(64),
          slotId: "slot-a",
          sourceNodeId: "node-source",
          order: 0
        }
      ]
    });

    expect(summary.inputs).toEqual([
      {
        role: "reference_image",
        mediaKind: "image",
        mediaType: "image/png",
        assetId: "asset-a",
        storageKey: "sha256-" + "a".repeat(64),
        slotId: "slot-a",
        sourceNodeId: "node-source",
        order: 0
      }
    ]);
    expect(JSON.stringify(summary)).not.toContain("http");
  });

  it("非法顺序与空 slot 被丢弃", () => {
    const summary = sanitizeRequest({
      prompt: "x",
      parameters: {},
      inputs: [
        {
          role: "reference_image",
          mediaType: "image/png",
          assetId: "asset-a",
          slotId: "",
          sourceNodeId: "node-source",
          order: -1
        }
      ]
    });
    expect(summary.inputs).toEqual([
      { role: "reference_image", mediaType: "image/png", assetId: "asset-a", sourceNodeId: "node-source" }
    ]);
  });
});
