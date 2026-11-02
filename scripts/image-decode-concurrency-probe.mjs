#!/usr/bin/env node
// 图片解码并发探针：只测 CPU 解码吞吐，不打开应用渲染器、不采样 GPU。
//
// 用法（先 `pnpm dev:frontend`，任一 dev 页面 URL 即可，探针会换成一个空白页）：
//   node scripts/image-decode-concurrency-probe.mjs http://localhost:5510/dev/<canvasId>/
//
// 它导入真实的 `image-worker/client.ts`（因此走与产品一致的 Worker 池、ABI 与页面侧读取
// 路径），在页内用 OffscreenCanvas 生成不重复的 PNG，然后按 1/2/4/6 个实例分别解码同一批
// 作业，输出每档的吞吐。目标是把「并发是否真的换来吞吐」变成可复现数据；真实设备上的帧率、
// 长尾与内存结论仍须在真实 GPU 机器上采集。
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/image-decode-concurrency-probe.mjs <frontend dev URL>");
const base = new URL(input);
if (!base.pathname.endsWith("/")) base.pathname += "/";

const LEVELS = [1, 2, 4, 6];
const TARGET_EDGE = 512;
const SOURCE_EDGES = [1024, 4096];
const JOBS_PER_INSTANCE = 4;
/** 每种源尺寸的不同负载数：避免 URL/缓存/共享内容把并发作业合并成一份。 */
const PAYLOADS = 4;

const browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // 同源空白页：复用 dev server 的模块解析，但不初始化 Bevy（无 GPU 环境也能跑）。
  await page.route("**/image-cpu-probe", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: "<!doctype html><title>Image decode concurrency probe</title>",
      contentType: "text/html"
    });
  });
  await page.goto(new URL("image-cpu-probe", base).href);

  const rows = await page.evaluate(async ({ clientUrl, levels, targetEdge, sourceEdges, jobsPerInstance, payloadCount }) => {
    const { ImageWorkerPool } = await import(clientUrl);

    /** 页内生成不压缩的噪声 PNG：每次内容不同，不会被共享缓存折叠成一次解码。 */
    async function makePng(size, salt) {
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext("2d");
      const image = context.createImageData(size, size);
      for (let index = 0; index < image.data.length; index += 4) {
        const pixel = index / 4 + salt * 977;
        image.data[index] = (pixel * 7) & 255;
        image.data[index + 1] = (pixel * 13) & 255;
        image.data[index + 2] = (pixel * 29) & 255;
        image.data[index + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
    }

    const out = [];
    for (const sourceEdge of sourceEdges) {
      const payloads = [];
      for (let index = 0; index < payloadCount; index += 1) payloads.push(await makePng(sourceEdge, index));
      const urls = payloads.map((payload) => URL.createObjectURL(new Blob([payload], { type: "image/png" })));
      // 每个 URL 对应一份可再次读取的字节；transfer 会 detach，所以每次作业复制一份。
      const sources = await Promise.all(urls.map(async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer())));

      for (const concurrency of levels) {
        const pool = new ImageWorkerPool(concurrency);
        const jobs = concurrency * jobsPerInstance;
        let failures = 0;
        let peakMemoryBytes = 0;
        try {
          // 预热一个作业（模块编译 + 实例启动），不计入吞吐。
          const warm = new Uint8Array(sources[0]).buffer;
          await pool.decode(urls[0], targetEdge, undefined, false, undefined, warm);
          const started = performance.now();
          let next = 0;
          await Promise.all(Array.from({ length: concurrency }, async () => {
            for (;;) {
              const index = next++;
              if (index >= jobs) return;
              const slot = index % sources.length;
              // 复制一份：postMessage 的 transfer 会 detach 原缓冲。
              const bytes = new Uint8Array(sources[slot]).buffer;
              try {
                const result = await pool.decode(urls[slot], targetEdge, undefined, false, undefined, bytes);
                peakMemoryBytes = Math.max(peakMemoryBytes, result.memoryBytes ?? 0);
              } catch { failures += 1; }
            }
          }));
          const elapsed = performance.now() - started;
          out.push({
            sourceEdge,
            targetEdge,
            concurrency,
            jobs,
            elapsedMs: Math.round(elapsed),
            perImageMs: Number((elapsed / jobs).toFixed(1)),
            imagesPerSecond: Number((1000 / (elapsed / jobs)).toFixed(2)),
            peakWasmBytes: peakMemoryBytes,
            failures
          });
        } finally {
          pool.dispose();
          for (const url of urls) URL.revokeObjectURL(url);
        }
      }
    }
    return { isolated: crossOriginIsolated, rows: out };
  }, {
    clientUrl: new URL("src/cordis/plugins/canvas-runtime/image-worker/client.ts", base).href,
    levels: LEVELS,
    targetEdge: TARGET_EDGE,
    sourceEdges: SOURCE_EDGES,
    jobsPerInstance: JOBS_PER_INSTANCE,
    payloadCount: PAYLOADS
  });

  if (errors.length) throw new Error(JSON.stringify({ errors }));
  console.log(JSON.stringify({
    kind: "CPU decode only (no renderer, no GPU sampling)",
    note: "Threaded compute Workers follow VITE_WOOHAA_IMAGE_THREADS; default build measures the single-thread Worker.",
    browser: await browser.version(),
    targetEdge: TARGET_EDGE,
    levels: LEVELS,
    isolated: rows.isolated,
    rows: rows.rows
  }, null, 2));
} finally {
  await browser.close();
}
