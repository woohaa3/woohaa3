import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["shared-world-copy.test.ts"],
    setupFiles: ["../frontend/src/cordis/test-support/dom-setup.ts"],
    testTimeout: 15000
  }
});
