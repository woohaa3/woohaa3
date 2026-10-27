import {defineConfig} from '@playwright/test';
const port=Number(process.env.BENCH_PORT??4398);
export default defineConfig({
 testDir:'./e2e',testMatch:/canvas-benchmark-supplement\.spec\.ts/,timeout:600000,
 fullyParallel:false,workers:1,retries:0,reporter:[['list']],
 use:{baseURL:`http://127.0.0.1:${port}`,viewport:{width:1440,height:900},deviceScaleFactor:1,headless:false,trace:'off',video:'off',screenshot:'off'},
 webServer:{command:`node e2e/server.mjs --port ${port} --dist frontend/dist-benchmark`,env:{E2E_BENCHMARK:'1'},url:`http://127.0.0.1:${port}/`,reuseExistingServer:process.env.BENCH_REUSE_SERVER==='1',timeout:60000,stdout:'pipe',stderr:'pipe'}
});
