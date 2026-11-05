import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentImageInput } from "@woohaa3/contracts";

/**
 * 候选生成能力声明（change: 2026-10-22-remove-agent-execution-limits，任务 7.1）。
 *
 * `maxImages`/`maxFrames` 在这里表达助手引擎的**真实输入组织能力**（一次请求可承载的图/帧
 * 数量），不是应用可拒绝合法工作的执行额度；400 万像素的应用自造门禁已删除。
 */
export const ASSISTANT_CANDIDATE_CAPABILITIES = { imageInput: true, maxImages: 12 } as const;

/** Only runtimes requiring local image paths materialize bytes; cleanup covers failure/cancellation. */
export async function withAgentImageFiles<T>(images: readonly AgentImageInput[], run: (files: string[]) => Promise<T>): Promise<T> {
  if (!images.length) return run([]);
  const root = await mkdtemp(path.join(tmpdir(), "woohaa-agent-images-"));
  try {
    const files = await Promise.all(images.map(async (image, index) => {
      const extension = image.contentType === "image/jpeg" ? "jpg" : image.contentType === "image/webp" ? "webp" : image.contentType === "image/gif" ? "gif" : "png";
      const file = path.join(root, `${index}.${extension}`);
      await writeFile(file, image.bytes, { mode: 0o600 });
      return file;
    }));
    return await run(files);
  } finally {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("woohaa-agent-images-")) throw new Error("Invalid temporary image directory");
    await rm(root, { recursive: true, force: true });
  }
}
