/**
 * Frontend Event Catalog 单测
 * （change: formalize-frontend-event-bus，任务 2.1 / 7.4）。
 *
 * 覆盖：目录 key 集合与 payload 定义完全一致、每个事件有 producer/consumer、旧事件名清单、
 * payload 安全边界（类型层面禁止 Blob/URL 等，运行时由 bridge 校验）。
 */
import { describe, expect, it } from "vitest";
import {
  FRONTEND_EVENT_NAMES,
  RETIRED_FRONTEND_EVENT_NAMES,
  frontendEventCatalog
} from "./catalog.js";

describe("Frontend Event Catalog（任务 2.1）", () => {
  it("目录事件名集合固定且每个事件都有 producer/consumer", () => {
    expect([...FRONTEND_EVENT_NAMES].sort()).toEqual([
      "extension.release.changed",
      "task.activity.finished",
      "task.activity.started",
      "task.activity.updated",
      "ui.media-preview.open-requested",
      "ui.node-download.save-requested",
      "ui.node-history.open-requested",
      "ui.node-history.switch-requested",
      "ui.text-preview.open-requested",
      "ui.video-frame-capture.open-requested"
    ]);
    for (const name of FRONTEND_EVENT_NAMES) {
      const descriptor = frontendEventCatalog[name];
      expect(descriptor.producers.length, name).toBeGreaterThan(0);
      expect(descriptor.consumers.length, name).toBeGreaterThan(0);
      expect(["app", "canvas"]).toContain(descriptor.scope);
      expect(["request", "fact"]).toContain(descriptor.kind);
    }
  });

  it("命名规则：UI 请求用 ui.*-requested，事实事件用 task.activity.*、extension.activity.* 或 extension.release.*", () => {
    for (const name of FRONTEND_EVENT_NAMES) {
      const descriptor = frontendEventCatalog[name];
      if (descriptor.kind === "request") expect(name).toMatch(/^ui\..+-requested$/);
      if (descriptor.kind === "fact") expect(name).toMatch(/^(task|extension)\.activity\.|^extension\.release\./);
    }
  });

  it("旧事件名清单保留（审计守卫用）", () => {
    expect([...RETIRED_FRONTEND_EVENT_NAMES]).toEqual([
      "canvas/image-preview",
      "canvas/video-frame-capture",
      "canvas/node-history"
    ]);
  });
});
