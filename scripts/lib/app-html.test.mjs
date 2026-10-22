import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_BASE_PATH_META, injectAppHtml, resolveAppPageTitle } from "./app-html.mjs";

const HTML = '<!doctype html><html><head><title>t</title><script type="module" src="./main.js"></script></head><body></body></html>';

test("注入的 base 与公开 basePath 元数据排在脚本/样式之前", () => {
  const out = injectAppHtml(HTML, "/canvas/");
  const baseIndex = out.indexOf("<base href=\"/canvas/\"");
  const metaIndex = out.indexOf(`name="${APP_BASE_PATH_META}"`);
  const scriptIndex = out.indexOf("<script");
  assert.ok(baseIndex >= 0 && metaIndex > baseIndex, out);
  assert.ok(scriptIndex > metaIndex, "元数据必须在脚本之前");
  assert.match(out, /content="\/canvas\/"/);
});

test("幂等：重复注入不再追加", () => {
  const once = injectAppHtml(HTML, "/canvas/");
  const twice = injectAppHtml(once, "/canvas/");
  assert.equal(twice, once);
});

test("无 <head> 时前置注入", () => {
  const out = injectAppHtml("<title>x</title>", "/");
  assert.ok(out.startsWith("<base href=\"/\""));
  assert.match(out, /<title>x<\/title>/);
});

test("标题配置使用公开默认值，并去掉配置两端的空白", () => {
  for (const value of [undefined, "", "  "]) {
    assert.equal(resolveAppPageTitle({ WOOHAA3_PAGE_TITLE: value }), "WooHaa3");
  }
  assert.equal(resolveAppPageTitle({ WOOHAA3_PAGE_TITLE: "  预览 A  " }), "预览 A");
});

test("运行时标题按文本转义，不能关闭 title 或替换 HTML 片段", () => {
  const out = injectAppHtml(HTML, "/preview/", '预览 </title><script>alert(1)</script> & "$&"');
  assert.match(out, /<title>预览 &lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;\$&amp;&quot;<\/title>/);
  assert.equal((out.match(/<script/g) || []).length, 1);
});

test("已有挂载元数据的 HTML 仍可替换标题，缺少标题的入口可补齐", () => {
  const once = injectAppHtml(HTML, "/preview/", "预览 A");
  const twice = injectAppHtml(once, "/preview/", "预览 B");
  assert.match(twice, /<title>预览 B<\/title>/);
  assert.equal((twice.match(/<base /g) || []).length, 1);
  assert.equal(injectAppHtml(twice, "/preview/", "预览 B"), twice);
  for (const html of ['<html><head></head></html>', '<body>内容</body>']) {
    assert.match(injectAppHtml(html, "/", "预览"), /<title>预览<\/title>/);
  }
});
