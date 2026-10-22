#!/usr/bin/env node
/**
 * 进程级 E2E 的 Media Service 入口（change: split-web-runtime-services，任务 8.2）。
 *
 * 用真实 Media Service handler + 内存对象存储替身（无 COS 凭据），监听 `PORT`。
 * 仅用于进程级重启演练；生产入口是 `web/services/media-service/src/server.ts`。
 */
import http from "node:http";
import { createMediaService } from "../../services/media-service/dist/index.js";

const port = Number(process.env.PORT);

const objects = new Map();
const notFound = () => {
  const error = new Error("not found");
  error.code = "MEDIA_OBJECT_NOT_FOUND";
  error.name = "MediaObjectNotFoundError";
  return error;
};
const storage = {
  async put(key, bytes, contentType) {
    objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
  },
  async get(key) {
    const record = objects.get(key);
    if (!record) throw notFound();
    return record;
  },
  async exists(key) {
    return objects.has(key);
  },
  async stat(key) {
    const record = objects.get(key);
    if (!record) throw notFound();
    return { size: record.bytes.byteLength, contentType: record.contentType };
  },
  async getHttpsUrl(key) {
    return `https://cos.invalid/${key}?sign=e2e`;
  }
};

const service = createMediaService({
  storage,
  identities: {
    tokens: { "canvas-service": process.env.CANVAS_TOKEN, "task-service": process.env.TASK_TOKEN }
  }
});

const server = http.createServer((req, res) => {
  service.handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.listen(port, "127.0.0.1", () => process.stderr.write(`[media] ${port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
