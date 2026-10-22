import { readFile } from "node:fs/promises";
import path from "node:path";

/** Paths are staged by the host adapter, never supplied by an HTTP client. */
export async function sdkImageBlocks(paths: readonly string[]) {
  return Promise.all(paths.map(async file => {
    const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as const)[path.extname(file).toLowerCase() as ".png"];
    if (!mimeType) throw new Error("助手不支持此图片格式");
    return { type: "image" as const, data: (await readFile(file)).toString("base64"), mimeType };
  }));
}
