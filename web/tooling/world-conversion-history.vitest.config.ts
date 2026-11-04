import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({ test: { root: fileURLToPath(new URL(".", import.meta.url)), include: ["world-conversion-history.test.ts", "world-conversion-frontend-history.test.ts"], testTimeout: 30000 } });
