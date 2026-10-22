import { describe, expect, it } from "vitest";
import {
  addAppBasePath,
  appBasePathPrefix,
  decideAppPathMount,
  matchAppBasePath,
  normalizeAppBasePath,
  stripAppBasePath
} from "./app-base-path.mjs";

describe("normalizeAppBasePath", () => {
  it("未设置/空/斜杠都规范为根", () => {
    for (const raw of [undefined, null, "", "/"]) {
      expect(normalizeAppBasePath(raw)).toEqual({ ok: true, basePath: "/" });
    }
  });

  it("单级与多级都补尾斜杠并去尾斜杠输入", () => {
    expect(normalizeAppBasePath("/canvas")).toEqual({ ok: true, basePath: "/canvas/" });
    expect(normalizeAppBasePath("/canvas/")).toEqual({ ok: true, basePath: "/canvas/" });
    expect(normalizeAppBasePath("/tools/woohaa")).toEqual({ ok: true, basePath: "/tools/woohaa/" });
    expect(normalizeAppBasePath("/tools/woohaa/")).toEqual({ ok: true, basePath: "/tools/woohaa/" });
  });

  it("拒绝非规范地址", () => {
    const invalid = [
      "https://host/app",
      "//host/app",
      "canvas",
      "/a/../b",
      "/a%2fb",
      "/a?b=1",
      "/a#b",
      "/a\\b",
      "/a b",
      "/a//b",
      "/.",
      "/..",
      `/a/${"b".repeat(300)}`
    ];
    for (const raw of invalid) {
      expect(normalizeAppBasePath(raw).ok, raw).toBe(false);
    }
  });
});

describe("add/strip/match", () => {
  it("根挂载是恒等映射", () => {
    expect(addAppBasePath("/", "/api/x")).toBe("/api/x");
    expect(stripAppBasePath("/", "/api/x")).toBe("/api/x");
    expect(appBasePathPrefix("/")).toBe("");
  });

  it("加一次前缀并只在完整段上剥离", () => {
    expect(addAppBasePath("/canvas/", "/api/x")).toBe("/canvas/api/x");
    expect(stripAppBasePath("/canvas/", "/canvas/api/x")).toBe("/api/x");
    expect(stripAppBasePath("/canvas/", "/canvas/")).toBe("/");
    expect(stripAppBasePath("/canvas/", "/canvas-other/")).toBeNull();
    expect(stripAppBasePath("/canvas/", "/api/x")).toBeNull();
    expect(appBasePathPrefix("/canvas/")).toBe("/canvas");
  });

  it("完整段匹配区分挂载入口与外部", () => {
    expect(matchAppBasePath("/canvas/", "/canvas/").kind).toBe("inside");
    expect(matchAppBasePath("/canvas/", "/canvas")).toEqual({ kind: "entry", location: "/canvas/" });
    expect(matchAppBasePath("/canvas/", "/canvas/a/b").kind).toBe("inside");
    expect(matchAppBasePath("/canvas/", "/canvas-other/").kind).toBe("outside");
  });
});

describe("decideAppPathMount", () => {
  it("根挂载转发原路径并保留 query", () => {
    expect(decideAppPathMount("/", "/api/x?a=1")).toEqual({
      action: "forward",
      url: "/api/x?a=1",
      pathname: "/api/x",
      search: "?a=1"
    });
  });

  it("子挂载剥离一次并保留 query；无尾斜杠入口 308 保留 query", () => {
    expect(decideAppPathMount("/canvas/", "/canvas/api/canvases/c/sync?version=v")).toEqual({
      action: "forward",
      url: "/api/canvases/c/sync?version=v",
      pathname: "/api/canvases/c/sync",
      search: "?version=v"
    });
    expect(decideAppPathMount("/canvas/", "/canvas?canvasId=c")).toEqual({
      action: "redirect",
      location: "/canvas/?canvasId=c"
    });
    // 规范入口 `/canvas/` 剥离为逻辑根 `/`（只剥离一次）。
    expect(decideAppPathMount("/canvas/", "/canvas/")).toEqual({
      action: "forward",
      url: "/",
      pathname: "/",
      search: ""
    });
  });

  it("前缀外与相似前缀都不进入业务", () => {
    for (const url of ["/", "/api/canvases", "/renderer.html", "/canvas-other/", "/canvas-other/api"]) {
      expect(decideAppPathMount("/canvas/", url).action, url).toBe("outside");
    }
  });

  it("编码分隔符与穿越边界拒绝", () => {
    for (const url of ["/canvas/%2fapi", "/canvas/../api", "/canvas/%2e%2e/api", "/canvas\\api"]) {
      expect(decideAppPathMount("/canvas/", url).action, url).toBe("invalid");
    }
  });
});
