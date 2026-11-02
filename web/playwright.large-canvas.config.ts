import { defineConfig } from '@playwright/test';
import { reviewBaseUrl, reviewProbeUrl, reviewUseOptions, reviewWebServerEnv, reviewWebServerIgnoreHTTPSErrors } from './e2e/review-target.js';
const port = Number(process.env.BENCH_PORT ?? 4397);
export default defineConfig({
  testDir: './e2e', testMatch: /canvas-large-benchmark\.spec\.ts/,
  timeout: 240_000, fullyParallel: false, workers: 1, retries: 0,
  reporter: [['list']],
  use: {...reviewUseOptions, baseURL: reviewBaseUrl(port), viewport: {width:1440,height:900}, deviceScaleFactor:1,
    headless:false, trace:'off', video:'off', screenshot:'off',
    launchOptions: {args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-renderer-backgrounding']}},
  webServer: {ignoreHTTPSErrors: reviewWebServerIgnoreHTTPSErrors, command:`node e2e/server.mjs --port ${port} --dist frontend/dist-benchmark`,env:reviewWebServerEnv,
    url:reviewProbeUrl(port),reuseExistingServer:process.env.BENCH_REUSE_SERVER==='1',timeout:60_000,stdout:'pipe',stderr:'pipe'}
});
