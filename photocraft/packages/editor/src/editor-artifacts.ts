/**
 * 冻结产物与摘要
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 4.1/4.3 / design D3/D6）。
 *
 * 内核的 `exportBundle()` 给出同一修订的 `.pcraft` 与 PNG 字节；本模块把它们连同 SHA-256 摘要
 * 组装成 `ProjectExportArtifacts`，交给 `saveImageProject` 复核后写回。摘要在这里算一次，保存编排
 * 再逐字节复算一次——不信任任何单侧声明。
 */
import { failureFrom, type EditorFailure, type EditorHandle, type EditorResult } from "./editor-wasm.js";
import type { PhotocraftArtifactSummary } from "@woohaa3/photocraft-protocol";
import { IMAGE_PROJECT_CONTENT_TYPE } from "@woohaa3/photocraft-protocol";

/** 一次冻结得到的成对产物与声明。 */
export type ProjectExportArtifacts = {
  revision: number;
  documentContentHash: string;
  canvasWidth: number;
  canvasHeight: number;
  project: Uint8Array;
  projectSummary: PhotocraftArtifactSummary;
  output: Uint8Array;
  outputSummary: PhotocraftArtifactSummary;
};

/** 摘要实现（缺省 `crypto.subtle`；测试注入）。 */
export type ArtifactDigest = (bytes: Uint8Array) => Promise<string>;

/**
 * 冻结当前修订：调用内核 `exportBundle()` 并计算两个摘要。
 *
 * 内核调用是同步的，因此修订、指纹、尺寸与两份字节必然来自同一文档状态。
 */
export async function freezeProjectArtifacts(
  handle: EditorHandle,
  digest: ArtifactDigest = defaultDigest
): Promise<EditorResult<ProjectExportArtifacts>> {
  const bundle = handle.exportBundle();
  if (!bundle.ok) return bundle;
  const { revision, documentContentHash, canvasWidth, canvasHeight, project, output } = bundle.value;
  try {
    const [projectDigest, outputDigest] = await Promise.all([digest(project), digest(output)]);
    return {
      ok: true,
      value: {
        revision: Number(revision),
        documentContentHash,
        canvasWidth,
        canvasHeight,
        project,
        projectSummary: {
          role: "project",
          byteLength: project.byteLength,
          sha256: projectDigest,
          contentType: IMAGE_PROJECT_CONTENT_TYPE
        },
        output,
        outputSummary: { role: "output", byteLength: output.byteLength, sha256: outputDigest, contentType: "image/png" }
      }
    };
  } catch (error) {
    return failureFrom(error, "artifact-digest-mismatch", "无法计算冻结产物摘要") as EditorFailure;
  }
}

async function defaultDigest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("缺少 SHA-256 实现");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
