import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["assistant-camera-atomic-recovery.test.ts"],
    testTimeout: 120000
  }
});
