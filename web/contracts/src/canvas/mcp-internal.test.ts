/**
 * 内部 MCP 协议解码器契约测试
 * （change: split-model-mcp-into-mcp-service；
 *  change: 2026-10-07-remove-residual-compatibility —— canvasId 必填）。
 *
 * 调用方与服务端共享同一份 codec；这里固定请求解码的稳定错误码与 actor 不入参不变式。
 */
import { describe, expect, it } from "vitest";
import {
  decodeMcpApplyCommandsRequest,
  decodeMcpCreateFilmSetNodeRequest,
  decodeMcpGetNodeRequest,
  decodeMcpModelStatisticsRequest,
  decodeMcpImportModelSnapshotRequest,
  decodeMcpImportFilmSetContentRequest,
  decodeMcpListNodesRequest,
  decodeMcpMutateCamerasRequest,
  decodeMcpRenderPreviewRequest,
  decodeMcpSubmitScriptRequest
} from "./mcp-internal.js";

describe("MCP 内部协议解码器", () => {
  it("listNodes 要求 canvasId", () => {
    expect(decodeMcpListNodesRequest({ canvasId: "c" })).toEqual({ ok: true, value: { canvasId: "c" } });
    expect(decodeMcpListNodesRequest({}).ok).toBe(false);
    expect(decodeMcpListNodesRequest({ canvasId: 1 }).ok).toBe(false);
  });

  it("getNode 要求 canvasId 与 nodeId，并可请求附带统计", () => {
    expect(decodeMcpGetNodeRequest({ canvasId: "c", nodeId: "n" })).toEqual({ ok: true, value: { canvasId: "c", nodeId: "n" } });
    expect(decodeMcpGetNodeRequest({ canvasId: "c" }).ok).toBe(false);
    expect(decodeMcpGetNodeRequest({ nodeId: "n" }).ok).toBe(false);
    expect(decodeMcpGetNodeRequest({ canvasId: "c", nodeId: "n", includeStatistics: true }))
      .toEqual({ ok: true, value: { canvasId: "c", nodeId: "n", includeStatistics: true } });
    expect(decodeMcpGetNodeRequest({ canvasId: "c", nodeId: "n", includeStatistics: "yes" }).ok).toBe(false);
  });

  it("modelStatistics 接受可选候选源码并拒绝空白", () => {
    expect(decodeMcpModelStatisticsRequest({ canvasId: "c", nodeId: "n" }))
      .toEqual({ ok: true, value: { canvasId: "c", nodeId: "n" } });
    expect(decodeMcpModelStatisticsRequest({ canvasId: "c", nodeId: "n", source: "scene.box({});" }))
      .toEqual({ ok: true, value: { canvasId: "c", nodeId: "n", source: "scene.box({});" } });
    expect(decodeMcpModelStatisticsRequest({ canvasId: "c", nodeId: "n", source: "  " }).ok).toBe(false);
    expect(decodeMcpModelStatisticsRequest({ canvasId: "c" }).ok).toBe(false);
  });

  it("submitScript 校验 canvasId、非空源码与可选版本", () => {
    const decoded = decodeMcpSubmitScriptRequest({ canvasId: "c", nodeId: "n", source: "scene.box({});", version: "woohaa-model-js-v2" });
    expect(decoded).toEqual({
      ok: true,
      value: { canvasId: "c", nodeId: "n", source: "scene.box({});", version: "woohaa-model-js-v2" }
    });
    expect(decodeMcpSubmitScriptRequest({ nodeId: "n", source: "x" }).ok).toBe(false);
    expect(decodeMcpSubmitScriptRequest({ canvasId: "c", nodeId: "n", source: "  " }).ok).toBe(false);
  });

  it("renderPreview 只接受受限字段且拒绝非有限数值", () => {
    expect(decodeMcpRenderPreviewRequest({ canvasId: "c", nodeId: "n", width: 256 })).toEqual({
      ok: true,
      value: { canvasId: "c", nodeId: "n", width: 256 }
    });
    expect(decodeMcpRenderPreviewRequest({ canvasId: "c", nodeId: "n", width: Number.NaN }).ok).toBe(false);
  });

  it("applyCommands 要求 canvasId、稳定 commandId、非负 baseRevision 与非空命令", () => {
    const decoded = decodeMcpApplyCommandsRequest({
      canvasId: "c",
      commandId: "cmd",
      baseRevision: 0,
      commands: [{ type: "canvas.setTitle", title: "t" }]
    });
    expect(decoded.ok).toBe(true);
    expect(decodeMcpApplyCommandsRequest({ canvasId: "c", commandId: "cmd", baseRevision: -1, commands: [{ type: "canvas.setTitle", title: "t" }] }).ok).toBe(false);
    expect(decodeMcpApplyCommandsRequest({ canvasId: "c", commandId: "cmd", baseRevision: 0, commands: [] }).ok).toBe(false);
  });

  it("请求 DTO 不携带 actorId（来源由服务端派生）", () => {
    const decoded = decodeMcpApplyCommandsRequest({
      canvasId: "c",
      commandId: "cmd",
      baseRevision: 0,
      actorId: "spoofed",
      commands: [{ type: "canvas.setTitle", title: "t" }]
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect((decoded.value as Record<string, unknown>).actorId).toBeUndefined();
  });

  it("mutateCameras 解码 create 并保留 aspect/focusOffset", () => {
    const decoded = decodeMcpMutateCamerasRequest({
      canvasId: "c",
      nodeId: "m1",
      requestId: "r1",
      mutation: { kind: "create", azimuth: 0.5, distance: 3, elevation: 0.25, aspect: "1:1", focusOffset: { x: 1, y: 2, z: 3 } }
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.mutation).toEqual({
      kind: "create",
      azimuth: 0.5,
      distance: 3,
      elevation: 0.25,
      aspect: "1:1",
      focusOffset: { x: 1, y: 2, z: 3 }
    });
  });

  it("mutateCameras 解码 update/remove/rename/reset", () => {
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "update", id: "c1", distance: 5 } }).ok).toBe(true);
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "remove", id: "c1" } }).ok).toBe(true);
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "rename", id: "c1", name: "正面" } }).ok).toBe(true);
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "reset", id: "c1", azimuth: 0, distance: 3 } }).ok).toBe(true);
  });

  it("mutateCameras 在触碰画布前拒绝非法结构", () => {
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "explode" } }).ok).toBe(false);
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "create", azimuth: Number.NaN, distance: 1 } }).ok).toBe(false);
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "create", azimuth: 0, distance: 1, elevation: Number.NaN } }).ok).toBe(false);
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "update", id: "c1", aspect: "7:3" } }).ok).toBe(false);
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "rename", id: "c1", name: "" } }).ok).toBe(false);
    expect(decodeMcpMutateCamerasRequest({ canvasId: "c", nodeId: "m1", requestId: "r", mutation: { kind: "reset", id: "c1" } }).ok).toBe(false);
  });

  it("createFilmSetNode 解码来源说明、摆放与时间线（change: 2026-10-05-bind-model-animation-to-shots）", () => {
    const decoded = decodeMcpCreateFilmSetNodeRequest({
      canvasId: "canvas-1",
      nodeId: "anim-1",
      requestId: "req-1",
      title: "走路",
      model: {
        modelScript: "function build() { return 1; }",
        modelScriptVersion: "woohaa-model-js-v2",
        placement: { offset: { x: 1, y: 2, z: 3 }, scale: 2, yaw: 0.5 }
      },
      sourceNodeId: "model-7",
      motionScript: "function motion() {}",
      timeline: { duration: 4, loop: true }
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toMatchObject({
      canvasId: "canvas-1",
      nodeId: "anim-1",
      sourceNodeId: "model-7",
      model: { modelScriptVersion: "woohaa-model-js-v2", placement: { scale: 2, yaw: 0.5 } },
      timeline: { duration: 4, loop: true }
    });
  });

  it("createFilmSetNode 在触碰画布前拒绝非法结构", () => {
    expect(decodeMcpCreateFilmSetNodeRequest({ canvasId: "c", nodeId: "a", requestId: "r" }).ok).toBe(false);
    expect(decodeMcpCreateFilmSetNodeRequest({ canvasId: "c", nodeId: "a", requestId: "r", model: { modelScript: "", modelScriptVersion: "v2" } }).ok).toBe(false);
    expect(decodeMcpCreateFilmSetNodeRequest({ canvasId: "c", nodeId: "a", requestId: "r", model: { modelScript: "x" } }).ok).toBe(false);
    expect(
      decodeMcpCreateFilmSetNodeRequest({ canvasId: "c", nodeId: "a", requestId: "r", model: { modelScript: "x", modelScriptVersion: "v2" }, timeline: { duration: 1 } }).ok
    ).toBe(false);
    expect(
      decodeMcpCreateFilmSetNodeRequest({ canvasId: "c", nodeId: "a", requestId: "r", model: { modelScript: "x", modelScriptVersion: "v2" }, position: { x: Number.NaN, y: 0 } }).ok
    ).toBe(false);
  });

  it("importModelSnapshot 要求 itemId 与非空源码并保留可选 precondition", () => {
    const decoded = decodeMcpImportModelSnapshotRequest({
      canvasId: "c",
      nodeId: "anim-1",
      itemId: "actor",
      requestId: "req-1",
      modelScript: "function build() { return 1; }",
      modelScriptVersion: "woohaa-model-js-v2",
      expectedSourceHash: "hash-1"
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.expectedSourceHash).toBe("hash-1");
    expect(decodeMcpImportModelSnapshotRequest({ canvasId: "c", nodeId: "a", itemId: "i", requestId: "r", modelScript: "", modelScriptVersion: "v2" }).ok).toBe(false);
    expect(decodeMcpImportModelSnapshotRequest({ canvasId: "c", nodeId: "a", itemId: "i", requestId: "r", modelScript: "x", modelScriptVersion: "" }).ok).toBe(false);
    // items-only：必须给出 itemId 目标。
    expect(decodeMcpImportModelSnapshotRequest({ canvasId: "c", nodeId: "a", requestId: "r", modelScript: "x", modelScriptVersion: "woohaa-model-js-v2" }).ok).toBe(false);
  });

  it("importFilmSetContent 只接受三种来源，拒绝文本/音频并保留视频时长", () => {
    const ok = decodeMcpImportFilmSetContentRequest({
      canvasId: "c",
      nodeId: "film",
      requestId: "req-1",
      items: [
        { kind: "model", itemId: "m", name: "模型", sourceNodeId: "model" },
        { kind: "image", itemId: "i", name: "图", sourceNodeId: "img", assetId: "a", aspectRatio: 2 },
        { kind: "video", itemId: "v", name: "视", sourceNodeId: "vid", assetId: "b", aspectRatio: 1.5, durationSeconds: 12 }
      ]
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.items).toHaveLength(3);
    const video = ok.value.items[2];
    expect(video?.kind === "video" && video.durationSeconds).toBe(12);
    // 文本/音频不在允许集合，整批拒绝。
    expect(decodeMcpImportFilmSetContentRequest({ canvasId: "c", nodeId: "film", requestId: "r", items: [{ kind: "audio", itemId: "x", name: "音", sourceNodeId: "a" }] }).ok).toBe(false);
    expect(decodeMcpImportFilmSetContentRequest({ canvasId: "c", nodeId: "film", requestId: "r", items: [{ kind: "text", itemId: "x", name: "文", sourceNodeId: "a" }] }).ok).toBe(false);
    // 重复对象 id 拒绝。
    expect(decodeMcpImportFilmSetContentRequest({ canvasId: "c", nodeId: "film", requestId: "r", items: [
      { kind: "image", itemId: "dup", name: "图", sourceNodeId: "img", assetId: "a", aspectRatio: 1 },
      { kind: "image", itemId: "dup", name: "图", sourceNodeId: "img", assetId: "a", aspectRatio: 1 }
    ] }).ok).toBe(false);
  });
});
