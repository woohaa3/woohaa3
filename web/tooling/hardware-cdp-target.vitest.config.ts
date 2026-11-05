import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["hardware-cdp-target.test.ts"] } });
