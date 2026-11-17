/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { hostDocumentStale, hostMainScript, replaceDocumentIfHostChanged } from "./host-document.js";

describe("host document", () => {
  it("从 HTML 或脚本地址里认出宿主主脚本", () => {
    expect(hostMainScript('<script type="module" src="./assets/main-AduHins2.js"></script>')).toBe("assets/main-AduHins2.js");
    expect(hostMainScript("/woohaa/assets/main-D2AqTo_J.js")).toBe("assets/main-D2AqTo_J.js");
    expect(hostMainScript("./assets/runtime-issues-DG3o1Pjk.js")).toBeNull();
  });

  it("主脚本文件名不同才算旧文档", () => {
    const html = '<script type="module" src="./assets/main-AduHins2.js"></script>';
    expect(hostDocumentStale("/woohaa/assets/main-D2AqTo_J.js", html)).toBe(true);
    expect(hostDocumentStale("./assets/main-AduHins2.js", html)).toBe(false);
    expect(hostDocumentStale(null, html)).toBe(false);
  });

  it("宿主脚本变了就换文档，相同或请求失败则留下当前页", async () => {
    const html = '<script type="module" src="./assets/main-AduHins2.js"></script>';
    const replaced: string[] = [];
    const location = {
      href: "http://wh3/woohaa/?canvasId=c1",
      pathname: "/woohaa/",
      search: "?canvasId=c1",
      replace: (url: string) => replaced.push(url)
    };
    const document = {
      querySelectorAll: () => [{ getAttribute: () => "/woohaa/assets/main-D2AqTo_J.js" }]
    };
    await expect(replaceDocumentIfHostChanged({
      location,
      document,
      fetch: async () => new Response(html, { status: 200 })
    })).resolves.toBe(true);
    expect(replaced).toEqual(["http://wh3/woohaa/?canvasId=c1&__host=mainAduHins2js"]);

    replaced.length = 0;
    await expect(replaceDocumentIfHostChanged({
      location,
      document: { querySelectorAll: () => [{ getAttribute: () => "./assets/main-AduHins2.js" }] },
      fetch: async () => new Response(html, { status: 200 })
    })).resolves.toBe(false);
    expect(replaced).toEqual([]);
  });

  it("按当前地址强制重取入口 HTML", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    await replaceDocumentIfHostChanged({
      location: {
        href: "http://wh3/woohaa/?canvasId=c1",
        pathname: "/woohaa/",
        search: "?canvasId=c1",
        replace: () => undefined
      },
      document: { querySelectorAll: () => [{ getAttribute: () => "/woohaa/assets/main-D2AqTo_J.js" }] },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('<script src="./assets/main-AduHins2.js"></script>', { status: 200 });
      }
    });
    expect(calls).toEqual([{
      url: "/woohaa/?canvasId=c1",
      init: { cache: "reload", credentials: "same-origin" }
    }]);
  });

  it("请求失败、没有主脚本，或已经换过同一份脚本时不换页", async () => {
    const replaced: string[] = [];
    const location = {
      href: "http://wh3/woohaa/?canvasId=c1",
      pathname: "/woohaa/",
      search: "?canvasId=c1",
      replace: (url: string) => replaced.push(url)
    };
    const document = { querySelectorAll: () => [{ getAttribute: () => "/woohaa/assets/main-D2AqTo_J.js" }] };
    const html = '<script type="module" src="./assets/main-AduHins2.js"></script>';

    await expect(replaceDocumentIfHostChanged({
      location,
      document,
      fetch: async () => { throw new Error("offline"); }
    })).resolves.toBe(false);
    await expect(replaceDocumentIfHostChanged({
      location,
      document,
      fetch: async () => new Response("no", { status: 503 })
    })).resolves.toBe(false);
    await expect(replaceDocumentIfHostChanged({
      location,
      document: { querySelectorAll: () => [{ getAttribute: () => "./assets/runtime-issues-DG3o1Pjk.js" }] },
      fetch: async () => { throw new Error("should not fetch"); }
    })).resolves.toBe(false);

    await expect(replaceDocumentIfHostChanged({
      location: { ...location, href: "http://wh3/woohaa/?canvasId=c1&__host=mainAduHins2js", search: "?canvasId=c1&__host=mainAduHins2js" },
      document,
      fetch: async () => new Response(html, { status: 200 })
    })).resolves.toBe(false);
    expect(replaced).toEqual([]);
  });
});
