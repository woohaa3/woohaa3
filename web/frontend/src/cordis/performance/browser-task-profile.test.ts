import { expect, it, vi } from "vitest";
import { beginBrowserTaskProfile } from "./browser-task-profile.js";
it("reports unsupported browsers without claiming zero long tasks", () => {
  expect(beginBrowserTaskProfile({} as Window, 100).stop()).toEqual({ observedTypes: [], entries: [], dropped: 0 });
});
it("drains and disconnects the observer, filtering earlier entries", () => {
  const disconnect = vi.fn();
  class Observer {
    static supportedEntryTypes = ["longtask"];
    observe = vi.fn(); disconnect = disconnect;
    takeRecords = () => [{ startTime: 90, duration: 60, entryType: "longtask" }, { startTime: 120, duration: 70, entryType: "longtask" }];
  }
  const profile = beginBrowserTaskProfile({ PerformanceObserver: Observer } as unknown as Window, 100);
  expect(profile.stop()).toMatchObject({ observedTypes: ["longtask"], entries: [{ atMs: 20, durationMs: 70 }] });
  expect(disconnect).toHaveBeenCalledOnce();
});
