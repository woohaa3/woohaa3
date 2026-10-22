import { expect, it, vi } from "vitest";
import { MediaOperationBoundary } from "./media-operation-boundary.js";
import { RuntimeIssues } from "./runtime-issues.js";
import type { BevyRuntime } from "./bevy-runtime.js";

it("光栅化失败去重，重试版本重新执行且恢复同一问题，删除释放失败缓存", () => {
  const issues = new RuntimeIssues();
  let retry = 0;
  const runtime = { retryVersion: () => retry, reportRuntimeIssue: issues.report, clearRuntimeIssue: issues.clear } as unknown as BevyRuntime;
  const boundary = new MediaOperationBoundary(runtime);
  const raster = vi.fn(() => { throw new Error("getImageData failed"); });
  boundary.run("focus:n", "source", "n", raster);
  boundary.run("focus:n", "source", "n", raster);
  expect(raster).toHaveBeenCalledOnce();
  expect(issues.getSnapshot()).toHaveLength(1);
  retry++;
  expect(boundary.run("focus:n", "source", "n", () => "restored")).toBe("restored");
  expect(issues.getSnapshot()).toEqual([]);
  boundary.run("focus:n", "source", "n", raster);
  boundary.retainNodes(new Set());
  expect(issues.getSnapshot()).toEqual([]);
  boundary.run("focus:n", "source", "n", raster);
  expect(raster).toHaveBeenCalledTimes(3);
});
