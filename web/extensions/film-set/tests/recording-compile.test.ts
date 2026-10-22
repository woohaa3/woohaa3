import { nativeFilmSetFrame } from "../src/preview/backend/native-frame.js";
/**
 * 片场原生录制的冻结与提交计划（任务 2.2 / 2.3 / 2.4）。
 *
 * 覆盖：冻结产出稳定身份与清单、非法脚本/无时长/历史只读/pending draft/权限拒绝、
 * checksum 变化改变身份、重命名与布局不影响身份、旧 profile 不命中、提交计划原子性与位置。
 */
import { describe, expect, it } from "vitest";
import {
  canonicalFilmSetFields,
  createFilmSetSnapshot,
  decodeFilmSetNodeData,
  filmSetAnimationsOf,
  type CanvasNodeData,
  type FilmSetNodeData,
  type StoredAsset
} from "@woohaa3/contracts";
import {
  FILM_SET_RECORDING_CODEC_REVISION,
  browserReferenceProfileKey,
  describeFilmSetRecording,
  describeRecordingUnavailable,
  freezeFilmSetRecording,
  matchesFilmSetRecording,
  nativeRecordingProfileKey,
  nativeReferenceAssetId,
  nativeReferenceCacheKey,
  planFilmSetRecordingCommit,
  recordingProfile,
  recordingSnapshotHash,
  validateRecordingResources,
  type recordingVideoSize
} from "../src/authoring/backend/recording-compile.js";

const CHECKSUM_A = "a".repeat(64);
const CHECKSUM_B = "b".repeat(64);
const NOW = () => "2026-10-17T00:00:00.000Z";

type Fixture = { nodeData: CanvasNodeData; animation: FilmSetNodeData };

/**
 * 构造片场节点。
 *
 * `freezeFilmSetRecording` 接收的是**原始节点数据**（与权威画布一致），所以 fixture 同时保留
 * 规范化字段与解码结果：字段用于冻结，解码结果用于断言。
 */
function makeAnimation(overrides: { duration?: number; modelScript?: string; title?: string } = {}): Fixture {
  const snapshot = createFilmSetSnapshot({
    title: overrides.title ?? "片场",
    model: {
      modelScript: overrides.modelScript ?? `scene.box({ id: "body" });`,
      modelScriptVersion: "woohaa-model-js-v2"
    },
    motionScript: `motion.model.rotate("body", { speed: 1 });`,
    timeline: { duration: overrides.duration ?? 4, loop: false }
  });
  const nodeData = canonicalFilmSetFields(snapshot) as unknown as CanvasNodeData;
  const decoded = decodeFilmSetNodeData(nodeData);
  if (!decoded.ok) throw new Error(decoded.reason);
  return { nodeData, animation: decoded.value };
}

function mediaAsset(overrides: { checksum?: string; storageKey?: string; contentType?: string; size?: number } = {}): StoredAsset {
  const checksum = overrides.checksum ?? CHECKSUM_A;
  return {
    id: "asset-video-1",
    title: "视频",
    mediaKind: "video",
    source: "uploaded",
    status: "ready",
    createdAt: NOW(),
    metadata: {
      storageKey: overrides.storageKey ?? `sha256-${checksum}`,
      checksum,
      contentType: overrides.contentType ?? "video/mp4",
      size: overrides.size ?? 1024
    }
  } as StoredAsset;
}

/** 给片场加一个视频项（渲染身份里会带上 assetId 与 playback）。 */
function withVideo(fixture: Fixture, assetId = "asset-video-1"): Fixture {
  const nodeData = structuredClone(fixture.nodeData) as unknown as { filmSetContent?: { items: unknown[] } };
  nodeData.filmSetContent!.items.push({
    id: "item-video",
    kind: "video",
    name: "视频",
    assetId,
    aspectRatio: 16 / 9,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
  });
  const decoded = decodeFilmSetNodeData(nodeData);
  if (!decoded.ok) throw new Error(decoded.reason);
  return { nodeData: nodeData as unknown as CanvasNodeData, animation: decoded.value };
}

function requestFor(fixture: Fixture, overrides: Partial<Parameters<typeof freezeFilmSetRecording>[0]["request"]> = {}) {
  const clipId = filmSetAnimationsOf(fixture.animation).clips[0]!.id;
  const aspect = "16:9";
  return {
    request: {
      requestId: "req-1",
      purpose: "export" as const,
      canvasId: "c1",
      nodeId: "film",
      clipId,
      profileKey: nativeRecordingProfileKey(aspect),
      ...overrides
    },
    clipId
  };
}

function freeze(
  fixture: Fixture,
  overrides: {
    assets?: StoredAsset[];
    node?: { width?: number; height?: number };
    readOnly?: boolean;
    hasPendingDraft?: boolean;
    request?: Partial<Parameters<typeof freezeFilmSetRecording>[0]["request"]>;
    /** 主题镜头背景色（D6）。 */
    themeBackdrop?: string;
  } = {}
) {
  const { request } = requestFor(fixture, overrides.request);
  // profile 与 profileKey 必须自洽：调用方给了档位就按该档位算 key（与浏览器/原生提交一致）。
  const profileKey = overrides.request?.profile && !overrides.request.profileKey
    ? nativeRecordingProfileKey("16:9", overrides.request.purpose === "reference" ? "standard" : overrides.request.profile)
    : request.profileKey;
  return freezeFilmSetRecording({ prepareFrame: nativeFilmSetFrame,
    request: { ...request, profileKey },
    nodeData: fixture.nodeData,
    assets: overrides.assets ?? [],
    ...(overrides.node ? { node: overrides.node } : {}),
    canvasRevision: 7,
    sourceIncarnation: "incarnation-1",
    ...(overrides.themeBackdrop ? { themeBackdrop: overrides.themeBackdrop } : {}),
    ...(overrides.readOnly !== undefined ? { readOnly: overrides.readOnly } : {}),
    ...(overrides.hasPendingDraft !== undefined ? { hasPendingDraft: overrides.hasPendingDraft } : {})
  });
}

describe("freezeFilmSetRecording", () => {
  it("freezes a self-contained snapshot with stable identity and profile", () => {
    const fixture = makeAnimation();
    const result = freeze(fixture);
    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result) || !result.ok) return;
    const snapshot = result.snapshot;
    expect(snapshot.schemaVersion).toBe("woohaa-recording-snapshot-v1");
    expect(snapshot.profile.container).toBe("mp4");
    expect(snapshot.profile.codec).toBe("h264");
    expect(snapshot.profile.width).toBe(1280);
    expect(snapshot.profile.height).toBe(720);
    expect(snapshot.profile.includeAudio).toBe(false);
    expect(snapshot.timing.frameRateNumer).toBe(30);
    expect(snapshot.timing.durationNumer / snapshot.timing.durationDenom).toBe(4);
    expect(snapshot.origin.canvasRevision).toBe(7);
    expect(snapshot.origin.sourceIncarnation).toBe("incarnation-1");
    // Scene IR 与动作轨道都是编译产物（JSON 文本），不是脚本。
    const scene = JSON.parse(snapshot.sceneIrJson) as { sceneVersion: string; ops: unknown[] };
    expect(scene.sceneVersion).toBe("woohaa-model-scene-ir-v2");
    expect(Array.isArray(scene.ops)).toBe(true);
    const motion = JSON.parse(snapshot.motionJson) as { duration: number; cameraMotion: unknown[] };
    expect(motion.duration).toBe(4);
    expect(Array.isArray(motion.cameraMotion)).toBe(true);
    // 编译产物里不出现可执行脚本源码。
    expect(snapshot.sceneIrJson).not.toContain("modelScript");
    expect(snapshot.motionJson).not.toContain("motionScript");
  });

  it("freezes authoritative dimensions and object motion in preview-compatible fields", () => {
    const result = freeze(makeAnimation(), { node: { width: 1566, height: 1158 } });
    if (!result.ok) throw new Error("freeze failed");
    const scene = JSON.parse(result.snapshot.sceneIrJson);
    expect(scene.compositeAssetFrame).toMatchObject({ width: 1566, height: 1158 });
    expect(scene.compositeAssetFrame.resourceExtent).toBeGreaterThan(0);
    const motion = JSON.parse(result.snapshot.motionJson);
    expect(motion.modelMotion).toEqual([]);
    expect(motion.objects.length).toBeGreaterThan(0);
    expect(motion.objects[0]).toHaveProperty("modelMotion");
    expect(motion.initialCamera.aspect).toBe("16:9");
  });

  it("selects the extension profile when the export control omits a profile", () => {
    const result = freeze(makeAnimation(), { request: { profileKey: "" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.profile.profileKey).toContain("native-v1");
  });

  it("chooses the authoritative portrait profile without a caller profile", () => {
    const fixture = makeAnimation();
    const data = structuredClone(fixture.animation);
    data.filmSetAnimations!.clips[0]!.initialCamera.aspect = "3:4";
    const nodeData = canonicalFilmSetFields(data) as unknown as CanvasNodeData;
    const decoded = decodeFilmSetNodeData(nodeData);
    if (!decoded.ok) throw new Error(decoded.reason);
    const result = freeze({ nodeData, animation: decoded.value }, { request: { profileKey: "" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.profile.profileKey).toBe(nativeRecordingProfileKey("3:4"));
  });

  it("is deterministic for the same committed input", () => {
    const fixture = makeAnimation();
    const first = freeze(fixture);
    const second = freeze(fixture);
    if (!("ok" in first) || !first.ok || !("ok" in second) || !second.ok) throw new Error("freeze failed");
    expect(recordingSnapshotHash(first.snapshot)).toBe(recordingSnapshotHash(second.snapshot));
  });

  it("excludes the node title from the identity", () => {
    // 只改片场节点标题（不动 item 名）：重命名不得触发重新录制。
    const fixture = makeAnimation({ title: "片场" });
    const renamedNodeData = { ...(fixture.nodeData as unknown as Record<string, unknown>), title: "改了名字" } as unknown as CanvasNodeData;
    const base = freeze(fixture);
    const renamed = freeze({ ...fixture, nodeData: renamedNodeData });
    if (!("ok" in base) || !base.ok || !("ok" in renamed) || !renamed.ok) throw new Error("freeze failed");
    expect(renamed.snapshot.origin.sourceIdentity).toBe(base.snapshot.origin.sourceIdentity);
    expect(recordingSnapshotHash(renamed.snapshot)).toBe(recordingSnapshotHash(base.snapshot));
  });

  it("changes identity when media checksum changes for the same assetId", () => {
    const fixture = withVideo(makeAnimation());
    const withA = freeze(fixture, { assets: [mediaAsset({ checksum: CHECKSUM_A })] });
    const withB = freeze(fixture, { assets: [mediaAsset({ checksum: CHECKSUM_B, storageKey: `sha256-${CHECKSUM_B}` })] });
    if (!("ok" in withA) || !withA.ok || !("ok" in withB) || !withB.ok) throw new Error("freeze failed");
    expect(withA.snapshot.origin.sourceIdentity).not.toBe(withB.snapshot.origin.sourceIdentity);
    // 资产 id 未变，但冻结资源里的 checksum 与 storageKey 变了。
    expect(withA.snapshot.resources[0]!.checksum).toBe(CHECKSUM_A);
    expect(withB.snapshot.resources[0]!.checksum).toBe(CHECKSUM_B);
  });

  it("does not change identity when only canvas layout changes", () => {
    const fixture = makeAnimation();
    const a = freezeFilmSetRecording({ prepareFrame: nativeFilmSetFrame,
      request: requestFor(fixture).request,
      nodeData: fixture.nodeData,
      assets: [],
      canvasRevision: 1,
      sourceIncarnation: "i1"
    });
    const b = freezeFilmSetRecording({ prepareFrame: nativeFilmSetFrame,
      request: requestFor(fixture).request,
      nodeData: fixture.nodeData,
      assets: [],
      canvasRevision: 2,
      sourceIncarnation: "i1"
    });
    if (!("ok" in a) || !a.ok || !("ok" in b) || !b.ok) throw new Error("freeze failed");
    // 画布 revision 会进快照（用于诊断），但不改变视觉内容身份。
    expect(a.snapshot.origin.sourceIdentity).toBe(b.snapshot.origin.sourceIdentity);
    expect(a.snapshot.origin.canvasRevision).toBe(1);
    expect(b.snapshot.origin.canvasRevision).toBe(2);
  });

  it("rejects history/read-only canvases", () => {
    const result = freeze(makeAnimation(), { readOnly: true });
    expect(result).toEqual({ ok: false, code: "recording-source-invalid", message: "只读历史不能生成录制任务" });
  });

  it("rejects pending working drafts instead of mixing them in", () => {
    const result = freeze(makeAnimation(), { hasPendingDraft: true });
    expect("ok" in result && result.ok).toBe(false);
    if ("ok" in result && !result.ok) expect(result.code).toBe("recording-source-invalid");
  });

  it("rejects clips without a positive duration", () => {
    const fixture = makeAnimation({ duration: 4 });
    // 直接把权威时间线时长改成 0：录制必须在接受前拒绝，而不是产出零帧成片。
    const nodeData = structuredClone(fixture.nodeData) as unknown as {
      filmSetAnimations?: { clips: Array<{ timeline: { duration: number } }> };
    };
    for (const clip of nodeData.filmSetAnimations?.clips ?? []) clip.timeline.duration = 0;
    const request = requestFor(fixture).request;
    const result = freezeFilmSetRecording({ prepareFrame: nativeFilmSetFrame,
      request,
      nodeData,
      assets: [],
      canvasRevision: 1,
      sourceIncarnation: "i"
    });
    expect("ok" in result && result.ok).toBe(false);
    // 零时长可能在解码阶段就被拒绝，也可能落到显式时长校验；两者都是
    // `recording-source-invalid`，都必须在接受任务前失败。
    if ("ok" in result && !result.ok) expect(result.code).toBe("recording-source-invalid");
  });

  it("rejects invalid model scripts", () => {
    // 静态不可编译的脚本（不使用死循环：编译器本身会执行脚本，测试不应依赖超时）。
    const fixture = makeAnimation({ modelScript: `scene.notAThing({});` });
    const result = freeze(fixture);
    expect("ok" in result && result.ok).toBe(false);
    if ("ok" in result && !result.ok) expect(result.code).toBe("recording-source-invalid");
  });

  it("rejects a caller-supplied profile instead of silently downgrading", () => {
    const fixture = makeAnimation();
    const result = freeze(fixture, { request: { profileKey: browserReferenceProfileKey() } });
    expect("ok" in result && result.ok).toBe(false);
    if ("ok" in result && !result.ok) expect(result.code).toBe("recording-profile-unsupported");
  });

  it("rejects missing or non-ready media", () => {
    const fixture = withVideo(makeAnimation());
    const missing = freeze(fixture, { assets: [] });
    expect("ok" in missing && missing.ok).toBe(false);
    const pending = freeze(fixture, { assets: [{ ...mediaAsset(), status: "generating" } as StoredAsset] });
    expect("ok" in pending && pending.ok).toBe(false);
    const noChecksum = freeze(fixture, {
      assets: [{ ...mediaAsset(), metadata: { storageKey: "sha256-x", contentType: "video/mp4", size: 1 } } as StoredAsset]
    });
    expect("ok" in noChecksum && noChecksum.ok).toBe(false);
    const wrongType = freeze(fixture, { assets: [mediaAsset({ contentType: "image/png" })] });
    expect("ok" in wrongType && wrongType.ok).toBe(false);
  });

  it("enforces per-file and total resource budgets", () => {
    const fixture = withVideo(makeAnimation());
    const perFile = freezeFilmSetRecording({ prepareFrame: nativeFilmSetFrame,
      request: requestFor(fixture).request,
      nodeData: fixture.nodeData,
      assets: [mediaAsset({ size: 10_000 })],
      canvasRevision: 1,
      sourceIncarnation: "i",
      maxResourceBytes: 1_000
    });
    expect("ok" in perFile && perFile.ok).toBe(false);
    if ("ok" in perFile && !perFile.ok) expect(perFile.code).toBe("recording-budget-exceeded");

    const total = freezeFilmSetRecording({ prepareFrame: nativeFilmSetFrame,
      request: requestFor(fixture).request,
      nodeData: fixture.nodeData,
      assets: [mediaAsset({ size: 900 })],
      canvasRevision: 1,
      sourceIncarnation: "i",
      maxTotalResourceBytes: 500
    });
    expect("ok" in total && total.ok).toBe(false);
  });

  it("validates resource readability asynchronously", async () => {
    const fixture = withVideo(makeAnimation());
    const result = freeze(fixture, { assets: [mediaAsset()] });
    if (!("ok" in result) || !result.ok) throw new Error("freeze failed");
    const readable = await validateRecordingResources(result.snapshot, async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "video/mp4"
    }));
    expect(readable).toEqual({ ok: true });

    const unreadable = await validateRecordingResources(result.snapshot, async () => {
      throw new Error("missing");
    });
    expect(unreadable.ok).toBe(false);

    const wrongType = await validateRecordingResources(result.snapshot, async () => ({
      bytes: new Uint8Array([1]),
      contentType: "image/png"
    }));
    expect(wrongType.ok).toBe(false);
  });
});

describe("native profile identity", () => {
  it("does not reuse the browser cache profile", () => {
    const native = nativeRecordingProfileKey("16:9");
    expect(native).not.toBe(browserReferenceProfileKey());
    expect(native).toContain(FILM_SET_RECORDING_CODEC_REVISION);
    expect(browserReferenceProfileKey()).toContain("r2");
    expect(native).not.toContain("-r2");
  });

  it("encodes size, renderer, compiler, codec and colour in the key", () => {
    const key = nativeRecordingProfileKey("9:16");
    expect(key).toContain("720x1280@30");
    expect(key.split("-").length).toBeGreaterThan(4);
  });

  it("keeps the shot aspect in profile dimensions", () => {
    expect(recordingProfile("9:16").width).toBe(720);
    expect(recordingProfile("9:16").height).toBe(1280);
    expect(recordingProfile("16:9").width).toBe(1280);
    expect(recordingProfile("16:9").height).toBe(720);
  });

  it("produces a stable cache key format", () => {
    const key = nativeReferenceCacheKey({
      canvasId: "c1",
      filmSetNodeId: "film",
      clipId: "clip",
      contentIdentity: "abc",
      profileKey: "native-v1"
    });
    expect(key).toBe("shot-reference:c1:film:clip:abc:native-v1");
  });
});

describe("planFilmSetRecordingCommit", () => {
  const artifact = {
    storageKey: `sha256-${CHECKSUM_A}`,
    checksum: CHECKSUM_A,
    mimeType: "video/mp4",
    sizeBytes: 4096,
    width: 1280,
    height: 720,
    durationSeconds: 4,
    frameRate: 30,
    hasAudio: false
  };
  const base = {
    requestId: "req-1",
    canvasId: "c1",
    nodeId: "film",
    clipId: "clip-1",
    sourceIncarnation: "incarnation-1",
    contentIdentity: "identity-1",
    profileKey: "native-v1",
    artifact,
    title: "片场 · 镜头 1"
  };

  it("creates a single asset for a reference recording", () => {
    const plan = planFilmSetRecordingCommit({
      request: { ...base, purpose: "reference" },
      now: NOW
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.commands).toHaveLength(1);
    const upsert = plan.commands[0]!;
    expect(upsert.type).toBe("asset.upsert");
    if (upsert.type !== "asset.upsert") return;
    expect(upsert.asset.id).toBe(
      nativeReferenceAssetId({ nodeId: "film", clipId: "clip-1", contentIdentity: "identity-1", profileKey: "native-v1" })
    );
    expect(upsert.asset.metadata?.shotReference).toMatchObject({
      filmSetNodeId: "film",
      clipId: "clip-1",
      contentIdentity: "identity-1",
      profileKey: "native-v1"
    });
    expect(plan.nodeId).toBeUndefined();
  });

  it("creates asset + video node for an export, placed right of the current source", () => {
    const plan = planFilmSetRecordingCommit({
      request: { ...base, purpose: "export" },
      source: { x: 100, y: 40, width: 320 },
      now: NOW
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.commands).toHaveLength(2);
    expect(plan.commands[0]!.type).toBe("asset.upsert");
    const add = plan.commands[1]!;
    expect(add.type).toBe("node.add");
    if (add.type !== "node.add") return;
    expect(add.node.position).toEqual({ x: 436, y: 40 });
    const data = add.nodeData as Record<string, unknown>;
    expect(data.filmSetVideoOrigin).toMatchObject({ filmSetNodeId: "film", clipId: "clip-1", native: true });
    expect(plan.nodeId).toBe(add.node.id);
    // 固定 commandId：重复提交幂等。
    expect(plan.commandId).toBe("native-film-set-video-req-1");
  });

  it("refuses export placement when the source was removed", () => {
    const plan = planFilmSetRecordingCommit({
      request: { ...base, purpose: "export" },
      source: null,
      now: NOW
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("recording-source-removed");
  });

  it("is idempotent for the same requestId", () => {
    const first = planFilmSetRecordingCommit({ request: { ...base, purpose: "export" }, source: { x: 0, y: 0, width: 10 }, now: NOW });
    const second = planFilmSetRecordingCommit({ request: { ...base, purpose: "export" }, source: { x: 0, y: 0, width: 10 }, now: NOW });
    if (!first.ok || !second.ok) throw new Error("plan failed");
    expect(first.commandId).toBe(second.commandId);
    expect(first.nodeId).toBe(second.nodeId);
  });
});

describe("recording helpers", () => {
  it("describes a clip for activity and file naming", () => {
    const fixture = makeAnimation();
    const clipId = filmSetAnimationsOf(fixture.animation).clips[0]!.id;
    const described = describeFilmSetRecording(fixture.nodeData, clipId);
    expect(described.title).toContain("片场");
    expect(described.duration).toBe(4);
    expect(described.aspect).toBe("16:9");
  });

  it("matches only film-set node data", () => {
    const fixture = makeAnimation();
    expect(matchesFilmSetRecording("composite-asset", fixture.nodeData)).toBe(true);
    expect(matchesFilmSetRecording("film-set", fixture.nodeData)).toBe(true);
    expect(matchesFilmSetRecording("video", fixture.nodeData)).toBe(false);
    expect(matchesFilmSetRecording("composite-asset", { nonsense: true })).toBe(false);
  });

  it("gives distinct reasons for every unavailable cause", () => {
    const messages = (
      ["no-runtime", "unsupported-platform", "no-executor", "software-gpu", "missing-codec", "protocol-mismatch"] as const
    ).map(describeRecordingUnavailable);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
  });
});

describe("导出 profile 与镜头背景（D6/D7）", () => {
  it("standard 与改动前完全一致；hd/hd60 按 profile 输出", () => {
    const fixture = makeAnimation();
    const standard = freeze(fixture, { request: { profile: "standard" } });
    expect(standard.ok).toBe(true);
    if (!standard.ok) return;
    expect(standard.snapshot.profile).toMatchObject({ width: 1280, height: 720, bitrate: 4_000_000 });
    expect(standard.snapshot.timing.frameRateNumer).toBe(30);

    const hd = freeze(fixture, { request: { profile: "hd" } });
    expect(hd.ok).toBe(true);
    if (!hd.ok) return;
    expect(hd.snapshot.profile).toMatchObject({ width: 1920, height: 1080, bitrate: 8_000_000 });
    expect(hd.snapshot.timing.frameRateNumer).toBe(30);

    const hd60 = freeze(fixture, { request: { profile: "hd60" } });
    expect(hd60.ok).toBe(true);
    if (!hd60.ok) return;
    expect(hd60.snapshot.profile).toMatchObject({ width: 1920, height: 1080, bitrate: 12_000_000 });
    expect(hd60.snapshot.timing.frameRateNumer).toBe(60);
  });

  it("参考录制固定 standard，不随显式导出档位变化", () => {
    const fixture = makeAnimation();
    const reference = freeze(fixture, { request: { purpose: "reference", profile: "hd60" } });
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(reference.snapshot.profile.width).toBe(1280);
    expect(reference.snapshot.timing.frameRateNumer).toBe(30);
  });

  it("镜头背景 theme 解析为具体主题色；自定义色原样进入录制输入", () => {
    const fixture = makeAnimation();
    const themed = freeze(fixture, { themeBackdrop: "#101418" });
    expect(themed.ok).toBe(true);
    if (!themed.ok) return;
    expect(themed.snapshot.background).toBe("#101418");

    const nodeData = structuredClone(fixture.nodeData) as unknown as { filmSetAnimations: { clips: Array<Record<string, unknown>> } };
    nodeData.filmSetAnimations.clips[0]!.backdrop = "#000000";
    const decoded = decodeFilmSetNodeData(nodeData);
    expect(decoded.ok).toBe(true);
    const custom = freeze({ nodeData: nodeData as unknown as CanvasNodeData, animation: decoded.ok ? decoded.value : fixture.animation }, { themeBackdrop: "#101418" });
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    expect(custom.snapshot.background).toBe("#000000");
  });

  it("旧镜头（无 backdrop）解码为 theme，身份与改动前一致", () => {
    const fixture = makeAnimation();
    const clip = filmSetAnimationsOf(fixture.animation).clips[0]!;
    expect(clip.backdrop).toBeUndefined();
    const frozen = freeze(fixture);
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    // 默认主题色来自应用默认主题的 webSubtle。
    expect(frozen.snapshot.background).toMatch(/^#[0-9a-f]{6}$/);
  });
});

void (null as unknown as typeof recordingVideoSize);
void (null as unknown as CanvasNodeData);
