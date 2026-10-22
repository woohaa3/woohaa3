/** Private local files shared by the trusted host and desktop supervisor. */
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ContentRecordingSnapshot } from "@woohaa3/contracts";

/**
 * 本次 attempt 的私有目录。
 *
 * `runtimeDirectory` 是宿主实例目录（`woohaa3-recording/<checkoutId>`），不能从 socketPath
 * 推导：Windows 的 socketPath 是命名管道，`dirname` 会得到 `\\.\pipe`。
 */
export function recordingAttemptDirectory(runtimeDirectory: string, attemptId: string): string {
  const safe = attemptId.replace(/[^a-zA-Z0-9_-]/g, "_") || "attempt";
  return join(runtimeDirectory, "attempts", safe);
}

export async function stageRecordingResources(input: {
  directory: string;
  snapshot: ContentRecordingSnapshot;
  signal: AbortSignal;
  /**
   * 素材读取端口。第二个参数是**快照冻结时的画布 id**（`snapshot.origin.canvasId`）：
   * 远端画布的素材只在托管存储 `<canvasId>/media/<key>` 里，丢了作用域就会去主存储找而失败。
   */
  read?: (storageKey: string, canvasId?: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
}): Promise<void> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  let total = 0;
  for (const [index, resource] of input.snapshot.resources.entries()) {
    input.signal.throwIfAborted();
    if (!input.read) throw new Error("录制素材读取端口未装配");
    const media = await input.read(resource.storageKey, input.snapshot.origin.canvasId);
    input.signal.throwIfAborted();
    total += media.bytes.byteLength;
    if (total > 512 * 1024 * 1024 || media.bytes.byteLength > 256 * 1024 * 1024) throw new Error("录制素材超过预算");
    if (media.bytes.byteLength !== resource.sizeBytes || media.contentType !== resource.contentType ||
        createHash("sha256").update(media.bytes).digest("hex") !== resource.checksum) {
      throw new Error(`录制素材与冻结身份不符：${resource.resourceId}`);
    }
    await writeFile(join(input.directory, `resource-${index}.bin`), media.bytes, { mode: 0o600, flag: "wx" });
  }
}

export async function removeRecordingAttempt(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
