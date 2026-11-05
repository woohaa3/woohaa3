import { test as base, expect, chromium } from "@playwright/test";

/** CDP attaches to a shared browser; Playwright creates and disposes each test context. */
export const test = process.env.WOOHAA_E2E_CDP ? base.extend({
  browser: async ({}, use) => {
    const endpoint = process.env.WOOHAA_E2E_CDP!;
    if (!process.env.E2E_BASE_URL) {
      throw new Error("WOOHAA_E2E_CDP requires an explicit E2E_BASE_URL");
    }
    const browser = await chromium.connectOverCDP(endpoint);
    try {
      await use(browser);
    } finally {
      await browser.close();
    }
  },
}) : base;

export { expect };
