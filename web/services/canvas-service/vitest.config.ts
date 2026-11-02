import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Canvas Script 的每个 realm 都在独立的 QuickJS Worker 里执行，测试文件并跑时会同时占用
    // 多个线程与各自的堆预算。默认的文件级并行度在 14 核机器上会让这些用例互相饿死（Worker
    // 冷启动就超过默认 5s 超时），因此本包按文件串行执行；全量仍在 1 分钟内完成。
    fileParallelism: false
  }
});
