import { createHash } from "node:crypto";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { WorkflowError, type Artifact } from "../../state/shared/workflow.js";
/** 读取实际返回文件，不把请求画幅当作生成结果尺寸。 */
export async function inspectImage(services: ApplicationExtensionServices, artifact: Artifact, expectedAspect: number, canvasId?: string): Promise<{ width: number; height: number; checksum: string; warningCodes:string[] }> {
  if (!services.media.resources || !artifact.storageKey) throw new WorkflowError("media-read-unavailable", "无法读取图片内容进行确定性检查。");
  const { bytes } = await services.media.resources.read(artifact.storageKey, canvasId);
  const buffer = Buffer.from(bytes), checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== artifact.checksum) throw new WorkflowError("image-check-failed", "图片内容与任务返回的校验值不匹配。");
  let width = 0, height = 0;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20); }
  else if (buffer.length > 4 && buffer[0] === 255 && buffer[1] === 216) {
    let position = 2;
    while (position + 8 < buffer.length) {
      if (buffer[position++] !== 255) break;
      while (buffer[position] === 255) position++;
      const marker = buffer[position++];
      if (marker === 217 || marker === 218) break;
      const length = buffer.readUInt16BE(position);
      if (length < 2 || position + length > buffer.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker!)) { height = buffer.readUInt16BE(position + 3); width = buffer.readUInt16BE(position + 5); break; }
      position += length;
    }
  }
  if (!width || !height) throw new WorkflowError("image-check-unavailable", "图片格式尚不支持尺寸检查；请配置返回 PNG 或 JPEG 的制作模型。");
  const warningCodes=Math.abs(width / height - expectedAspect) / expectedAspect > .05?["identity_aspect_mismatch"]:[];
  return { width, height, checksum, warningCodes };
}
