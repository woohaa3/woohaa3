/**
 * 核心服务分区：配置项按服务分组、只保留有配置的服务、未登记前缀兜底。
 */
import { describe, expect, it } from "vitest";
import type { SettingsEntryView } from "@woohaa3/contracts";
import { HOST_SERVICES, hostServiceGroups, serviceIdOfKey } from "./host-services.js";

const entry = (key: string, overrides: Partial<SettingsEntryView> = {}): SettingsEntryView => ({
  key,
  kind: "string",
  label: key,
  description: "",
  reload: "hot",
  secret: false,
  source: null,
  lockedBy: null,
  value: null,
  configured: false,
  pendingRestart: false,
  ...overrides
});

describe("serviceIdOfKey", () => {
  it("取配置键的领域前缀", () => {
    expect(serviceIdOfKey("canvas.syncUpstream.url")).toBe("canvas");
    expect(serviceIdOfKey("telemetry.local.enabled")).toBe("telemetry");
    expect(serviceIdOfKey("standalone")).toBe("standalone");
  });
});

describe("hostServiceGroups", () => {
  it("按服务分组，只保留有配置项的服务，顺序按登记的服务顺序", () => {
    const groups = hostServiceGroups([
      entry("telemetry.local.enabled"),
      entry("storage.primary"),
      entry("canvas.syncUpstream.url"),
      entry("canvas.syncUpstream.token"),
      entry("storage.expose")
    ]);
    expect(groups.map((group) => group.service.id)).toEqual(["canvas", "storage", "telemetry"]);
    expect(groups.map((group) => group.entries.length)).toEqual([2, 2, 1]);
    // 没有配置项的服务不会出现（任务 / 媒体 / 生成 / MCP / 应用）。
    expect(groups.some((group) => group.service.id === "task")).toBe(false);
    expect(groups.some((group) => group.service.id === "media")).toBe(false);
  });

  it("未登记的前缀仍然可见：用前缀当显示名，排在已登记服务之后", () => {
    const groups = hostServiceGroups([
      entry("server.basePath"),
      entry("storage.primary"),
      entry("zeta.flag"),
      entry("server.shutdownGraceMs")
    ]);
    expect(groups.map((group) => group.service.id)).toEqual(["storage", "server", "zeta"]);
    const server = groups.find((group) => group.service.id === "server")!;
    expect(server.service.label).toBe("server");
    expect(server.entries).toHaveLength(2);
  });

  it("没有配置项时返回空分组，而不是空服务占位", () => {
    expect(hostServiceGroups([])).toEqual([]);
  });

  it("includeServiceIds 让「有插件贡献但没有 YAML 配置」的服务出现（生成）", () => {
    const groups = hostServiceGroups([entry("storage.primary")], { includeServiceIds: ["generation"] });
    expect(groups.map((group) => group.service.id)).toEqual(["storage", "generation"]);
    expect(groups.find((group) => group.service.id === "generation")!.entries).toEqual([]);
    // 没有列进 includeServiceIds 的空服务仍然不出现。
    expect(groups.some((group) => group.service.id === "task")).toBe(false);
  });

  it("登记表的页签顺序稳定：任务 / 媒体 / 生成排在画布与存储之后", () => {
    const order = HOST_SERVICES.map((service) => service.id);
    expect(order.indexOf("task")).toBeGreaterThan(order.indexOf("storage"));
    expect(order.indexOf("telemetry")).toBeGreaterThan(order.indexOf("media"));
  });
});
