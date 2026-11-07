import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 不少用例要启动整套带 SQLite 的后端宿主（单条 8~12s 在 Windows / 慢机器上很常见），
    // 默认 5s 会把「机器慢」报成失败。真正卡死仍会被这个上限抓到。
    testTimeout: 30_000,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"]
  }
});
