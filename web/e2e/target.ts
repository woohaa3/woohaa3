import type { PlaywrightTestConfig } from "@playwright/test";

type WebServer = NonNullable<PlaywrightTestConfig["webServer"]>;

/** Explicit external targets never start or reuse a local server. */
export function webTarget(options: { port: number; server: WebServer }) {
  const baseURL = process.env.E2E_BASE_URL;
  if (process.env.WOOHAA_E2E_CDP && !baseURL) {
    throw new Error("WOOHAA_E2E_CDP requires an explicit E2E_BASE_URL");
  }
  if (baseURL) {
    const url = new URL(baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("E2E_BASE_URL must use HTTP or HTTPS");
    }
    return { baseURL: url.href, webServer: undefined };
  }
  return { baseURL: `http://127.0.0.1:${options.port}`, webServer: options.server };
}
