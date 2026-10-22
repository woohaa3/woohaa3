/**
 * 镜头参考版本缓存测试（任务 8.5 / design D9）。
 *
 * 覆盖：ready 原子发布、身份去重、多消费者、旧结果防覆盖、引用保留、容量淘汰、删除清理、中断
 * 恢复、取消、失败重试、持久化往返。
 */
import { describe, expect, it, vi } from "vitest";
import type { StoredAsset } from "@woohaa3/contracts";
import {
  createMemoryShotReferenceCacheStore,
  hydrateShotReferenceCacheFromCanvas,
  ShotReferenceVersionCache,
  shotReferenceVersionKey,
  type ShotReferenceVersionRef
} from "../src/frontend/shot-reference-version-cache.js";

const ref = (extra: Partial<ShotReferenceVersionRef> = {}): ShotReferenceVersionRef => ({
  canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1",
  contentIdentity: "id-a", profileKey: "v1-1280x720@30", ...extra
});
const asset = (storageKey: string) => ({ storageKey, checksum: storageKey.replace(/^sha256-/, ""), mediaType: "video/mp4", size: 5 });

describe("ShotReferenceVersionCache（方案 8.5）", () => {
  it("ready 原子发布：编码上传校验后才 ready，且取到真实资产", () => {
    const cache = new ShotReferenceVersionCache();
    const target = ref();
    expect(cache.readyAsset(target)).toBeNull();
    cache.markQueued(target);
    expect(cache.status(target)).toBe("queued");
    cache.markRecording(target);
    expect(cache.readyAsset(target)).toBeNull();
    cache.publish(target, asset("sha256-a"));
    expect(cache.status(target)).toBe("ready");
    expect(cache.readyAsset(target)).toEqual(asset("sha256-a"));
  });

  it("缺 checksum 的旧 ready 条目按未就绪处理（否则服务端会拒绝整批冻结命令）", () => {
    const cache = new ShotReferenceVersionCache();
    const target = ref();
    cache.markQueued(target);
    cache.publish(target, { storageKey: "sha256-a", mediaType: "video/mp4", size: 5 } as never);
    expect(cache.status(target)).toBe("ready");
    expect(cache.readyAsset(target)).toBeNull();
  });

  it("身份去重：同一内容身份只保留一个条目", () => {
    const cache = new ShotReferenceVersionCache();
    cache.markQueued(ref());
    cache.markRecording(ref());
    cache.publish(ref(), asset("sha256-a"));
    expect(cache.snapshot()).toHaveLength(1);
  });

  it("旧结果防覆盖：非当前版本发布为 superseded，不作为可用参考", () => {
    const cache = new ShotReferenceVersionCache();
    cache.setCurrent({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-b" });
    const stale = ref({ contentIdentity: "id-a" });
    expect(cache.publish(stale, asset("sha256-old"))).toBe(false);
    expect(cache.status(stale)).toBe("superseded");
    expect(cache.readyAsset(stale)).toBeNull();
  });

  it("内容更新把旧 ready 版本标为 superseded，当前版本仍可复用", () => {
    const cache = new ShotReferenceVersionCache();
    cache.publish(ref(), asset("sha256-a"));
    cache.setCurrent({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-b" });
    expect(cache.status(ref())).toBe("superseded");
    cache.publish(ref({ contentIdentity: "id-b" }), asset("sha256-b"));
    expect(cache.isReadyCurrent({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-b", profileKey: "v1-1280x720@30" })).toBe(true);
  });

  it("多消费者共享同一版本并收到 ready 通知", () => {
    const cache = new ShotReferenceVersionCache();
    const listener = vi.fn();
    const other = vi.fn();
    const unsubA = cache.subscribe(ref(), listener);
    const unsubB = cache.subscribe(ref(), other);
    cache.publish(ref(), asset("sha256-a"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
    cache.markQueued(ref({ contentIdentity: "id-c" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("引用保留：被 retain 的版本不参与淘汰", () => {
    const cache = new ShotReferenceVersionCache(createMemoryShotReferenceCacheStore(), () => "t", 1);
    const kept = ref({ contentIdentity: "id-a" });
    cache.publish(kept, asset("sha256-a"));
    const release = cache.retain(kept);
    cache.publish(ref({ contentIdentity: "id-b" }), asset("sha256-b"));
    cache.setCurrent({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-c" });
    cache.evict();
    expect(cache.snapshot().some((entry) => entry.cacheKey === shotReferenceVersionKey(kept))).toBe(true);
    release();
  });

  it("容量淘汰：优先淘汰 superseded，再 failed，最后无消费者 ready", () => {
    const cache = new ShotReferenceVersionCache(createMemoryShotReferenceCacheStore(), () => "t", 2);
    cache.publish(ref({ contentIdentity: "id-a" }), asset("a"));
    cache.publish(ref({ contentIdentity: "id-b" }), asset("b"));
    cache.publish(ref({ contentIdentity: "id-c" }), asset("c"));
    cache.setCurrent({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-c" });
    cache.evict();
    const remaining = cache.snapshot().map((entry) => entry.contentIdentity).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("id-c");
  });

  it("删除清理：源删除移除该片场全部版本与当前身份", () => {
    const cache = new ShotReferenceVersionCache();
    cache.setCurrent({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-a" });
    cache.publish(ref(), asset("a"));
    cache.removeBySource({ canvasId: "c1", filmSetNodeId: "film" });
    expect(cache.snapshot()).toHaveLength(0);
    expect(cache.isReadyCurrent({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-a", profileKey: "v1-1280x720@30" })).toBe(false);
  });

  it("中断恢复：遗留 queued/recording 重置为 dirty 等重排", () => {
    const cache = new ShotReferenceVersionCache();
    cache.markQueued(ref({ contentIdentity: "id-a" }));
    cache.markRecording(ref({ contentIdentity: "id-b" }));
    cache.recoverInterrupted();
    expect(cache.snapshot().every((entry) => entry.status === "dirty")).toBe(true);
  });

  it("取消与失败重试回到可再排队状态", () => {
    const cache = new ShotReferenceVersionCache();
    cache.markRecording(ref());
    cache.cancel(ref());
    expect(cache.status(ref())).toBe("dirty");
    cache.markFailed(ref(), "编码失败");
    expect(cache.status(ref())).toBe("failed");
    cache.retry(ref());
    expect(cache.status(ref())).toBe("queued");
  });

  it("持久化往返：状态与当前身份经 store 恢复", () => {
    const store = createMemoryShotReferenceCacheStore();
    const first = new ShotReferenceVersionCache(store);
    first.setCurrent({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-a" });
    first.publish(ref(), asset("sha256-a"));
    const second = new ShotReferenceVersionCache(store);
    expect(second.readyAsset(ref())).toEqual(asset("sha256-a"));
    expect(second.isReadyCurrent({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-a", profileKey: "v1-1280x720@30" })).toBe(true);
  });
});

describe("从画布已冻结资产回填（刷新后免重录）", () => {
  const frozen = (patch: Partial<StoredAsset> = {}): StoredAsset => ({
    id: "shot-reference-video:film:clip-1:id-a:v1-1280x720@30",
    title: "片场 · 镜头 1",
    mediaKind: "video",
    source: "generated",
    status: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    metadata: {
      storageKey: "sha256-abc",
      checksum: "a".repeat(64),
      contentType: "video/mp4",
      size: 10,
      shotReference: {
        filmSetNodeId: "film",
        clipId: "clip-1",
        contentIdentity: "id-a",
        profileKey: "v1-1280x720@30"
      }
    },
    ...patch
  });

  it("回填 ready 资产，版本键与录制产物一致", () => {
    const cache = new ShotReferenceVersionCache();
    const count = hydrateShotReferenceCacheFromCanvas(cache, { id: "c1", assets: [frozen()] });
    expect(count).toBe(1);
    expect(cache.readyAsset(ref())).toEqual({
      storageKey: "sha256-abc",
      checksum: "a".repeat(64),
      mediaType: "video/mp4",
      size: 10
    });
    expect(cache.readyAsset(ref({ contentIdentity: "id-b" }))).toBeNull();
  });

  it("幂等：同一资产重复回填不重复发布", () => {
    const cache = new ShotReferenceVersionCache();
    hydrateShotReferenceCacheFromCanvas(cache, { id: "c1", assets: [frozen()] });
    expect(hydrateShotReferenceCacheFromCanvas(cache, { id: "c1", assets: [frozen()] })).toBe(0);
    expect(cache.snapshot()).toHaveLength(1);
  });

  it("跳过缺 checksum、缺镜头链接、未就绪与普通视频资产", () => {
    const cache = new ShotReferenceVersionCache();
    const noChecksum = frozen({
      metadata: {
        storageKey: "sha256-abc",
        contentType: "video/mp4",
        size: 10,
        shotReference: {
          filmSetNodeId: "film",
          clipId: "clip-1",
          contentIdentity: "id-a",
          profileKey: "v1-1280x720@30"
        }
      } as never
    });
    const plainVideo = frozen({ id: "plain", metadata: { storageKey: "sha256-abc", checksum: "a".repeat(64) } as never });
    const generating = frozen({ status: "generating" });
    const count = hydrateShotReferenceCacheFromCanvas(cache, {
      id: "c1",
      assets: [noChecksum, plainVideo, generating]
    });
    expect(count).toBe(0);
    expect(cache.snapshot()).toHaveLength(0);
  });
});
