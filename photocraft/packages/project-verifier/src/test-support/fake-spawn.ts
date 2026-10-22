/**
 * 假核验进程夹具（change: 2026-10-21-extract-photocraft-subproject，任务 3.1）。
 *
 * 回归要验证适配器的**进程纪律**（参数数组形态、字节只走 stdin、超时/限输出/并发），但测试
 * 不能依赖真实 Rust 二进制。迁移前用「写一个 `#!/usr/bin/env node` 脚本 + chmod」的做法，在
 * POSIX 上可用、在 Windows 上 `spawn` 直接 ENOENT；而用 `.cmd` 包装又需要 `shell: true`，
 * 正是被测约束要禁止的。
 *
 * 因此这里改为**在进程内模拟子进程**：`createFakeSpawn()` 返回一个符合 `SpawnLike` 的替身，
 * 把待执行的命令/参数记下来，并异步按内容前缀产出 stdout 或错误。这样：
 * - 参数数组形态与 `--embedded-smart` 传递可以被**直接断言**（不依赖任何平台可执行文件）；
 * - 超时、输出越界、并发排队等真实时序仍由适配器自身的实现决定（替身只负责「慢慢产出」）；
 * - 不产生真实子进程，测试可在 Windows/CI 上稳定运行。
 *
 * 真正 spawn 真实二进制的端到端验证由部署环境用 `scripts/build-verifier.mjs` 产出的原生工具
 * 做（见 verification.md 的「待人工验证」与 8.1 的核验步骤）。
 */
import type { SpawnLike } from "../native-project-verifier.js";

export type FakeSpawnCall = {
  command: string;
  args: readonly string[];
  bytes: Uint8Array | null;
};

export type FakeSpawnBehaviour =
  | {
      /** 成功：输出一段 JSON（`--embedded-smart` 时按同一 payload 返回）。 */
      output: string;
    }
  | {
      /** 启动失败：触发 `error` 事件（模拟工具缺失）。 */
      failToSpawn: string;
    }
  | {
      /** 延迟 `delayMs` 后再输出（用于并发与超时用例）。 */
      output: string;
      delayMs: number;
    }
  | {
      /** 输出超过上限的字节流（用于限输出用例）。 */
      floodBytes: number;
    };

/**
 * 创建一个可注入 `NativeProjectVerifierOptions.spawnImpl` 的假 spawn。
 *
 * `behaviour` 可以是固定一种，或按 stdin 内容前缀决定（与迁移前假工具的约定一致）。
 */
export function createFakeSpawn(
  behaviour: FakeSpawnBehaviour | ((call: FakeSpawnCall) => FakeSpawnBehaviour)
): { spawnImpl: SpawnLike; calls: FakeSpawnCall[]; inflight: () => number } {
  const calls: FakeSpawnCall[] = [];
  const pending = new Set<() => void>();

  const spawnImpl: SpawnLike = (command, args, options) => {
    if (options.stdio.join(",") !== "pipe,pipe,pipe") {
      throw new Error(`适配器必须以三路 pipe 启动子进程，实际为 ${JSON.stringify(options.stdio)}`);
    }
    const call: FakeSpawnCall = { command, args: [...args], bytes: null };
    calls.push(call);

    const stdoutListeners: Array<(chunk: Buffer) => void> = [];
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const errorListeners: Array<(error: Error) => void> = [];
    const closeListeners: Array<(code: number | null) => void> = [];
    const stdinErrorListeners: Array<() => void> = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const emitStdout = (text: string) => {
      const buffer = Buffer.from(text, "utf8");
      for (const listener of stdoutListeners) listener(buffer);
    };
    const emitClose = (code: number) => {
      for (const listener of closeListeners) listener(code);
    };

    const settle = (delayMs: number, action: () => void) => {
      const release = () => {
        pending.delete(release);
        action();
      };
      pending.add(release);
      timers.push(setTimeout(release, delayMs));
    };

    return {
      stdout: {
        on(_event, listener) {
          stdoutListeners.push(listener);
          return undefined;
        }
      },
      stderr: {
        on(_event, listener) {
          stderrListeners.push(listener);
          return undefined;
        }
      },
      stdin: {
        on(_event, listener) {
          stdinErrorListeners.push(listener);
          return undefined;
        },
        end(chunk?: Uint8Array) {
          if (chunk) call.bytes = Uint8Array.from(chunk);
          const resolved = typeof behaviour === "function" ? behaviour(call) : behaviour;
          if ("failToSpawn" in resolved) {
            settle(0, () => {
              for (const listener of errorListeners) listener(new Error(resolved.failToSpawn));
            });
            return undefined;
          }
          if ("floodBytes" in resolved) {
            settle(0, () => {
              emitStdout("x".repeat(resolved.floodBytes));
              emitClose(0);
            });
            return undefined;
          }
          settle("delayMs" in resolved ? resolved.delayMs : 0, () => {
            emitStdout(resolved.output);
            emitClose(0);
          });
          return undefined;
        }
      },
      on(event: string, listener: never) {
        if (event === "error") errorListeners.push(listener as unknown as (error: Error) => void);
        if (event === "close") closeListeners.push(listener as unknown as (code: number | null) => void);
        return undefined;
      },
      kill() {
        for (const timer of timers.splice(0)) clearTimeout(timer);
        // SIGKILL 后真实进程会 close；替身只保证不再产出。
        return undefined;
      }
    };
  };

  return { spawnImpl, calls, inflight: () => pending.size };
}

/** 便捷：假的「工程核验成功」摘要，形状与 `ProjectVerificationSummary` 一致。 */
export function fakeSummary(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    generator: "fake",
    canvasWidth: 64,
    canvasHeight: 48,
    layerCount: 3,
    depth: 1,
    entryCount: 5,
    decompressedBytes: 4096,
    objectKinds: ["adjustment", "raster"],
    ...overrides
  };
}
