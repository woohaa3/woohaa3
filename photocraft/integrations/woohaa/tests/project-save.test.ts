/**
 * 工程保存编排回归
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 4.1/4.3/4.5）。
 *
 * 覆盖：成对产物与摘要复核（不信任编辑器）、上传/回执失败不产生规范写入、引用保留。
 * 产物索引/manifest 解析随「React 直接调用内核」的重构删除；wasm 加载与命令门见
 * `editor-workspace.test.ts` / `editor-view-model.test.ts`。
 */
import { describe, expect, it } from "vitest";
import {
  IMAGE_PROJECT_CONTENT_TYPE,
  PHOTOCRAFT_ENGINE_VERSION,
  PHOTOCRAFT_ENGINE_COMMIT,
  type StoredAsset,
  type ImageProjectDocument
} from "@woohaa3/contracts";
import {
  saveImageProject,
  type ProjectSaveDeps,
  type UploadedObject
} from "../src/project-save.js";
import type { ProjectExportArtifacts } from "@woohaa3/photocraft-editor";

const PROJECT_SHA = "1".repeat(64);
const OUTPUT_SHA = "2".repeat(64);
const DOC_HASH = "aabbccddeeff0011";

function asset(): StoredAsset {
  return {
    id: "asset-base",
    title: "原图",
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: "2026-10-16T00:00:00.000Z"
  };
}

/** 摘要替身：按“内容标记”给出确定摘要，避免依赖 crypto。 */
function digestOf(bytes: Uint8Array): Promise<string> {
  const marker = String.fromCharCode(...bytes.slice(0, 1));
  return Promise.resolve(marker === "P" ? PROJECT_SHA : OUTPUT_SHA);
}

function artifacts(overrides: Partial<ProjectExportArtifacts> = {}): ProjectExportArtifacts {
  const base: ProjectExportArtifacts = {
    revision: 4,
    documentContentHash: DOC_HASH,
    canvasWidth: 800,
    canvasHeight: 600,
    project: new TextEncoder().encode("PROJECT-BYTES"),
    projectSummary: {
      role: "project",
      byteLength: 13,
      sha256: PROJECT_SHA,
      contentType: IMAGE_PROJECT_CONTENT_TYPE
    },
    output: new TextEncoder().encode("OUTPUT!"),
    outputSummary: { role: "output", byteLength: 7, sha256: OUTPUT_SHA, contentType: "image/png" }
  };
  return { ...base, ...overrides };
}

function uploaded(storageKey: string, contentType: string): UploadedObject {
  return { storageKey, checksum: "c".repeat(64), contentType, size: 7, url: `/media/${storageKey}` };
}

function deps(overrides: Partial<ProjectSaveDeps> = {}): ProjectSaveDeps {
  return {
    uploadProject: () => Promise.resolve(uploaded("project-key", IMAGE_PROJECT_CONTENT_TYPE)),
    uploadOutput: () => Promise.resolve(uploaded("output-key", "image/png")),
    complete: () =>
      Promise.resolve({
        ok: true,
        receipt: {
          requestId: "req-1",
          sessionId: "session-1",
          canvasId: "canvas-1",
          nodeId: "node-1",
          kind: "image",
          status: "completed",
          contentIdentity: "content-1",
          entryId: "entry-1",
          revision: 5,
          contentCommitted: true
        }
      }),
    assetIdFor: (checksum) => `asset-${checksum.slice(0, 4)}`,
    digest: digestOf,
    ...overrides
  };
}

function input(overrides: Partial<Parameters<typeof saveImageProject>[0]> = {}) {
  return {
    canvasId: "canvas-1",
    nodeId: "node-1",
    sessionId: "session-1",
    requestId: "req-1",
    baselineContentIdentity: "media:base-key",
    baseAsset: asset(),
    baseStorageKey: "base-key",
    baseChecksum: "d".repeat(64),
    baseContentType: "image/png",
    baseSize: 1024,
    artifacts: artifacts(),
    document: null,
    ...overrides
  };
}

describe("工程保存编排（任务 4.1/4.3/4.5）", () => {
  it("成对产物校验通过后上传两个对象并提交工程引用", async () => {
    let request: unknown = null;
    const outcome = await saveImageProject(
      input(),
      deps({
        complete: (value) => {
          request = value;
          return Promise.resolve({
            ok: true,
            receipt: {
              requestId: "req-1",
              sessionId: "session-1",
              canvasId: "canvas-1",
              nodeId: "node-1",
              kind: "image",
              status: "completed",
              contentIdentity: "content-1",
              entryId: "entry-1",
              revision: 5,
              contentCommitted: true
            }
          });
        }
      })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("completed");
    expect(outcome.project).toMatchObject({
      version: "woohaa-image-project-v1",
      engineVersion: PHOTOCRAFT_ENGINE_VERSION,
      formatVersion: 1,
      canvasWidth: 800,
      canvasHeight: 600,
      documentContentHash: DOC_HASH,
      project: { storageKey: "project-key", contentType: IMAGE_PROJECT_CONTENT_TYPE }
    });
    const media = (request as { media: Record<string, unknown> }).media;
    expect(media.canvasWidth).toBe(800);
    expect(media.project).toEqual(outcome.project.project);
    expect(media.imageEdit).toEqual(outcome.project);
  });

  it("history-pending 也算成功（内容已权威提交）", async () => {
    const outcome = await saveImageProject(
      input(),
      deps({
        complete: () =>
          Promise.resolve({
            ok: true,
            receipt: {
              requestId: "req-1",
              sessionId: "session-1",
              canvasId: "canvas-1",
              nodeId: "node-1",
              kind: "image",
              status: "history-pending",
              contentIdentity: "content-1",
              entryId: null,
              revision: 5,
              contentCommitted: true
            }
          })
      })
    );
    expect(outcome).toMatchObject({ ok: true, status: "history-pending", entryId: null });
  });

  it("缺少成对产物即拒绝，不产生任何写入", async () => {
    let uploads = 0;
    const outcome = await saveImageProject(
      input({ artifacts: artifacts({ outputSummary: { role: "project", byteLength: 7, sha256: OUTPUT_SHA, contentType: "image/png" } }) }),
      deps({
        uploadProject: () => {
          uploads += 1;
          return Promise.resolve(uploaded("project-key", IMAGE_PROJECT_CONTENT_TYPE));
        }
      })
    );
    expect(outcome).toMatchObject({ ok: false, code: "invalid-artifacts" });
    expect(uploads).toBe(0);
  });

  it("字节摘要与声明不符即拒绝（不信任编辑器上报）", async () => {
    const outcome = await saveImageProject(
      input(),
      deps({ digest: () => Promise.resolve("f".repeat(64)) })
    );
    expect(outcome).toMatchObject({ ok: false, code: "artifact-digest-mismatch", retriable: false });
  });

  it("工程上传失败时不提交 complete", async () => {
    let completes = 0;
    const outcome = await saveImageProject(
      input(),
      deps({
        uploadProject: () => Promise.resolve(null),
        complete: () => {
          completes += 1;
          return Promise.resolve({ ok: false, code: "x", error: "y" });
        }
      })
    );
    expect(outcome).toMatchObject({ ok: false, code: "project-upload-failed", retriable: true });
    expect(completes).toBe(0);
  });

  it("服务端冲突返回可重试失败并保留工程现场", async () => {
    const outcome = await saveImageProject(
      input(),
      deps({
        complete: () =>
          Promise.resolve({
            ok: false,
            code: "conflict",
            error: "内容已更新",
            receipt: {
              requestId: "req-1",
              sessionId: "session-1",
              canvasId: "canvas-1",
              nodeId: "node-1",
              kind: "image",
              status: "conflict",
              contentIdentity: "content-1",
              entryId: null,
              revision: 6,
              contentCommitted: false,
              errorCode: "EDIT_SESSION_CONFLICT",
              errorMessage: "内容已更新"
            }
          })
      })
    );
    expect(outcome).toMatchObject({ ok: false, code: "conflict", retriable: true });
  });

  it("保留既有工程的原图引用并加入当前基底（不丢对象）", async () => {
    const existing: ImageProjectDocument = {
      version: "woohaa-image-project-v1",
      engine: "photocraft",
      engineVersion: PHOTOCRAFT_ENGINE_COMMIT,
      formatVersion: 1,
      baseAssetId: "asset-base",
      sourceWidth: 2048,
      sourceHeight: 1536,
      canvasWidth: 800,
      canvasHeight: 600,
      documentContentHash: DOC_HASH,
      project: { storageKey: "old-key", checksum: "e".repeat(64), contentType: IMAGE_PROJECT_CONTENT_TYPE, size: 4096 },
      sourceAssetIds: ["asset-base", "asset-placed"]
    };
    const outcome = await saveImageProject(input({ document: existing }), deps());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.project.sourceWidth).toBe(2048);
    expect(outcome.project.engineVersion).toBe(PHOTOCRAFT_ENGINE_VERSION);
    expect([...outcome.project.sourceAssetIds].sort()).toEqual(["asset-base", "asset-placed"]);
  });
});

it("重试同一冻结请求复用上传对象，并保留新增置入素材引用", async () => {
  let projectUploads = 0, outputUploads = 0, completed = 0;
  const requests: unknown[] = [];
  const attempt = {};
  const dependencies = deps({
    uploadProject: async () => { projectUploads++; return uploaded("project-key", IMAGE_PROJECT_CONTENT_TYPE); },
    uploadOutput: async () => { outputUploads++; return uploaded("output-key", "image/png"); },
    complete: async (request) => { requests.push(request); completed++; if (completed === 1) throw new Error("回执丢失"); return deps().complete(request); }
  });
  const value = input({ sourceAssetIds: ["asset-extra", "asset-extra"] });
  expect(await saveImageProject(value, dependencies, attempt)).toMatchObject({ ok: false, retriable: true });
  const result = await saveImageProject(value, dependencies, attempt);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.project.sourceAssetIds).toEqual([value.baseAsset.id, "asset-extra"]);
  expect(projectUploads).toBe(1); expect(outputUploads).toBe(1);
  expect(requests[0]).toBe(requests[1]);
});

it("上传失败保留具体原因，拒绝提交并允许重试", async () => {
  let committed = false;
  const result = await saveImageProject(input(), deps({
    uploadProject: async () => { throw new Error("工程核验服务暂不可用"); },
    complete: async () => { committed = true; throw new Error("unexpected"); }
  }));
  expect(result).toEqual({ ok: false, code: "project-upload-failed", message: "工程对象上传失败：工程核验服务暂不可用", retriable: true });
  expect(committed).toBe(false);
});

it("保存进度只转发宿主上报的字节上传百分比：工程 0–50、输出 50–100", async () => {
  const seen: number[] = [];
  const dependencies = deps({
    uploadProject: async (_bytes, onProgress) => { onProgress?.(0); onProgress?.(50); onProgress?.(100); return uploaded("project-key", IMAGE_PROJECT_CONTENT_TYPE); },
    uploadOutput: async (_bytes, onProgress) => { onProgress?.(0); onProgress?.(100); return uploaded("output-key", "image/png"); },
    onProgress: (percent) => seen.push(percent)
  });
  const result = await saveImageProject(input(), dependencies);
  expect(result.ok).toBe(true);
  expect(seen).toEqual([0, 25, 50, 50, 100]);
});

it("宿主不提供上传进度时不产生任何百分比；重试复用的上传不重复报告", async () => {
  const seen: number[] = [];
  const silent = deps({
    uploadProject: async () => uploaded("project-key", IMAGE_PROJECT_CONTENT_TYPE),
    uploadOutput: async () => uploaded("output-key", "image/png"),
    onProgress: (percent) => seen.push(percent)
  });
  expect((await saveImageProject(input(), silent)).ok).toBe(true);
  expect(seen).toEqual([]);

  // 第一次提交失败但上传已成功：重试直接复用，不再报告进度。
  const attempt = {};
  const retried: number[] = [];
  let completed = 0;
  const flaky = deps({
    uploadProject: async (_bytes, onProgress) => { onProgress?.(100); return uploaded("project-key", IMAGE_PROJECT_CONTENT_TYPE); },
    uploadOutput: async () => uploaded("output-key", "image/png"),
    complete: async (request) => { completed++; if (completed === 1) throw new Error("回执丢失"); return deps().complete(request); },
    onProgress: (percent) => retried.push(percent)
  });
  expect((await saveImageProject(input(), flaky, attempt)).ok).toBe(false);
  retried.length = 0;
  expect((await saveImageProject(input(), flaky, attempt)).ok).toBe(true);
  expect(retried).toEqual([]);
});
