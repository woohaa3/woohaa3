/**
 * 镜头参考后台活动投影测试（任务活动浮层）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 覆盖：每次尝试保留一条、进度 5% 分桶、失败保留原因、重试新增记录、排队项取消。
 */
import { describe, expect, it } from "vitest";
import type { BackgroundActivityJob } from "@woohaa3/contracts";
import { ShotReferenceActivity } from "../src/frontend/shot-reference-activity.js";
import type { ShotReferenceRecordingJob } from "../src/frontend/shot-reference-recording-queue.js";

const job = (patch: Partial<ShotReferenceRecordingJob> = {}): ShotReferenceRecordingJob => ({
  canvasId: "c1",
  filmSetNodeId: "film",
  clipId: "clip-1",
  contentIdentity: "id-a",
  profileKey: "v1-1280x720@30",
  ...patch
});

function fixture() {
  const emitted: BackgroundActivityJob[] = [];
  let tick = 0;
  const activity = new ShotReferenceActivity(
    { titleOf: () => "片场 · 镜头 1", emit: (record) => emitted.push(record) },
    () => `2026-01-01T00:00:0${tick++}Z`
  );
  return { activity, emitted };
}

describe("ShotReferenceActivity（后台活动投影）", () => {
  it("排队 → 录制 → 完成：同一 id 一条记录，进度按 5% 分桶", () => {
    const { activity, emitted } = fixture();
    activity.syncQueued([job()]);
    activity.start(job());
    activity.progress(job(), 1, 100); // 1%
    activity.progress(job(), 2, 100); // 同一桶，不重复
    activity.progress(job(), 40, 100); // 40%
    activity.finish(job(), { ok: true });

    expect(activity.records()).toHaveLength(1);
    expect(activity.records()[0]).toMatchObject({ status: "succeeded", progress: 1, title: "片场 · 镜头 1" });
    const buckets = emitted.filter((entry) => entry.status === "running").map((entry) => entry.progress);
    expect(buckets).toEqual([0, 0.4]);
  });

  it("失败保留原因；退避重试期间保持失败，重录时新增记录", () => {
    const { activity } = fixture();
    activity.start(job());
    activity.finish(job(), { ok: false, error: "第 1 秒的镜头捕捉失败或超时" });
    expect(activity.records()[0]).toMatchObject({ status: "failed", detail: "第 1 秒的镜头捕捉失败或超时" });

    // 调度器仍把该版本留在 dirty 集（等待退避重试）：不把失败态刷回排队。
    activity.syncQueued([job()]);
    expect(activity.records()[0]?.status).toBe("failed");

    activity.start(job());
    expect(activity.records().map(record => record.status)).toEqual(["failed", "running"]);
    expect(activity.records()[0]?.id).not.toBe(activity.records()[1]?.id);
    activity.progress(job(), 50, 100);
    activity.finish(job(), { ok: true });
    expect(activity.records().map(record => record.status)).toEqual(["failed", "succeeded"]);
  });

  it("内容变化后新增排队记录并保留旧失败", () => {
    const { activity } = fixture();
    activity.start(job());
    activity.finish(job(), { ok: false, error: "编码失败" });
    activity.syncQueued([job({ contentIdentity: "id-b" })]);
    expect(activity.records().map(record => record.status)).toEqual(["failed", "queued"]);
    activity.syncQueued([job({ contentIdentity: "id-b" })]);
    expect(activity.records()).toHaveLength(2);
  });

  it("不再 dirty 的排队项标为取消（镜头删除/版本失效）", () => {
    const { activity } = fixture();
    activity.syncQueued([job()]);
    activity.syncQueued([]);
    expect(activity.records()[0]?.status).toBe("cancelled");
  });

  it("在录的目标不被取消", () => {
    const { activity } = fixture();
    activity.start(job());
    activity.syncQueued([]);
    expect(activity.records()[0]?.status).toBe("running");
  });
});
