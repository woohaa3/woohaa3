import type { PlaywrightTestConfig } from "@playwright/test";

type WebServer = NonNullable<PlaywrightTestConfig["webServer"]>;

/** Explicit external targets never start or reuse a local server. */
export function webTarget(options: { port: number; server: WebServer }) {
  const baseURL = process.env.E2E_BASE_URL;
  if (process.env.WOOHAA_E2E_CDP && !baseURL) {
    throw new Error("WOOHAA_E2E_CDP requires an explicit E2E_BASE_URL");
  }
  if (baseURL !== undefined) {
    let url: URL;
    try { url = new URL(baseURL); } catch { throw new Error("E2E_BASE_URL must be an absolute HTTP or HTTPS URL"); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error("E2E_BASE_URL must be an HTTP or HTTPS URL without credentials, query or fragment");
    }
    return { baseURL: url.href, webServer: undefined };
  }
  return { baseURL: `http://127.0.0.1:${options.port}`, webServer: options.server };
}
