/**
 * 子进程 stdout / stderr → 宿主结构化日志（change: 2026-10-21-isolate-extension-host-process，D2）。
 *
 * 逐行切分；单行截断到 `logLineMaxBytes`；每秒最多 `logLinesPerSecond` 行，超出的行只计数，
 * 在下一个窗口开头补一条 `extension-host-log-dropped`，防止扩展用日志洪泛拖垮宿主。
 */
import type { Readable } from "node:stream";
import { EXTENSION_HOST_LIMITS } from "@woohaa3/contracts";

export type ChildLogOptions = {
  extensionId: string;
  instanceId: string;
  log: (event: Record<string, unknown>) => void;
  maxLineBytes?: number;
  linesPerSecond?: number;
  now?: () => number;
};

export type ChildLogSink = {
  /** 喂入一段原始输出（测试直接调用；生产由 attach 绑定到流）。 */
  write(stream: "stdout" | "stderr", chunk: Buffer | string): void;
  /** 冲刷残留的半行。 */
  flush(): void;
};

export function createChildLogSink(options: ChildLogOptions): ChildLogSink {
  const maxBytes = options.maxLineBytes ?? EXTENSION_HOST_LIMITS.logLineMaxBytes;
  const perSecond = options.linesPerSecond ?? EXTENSION_HOST_LIMITS.logLinesPerSecond;
  const now = options.now ?? Date.now;
  const partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  let windowStart = now();
  let emitted = 0;
  let dropped = 0;

  const emit = (stream: "stdout" | "stderr", line: string) => {
    const at = now();
    if (at - windowStart >= 1000) {
      if (dropped > 0) {
        options.log({ event: "extension-host-log-dropped", extension: options.extensionId, instanceId: options.instanceId, dropped });
      }
      windowStart = at;
      emitted = 0;
      dropped = 0;
    }
    if (emitted >= perSecond) {
      dropped += 1;
      return;
    }
    emitted += 1;
    const bytes = Buffer.byteLength(line);
    const text = bytes > maxBytes ? `${Buffer.from(line).subarray(0, maxBytes).toString("utf8")}…` : line;
    options.log({ event: "extension-host-output", extension: options.extensionId, instanceId: options.instanceId, stream, line: text });
  };

  const write = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
    const text = partial[stream] + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const lines = text.split(/\r?\n/);
    partial[stream] = lines.pop() ?? "";
    // 没有换行的超长输出也按上限切出，避免残留缓冲无限增长。
    if (Buffer.byteLength(partial[stream]) > maxBytes) {
      lines.push(partial[stream]);
      partial[stream] = "";
    }
    for (const line of lines) if (line.length > 0) emit(stream, line);
  };

  return {
    write,
    flush() {
      for (const stream of ["stdout", "stderr"] as const) {
        if (partial[stream]) emit(stream, partial[stream]);
        partial[stream] = "";
      }
    }
  };
}

export function attachChildLogs(sink: ChildLogSink, stdout: Readable | null, stderr: Readable | null): void {
  stdout?.on("data", (chunk: Buffer) => sink.write("stdout", chunk));
  stderr?.on("data", (chunk: Buffer) => sink.write("stderr", chunk));
  stdout?.once("end", () => sink.flush());
}
