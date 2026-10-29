import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  backendPath,
  RELEASE_HREF_PATTERN,
  resolveReleasePointer
} from "./extension-release-pointer.mjs";

const RELEASE = `/extension-releases/${"a".repeat(64)}.json`;
const OTHER = `/extension-releases/${"b".repeat(64)}.json`;

/** 记录请求并按脚本回答的 fetch 替身。 */
function fakeFetch(script) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const handler = script.find((entry) => entry.match(url));
    if (!handler) throw new Error(`unexpected request: ${url}`);
    const { status = 200, body = null } = handler.respond(url, calls.length) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (body === null) throw new Error("no json");
        return body;
      }
    };
  };
  return { fetchImpl, calls };
}

const pointer = (href) => (url) => url.endsWith("/extension-releases/current.json") && href;
const catalog = (href, status = 200) => (url) => url.endsWith(href) && status;

function options(fetchImpl, overrides = {}) {
  return {
    backendUrl: "http://127.0.0.1:5301",
    fetchImpl,
    retryWindowMs: 0,
    retryDelayMs: 0,
    attemptTimeoutMs: 50,
    now: () => Date.now(),
    sleep: async () => undefined,
    ...overrides
  };
}

describe("backendPath", () => {
  it("只在请求出口加一次公开挂载前缀", () => {
    assert.equal(backendPath("http://h:1", "/", "/extension-releases/x.json"), "http://h:1/extension-releases/x.json");
    assert.equal(backendPath("http://h:1/", "/foo/", "/extension-releases/x.json"), "http://h:1/foo/extension-releases/x.json");
    assert.equal(backendPath("http://h:1", "/foo", "extension-releases/x.json"), "http://h:1/foo/extension-releases/x.json");
  });

  it("href 形状只接受固定前缀 + 64 位 sha256", () => {
    assert.ok(RELEASE_HREF_PATTERN.test(RELEASE));
    assert.ok(!RELEASE_HREF_PATTERN.test("/extension-releases/current.json"));
    assert.ok(!RELEASE_HREF_PATTERN.test("/extension-releases/../secret.json"));
    assert.ok(!RELEASE_HREF_PATTERN.test("https://evil.example/x.json"));
  });
});

describe("resolveReleasePointer", () => {
  it("宿主可用时直接返回当前指针", async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: pointer(RELEASE), respond: () => ({ body: { href: RELEASE } }) }]);
    const result = await resolveReleasePointer(options(fetchImpl));
    assert.deepEqual(result, { href: RELEASE, source: "pointer" });
    assert.deepEqual(calls, ["http://127.0.0.1:5301/extension-releases/current.json"]);
  });

  it("宿主重启窗口里重试，就绪后仍用当前指针", async () => {
    let attempt = 0;
    const { fetchImpl } = fakeFetch([
      {
        match: pointer(RELEASE),
        respond: () => {
          attempt += 1;
          return attempt <= 2 ? { status: 502 } : { body: { href: RELEASE } };
        }
      }
    ]);
    const result = await resolveReleasePointer(options(fetchImpl, { retryWindowMs: 5_000 }));
    assert.deepEqual(result, { href: RELEASE, source: "pointer" });
    assert.equal(attempt, 3);
  });

  it("窗口用尽时回落到上次发布（只在目录仍可读时）", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: pointer(RELEASE), respond: () => ({ status: 502 }) },
      { match: catalog(OTHER), respond: () => ({}) }
    ]);
    const result = await resolveReleasePointer(options(fetchImpl, { lastGoodHref: OTHER }));
    assert.deepEqual(result, { href: OTHER, source: "last-good" });
    assert.ok(calls.at(-1)?.endsWith(OTHER));
  });

  it("上次发布也不在了就返回 null（不注入会 404 的指针）", async () => {
    const { fetchImpl } = fakeFetch([
      { match: pointer(RELEASE), respond: () => ({ status: 502 }) },
      { match: catalog(OTHER), respond: () => ({ status: 404 }) }
    ]);
    const result = await resolveReleasePointer(options(fetchImpl, { lastGoodHref: OTHER }));
    assert.deepEqual(result, { href: null, source: null });
  });

  it("没有可回落的上次发布时返回 null", async () => {
    const { fetchImpl } = fakeFetch([{ match: pointer(RELEASE), respond: () => ({ status: 502 }) }]);
    assert.deepEqual(await resolveReleasePointer(options(fetchImpl)), { href: null, source: null });
  });

  it("宿主返回非法 href 时抛错（宿主 bug 不静默降级）", async () => {
    const { fetchImpl } = fakeFetch([
      { match: pointer(RELEASE), respond: () => ({ body: { href: "/etc/passwd" } }) }
    ]);
    await assert.rejects(() => resolveReleasePointer(options(fetchImpl)), /发布目录地址无效/);
  });
});
