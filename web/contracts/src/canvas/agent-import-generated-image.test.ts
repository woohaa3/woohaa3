/**
 * Agent 内部协议：生图产物导入请求解码
 * （change: 2026-11-03-add-codex-image-import）。
 *
 * 请求体只有 canvasId / requestId / index。路径由宿主从本轮登记表取用。
 */
import { describe, expect, it } from "vitest";
import { AGENT_INTERNAL_PATHS, decodeAgentImportGeneratedImageRequest } from "./agent-canvas-internal.js";

const PRINCIPAL = "principal-1";

describe("decodeAgentImportGeneratedImageRequest", () => {
  it("接受合法请求并注入 principal", () => {
    const result = decodeAgentImportGeneratedImageRequest(
      { canvasId: "c1", requestId: "r1", index: 0 },
      PRINCIPAL
    );
    expect(result).toMatchObject({
      ok: true,
      value: { principalId: PRINCIPAL, canvasId: "c1", requestId: "r1", index: 0 }
    });
  });

  it("index 省略时缺省为 0", () => {
    const result = decodeAgentImportGeneratedImageRequest(
      { canvasId: "c1", requestId: "r1" },
      PRINCIPAL
    );
    expect(result).toMatchObject({ ok: true, value: { index: 0 } });
  });

  it("拒绝负 index", () => {
    const result = decodeAgentImportGeneratedImageRequest(
      { canvasId: "c1", requestId: "r1", index: -1 },
      PRINCIPAL
    );
    expect(result).toMatchObject({ ok: false, code: "malformed-request" });
  });

  it("拒绝非整数 index", () => {
    const result = decodeAgentImportGeneratedImageRequest(
      { canvasId: "c1", requestId: "r1", index: 1.5 },
      PRINCIPAL
    );
    expect(result).toMatchObject({ ok: false, code: "malformed-request" });
  });

  it("拒绝调用方自报 savedPath", () => {
    const result = decodeAgentImportGeneratedImageRequest(
      { canvasId: "c1", requestId: "r1", savedPath: "/codex/generated_images/s/a.png" },
      PRINCIPAL
    );
    expect(result).toMatchObject({ ok: false, code: "malformed-request" });
  });

  it("拒绝未知字段", () => {
    const result = decodeAgentImportGeneratedImageRequest(
      { canvasId: "c1", requestId: "r1", extra: 1 },
      PRINCIPAL
    );
    expect(result).toMatchObject({ ok: false, code: "malformed-request" });
  });

  it("暴露内部路径常量", () => {
    expect(AGENT_INTERNAL_PATHS.importGeneratedImage).toBe("/internal/v2/agent-canvas/import-generated-image");
  });
});
