import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyHttpMount,
  applyUpgradeMount,
  interceptHttpMount,
  rejectUpgradeSocket
} from "./mount-adapter.mjs";

function fakeRes() {
  const recorded = { status: 0, headers: {}, body: "", ended: false };
  return {
    recorded,
    res: {
      writeHead(status, headers) {
        recorded.status = status;
        Object.assign(recorded.headers, headers ?? {});
      },
      end(body) {
        recorded.body = body === undefined ? "" : String(body);
        recorded.ended = true;
      }
    }
  };
}

test("前缀外请求不进入应用业务（404），不猜测挂载", () => {
  for (const url of ["/", "/api/canvases", "/renderer.html", "/canvas-other/"]) {
    const req = { url };
    const { res, recorded } = fakeRes();
    assert.equal(interceptHttpMount(req, res, applyHttpMount("/canvas/", req)), true, url);
    assert.equal(recorded.status, 404, url);
  }
});

test("无尾斜杠入口 GET 以 308 跳到规范入口并保留 query", () => {
  const req = { url: "/canvas?canvasId=c" };
  const { res, recorded } = fakeRes();
  assert.equal(interceptHttpMount(req, res, applyHttpMount("/canvas/", req)), true);
  assert.equal(recorded.status, 308);
  assert.equal(recorded.headers.location, "/canvas/?canvasId=c");
});

test("前缀内请求剥离一次并保留 query；规范入口剥为逻辑根", () => {
  const nested = { url: "/canvas/api/canvases/c/sync?version=v" };
  assert.deepEqual(applyHttpMount("/canvas/", nested), { kind: "forward" });
  assert.equal(nested.url, "/api/canvases/c/sync?version=v");
  const entry = { url: "/canvas/" };
  assert.deepEqual(applyHttpMount("/canvas/", entry), { kind: "forward" });
  assert.equal(entry.url, "/");
});

test("非法编码/穿越被拒绝（400）", () => {
  const req = { url: "/canvas/%2e%2e/outside" };
  const { res, recorded } = fakeRes();
  assert.equal(interceptHttpMount(req, res, applyHttpMount("/canvas/", req)), true);
  assert.equal(recorded.status, 400);
});

test("upgrade 使用同一匹配但不重定向", () => {
  const ws = { url: "/canvas/api/canvases/c1/runs?token=t" };
  assert.deepEqual(applyUpgradeMount("/canvas/", ws), { kind: "forward" });
  assert.equal(ws.url, "/api/canvases/c1/runs?token=t");
  // 前缀外：不接管（既不 forward 也不 redirect）。
  assert.deepEqual(applyUpgradeMount("/canvas/", { url: "/api/canvases/c1/runs" }), { kind: "outside" });
});

test("rejectUpgradeSocket 写出 404 并关闭", () => {
  const chunks = [];
  let destroyed = false;
  rejectUpgradeSocket({
    write: (value) => chunks.push(value),
    destroy: () => {
      destroyed = true;
    }
  });
  assert.match(chunks.join(""), /404 Not Found/);
  assert.equal(destroyed, true);
});
