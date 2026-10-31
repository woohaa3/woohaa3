import { planCompositeChildLayout } from "./composite-children.js";
import { SHOT_CAMERA_ABSOLUTE_MIN_DISTANCE } from "./shot-camera.js";
import { clampCameraElevation } from "./model-cameras.js";
/**
 * 拍摄镜头预览节点契约
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，D2/D4）。
 *
 * 每个当前拍摄镜头（机器协议仍称 clip）在**同画布**恰有一个 `film-set-shot-preview`
 * 节点。该节点是实时 3D 取景窗口的规范归属记录，**不是**媒体资产：
 *
 * - 规范 nodeData 只含严格版本化的 `shotPreview` 归属（filmSetNodeId + clipId）；
 * - 标题、类型、画幅、时长、错误与封面都是所属镜头的**只读投影**，不在节点上复制第二份
 *   权威数据；无 outputAssetId / result URL / 视频文件 / 材质句柄；
 * - 归属线是 Render Scene 的派生呈现（见 D5），不进入 `document.edges` 或 inputMapping；
 * - 位置、尺寸、zIndex 复用节点标准字段。
 *
 * 节点 ID 固定为 `shot-preview:` 加**完整** SHA-256 摘要的 base64url 编码，摘要输入为
 * 版本化的规范 JSON 元组 `["film-set-shot-preview-v1", filmSetNodeId, clipId]`；使用全部
 * 256 位，不截短、不使用顺序号。相同 UTF-8 编码与摘要实现由本模块共用（浏览器/服务端/迁移
 * 一致），输出长度固定，不受旧源 ID 长度膨胀影响。
 */
import { isBoundedId, isJsonObject } from "../validation.js";
import { decodeMediaContentRef } from "./media-content.js";
import { managedNodeRelationOf } from "./managed-node.js";
import type { InitialShotCamera, AnimationTimeline } from "./canvas-node-model.js";
import type { FilmSetAnimationClip, FilmSetAnimations, FilmSetShotKind } from "./film-set-animations.js";
import { filmSetAnimationsOf } from "./film-set-clip-view.js";
import type { FilmSetNodeData } from "./canvas-node-model.js";
import {
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  SHOT_PREVIEW_IDENTITY_PREFIX,
  SHOT_PREVIEW_ID_ENCODED_LENGTH,
  SHOT_PREVIEW_ID_PREFIX,
  isShotPreviewNodeIdShape,
  isShotPreviewNodeType
} from "./domain/core/shot-preview-node.js";

// 类型判别与 ID 前缀的唯一事实源在中立叶子模块（domain/core/shot-preview-node.ts）；
// 这里再导出，保持既有公共入口不变。
export {
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  SHOT_PREVIEW_IDENTITY_PREFIX,
  SHOT_PREVIEW_ID_PREFIX,
  isShotPreviewNodeType
};

/** 归属数据契约版本；结构变化必须升版本，在线 decoder 只接受当前版本。 */
export const SHOT_PREVIEW_SCHEMA_VERSION = 1 as const;

/** 严格版本化的节点归属；只保存两个稳定引用，不复制源镜头内容。 */
export type ShotPreviewOwnership = {
  schemaVersion: typeof SHOT_PREVIEW_SCHEMA_VERSION;
  filmSetNodeId: string;
  clipId: string;
};

/** 预览节点 nodeData（只含归属）。 */
export type FilmSetShotPreviewData = {
  shotPreview: ShotPreviewOwnership;
};

/** 默认卡片宽（画布单位）。按镜头 aspect 派生内容高度，另加共享标题区。 */
export const SHOT_PREVIEW_CARD_WIDTH = 240;
/** 卡片标题区高度（画布单位）。 */
export const SHOT_PREVIEW_HEADER_HEIGHT = 52;
/** 卡片内容区最小高度（极端竖画幅兜底，保持可辨识）。 */
export const SHOT_PREVIEW_CONTENT_MIN_HEIGHT = 48;
/** 卡片内容区最大高度（极端横画幅兜底）。 */
export const SHOT_PREVIEW_CONTENT_MAX_HEIGHT = 320;
/** 新预览放置时相对片场可见范围右侧的留白（画布单位）。 */
export const SHOT_PREVIEW_LAYOUT_GAP = 48;
/** 竖排卡片间距（画布单位）。 */
export const SHOT_PREVIEW_LAYOUT_SPACING = 24;
/** 重叠避让时的固定竖直步长（画布单位）；只用于首次放置，不重排已放置节点。 */
export const SHOT_PREVIEW_LAYOUT_STEP = 32;
/** 为同一片场的预览寻找空位的最大尝试次数。 */
export const SHOT_PREVIEW_LAYOUT_MAX_ATTEMPTS = 64;

export type ShotPreviewDataDecodeResult =
  | { ok: true; value: FilmSetShotPreviewData }
  | { ok: false; reason: string };

/** 严格解码预览归属；缺失/非法整体拒绝，不猜测。 */
export function decodeShotPreviewData(input: unknown): ShotPreviewDataDecodeResult {
  if (!isJsonObject(input)) return { ok: false, reason: "预览 nodeData 必须是对象" };
  const ownership = input.shotPreview;
  if (!isJsonObject(ownership)) return { ok: false, reason: "预览节点缺少 shotPreview 归属" };
  if (ownership.schemaVersion !== SHOT_PREVIEW_SCHEMA_VERSION) {
    return { ok: false, reason: `不支持的 shotPreview 版本（要求 ${SHOT_PREVIEW_SCHEMA_VERSION}）` };
  }
  if (!isBoundedId(ownership.filmSetNodeId) || !isBoundedId(ownership.clipId)) {
    return { ok: false, reason: "shotPreview 的 filmSetNodeId/clipId 非法" };
  }
  return {
    ok: true,
    value: {
      shotPreview: {
        schemaVersion: SHOT_PREVIEW_SCHEMA_VERSION,
        filmSetNodeId: ownership.filmSetNodeId,
        clipId: ownership.clipId
      }
    }
  };
}

/** 是否为合法预览 nodeData（解码通过）。 */
export function isShotPreviewNodeData(input: unknown): boolean {
  return decodeShotPreviewData(input).ok;
}

/** 读取预览归属；非预览节点返回 null。 */
export function shotPreviewOwnershipOf(input: unknown): ShotPreviewOwnership | null {
  const decoded = decodeShotPreviewData(input);
  return decoded.ok ? decoded.value.shotPreview : null;
}

/**
 * 迁移后的镜头预览形态：片场 group 通过 `managedBy` 拥有一个 owner-managed 媒体节点
 * （`mediaContent.providerId === "film-set.shot"`），不再写 `shotPreview` 字段。
 *
 * 归属身份必须与 owner/clip 完全一致（`managedBy` 与 `mediaContent.payload` 互相印证），
 * 这样卡片呈现与归属线在旧/新两种形态下都指向同一 owner + clip，不产生第二份权威数据。
 */
export function managedShotPreviewOwnershipOf(input: unknown): ShotPreviewOwnership | null {
  const relation = managedNodeRelationOf(input);
  if (!relation || relation.extensionId !== "film-set") return null;
  const media = (input as { mediaContent?: unknown } | null | undefined)?.mediaContent;
  const decoded = decodeMediaContentRef(media);
  if (!decoded.ok || decoded.value.providerId !== "film-set.shot") return null;
  const payload = decoded.value.payload as { filmSetNodeId?: unknown; clipId?: unknown };
  if (typeof payload.filmSetNodeId !== "string" || typeof payload.clipId !== "string") return null;
  if (payload.filmSetNodeId !== relation.ownerNodeId || payload.clipId !== relation.entityId) return null;
  return { schemaVersion: SHOT_PREVIEW_SCHEMA_VERSION, filmSetNodeId: payload.filmSetNodeId, clipId: payload.clipId };
}

/** 预览归属的规范序列化值（写入口使用，剥离未知字段）。 */
export function canonicalShotPreviewFields(data: FilmSetShotPreviewData): Record<string, unknown> {
  return { shotPreview: { ...data.shotPreview } };
}

/** 规范身份元组（版本化；顺序与内容一旦发布不得更改）。 */
export function shotPreviewIdentityTuple(filmSetNodeId: string, clipId: string): readonly [string, string, string] {
  return [SHOT_PREVIEW_IDENTITY_PREFIX, filmSetNodeId, clipId];
}

/** 规范身份 JSON；UTF-8 编码稳定（无空格、键固定顺序）。 */
export function shotPreviewIdentityJson(filmSetNodeId: string, clipId: string): string {
  return JSON.stringify(shotPreviewIdentityTuple(filmSetNodeId, clipId));
}

/** 稳定预览节点 ID：`shot-preview:` + 完整 SHA-256 摘要的 base64url。 */
export function shotPreviewNodeId(filmSetNodeId: string, clipId: string): string {
  const digest = sha256Bytes(utf8Encode(shotPreviewIdentityJson(filmSetNodeId, clipId)));
  return `${SHOT_PREVIEW_ID_PREFIX}${base64UrlEncodeBytes(digest)}`;
}

/** 是否为本画布中合法形态的预览节点 ID（复用中立叶子模块的同一形状判定）。 */
export function isShotPreviewNodeId(value: unknown): value is string {
  return isShotPreviewNodeIdShape(value) && value.length === SHOT_PREVIEW_ID_PREFIX.length + SHOT_PREVIEW_ID_ENCODED_LENGTH;
}
/** 预览内容高度：由镜头 aspect（宽/高）派生，带可辨识上下限。 */
export function shotPreviewContentHeight(aspect: number): number {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const raw = (SHOT_PREVIEW_CARD_WIDTH - 32) / safe;
  return Math.min(SHOT_PREVIEW_CONTENT_MAX_HEIGHT, Math.max(SHOT_PREVIEW_CONTENT_MIN_HEIGHT, raw));
}

/** 预览卡片整体尺寸（内容高度 + 标题区 + 底部内边距）。 */
export function shotPreviewCardSize(aspect: number): { width: number; height: number } {
  return {
    width: SHOT_PREVIEW_CARD_WIDTH,
    height: shotPreviewContentHeight(aspect) + SHOT_PREVIEW_HEADER_HEIGHT + 16
  };
}

/** 镜头 aspect（宽/高）；非法值退回 16:9。 */
export function shotAspectValue(clip: Pick<FilmSetAnimationClip, "initialCamera">): number {
  return aspectValueOfCamera(clip.initialCamera);
}

/**
 * 镜头初始相机（零点构图）的 wire 投影
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
 *
 * 静态与非活动动态卡片只在 T=0 取零点封面：GPU 侧据此在世界包围球上派生相机姿态，不需要
 * 逐帧动作 IR，也不传像素。焦距/方位/仰角/注视点偏移与 `initialCamera` 同构；`aspect` 单独
 * 由 `aspect` 字段承载。
 */
export type ShotCoverCamera = {
  azimuth: number;
  elevation: number;
  distance: number;
  focusOffset: [number, number, number];
};

export function shotCoverCamera(clip: Pick<FilmSetAnimationClip, "initialCamera">): ShotCoverCamera {
  const camera = clip.initialCamera;
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  const distance = finite(camera.distance, 4);
  return {
    azimuth: finite(camera.azimuth, 0),
    // 规范半圆包含 ±90° 端点；这里只把越界/非有限值收回规范范围。与世界上方向共线的
    // 实际姿态由渲染器派生层钳到 ±89°，整帧不因端点值被拒绝。
    elevation: clampCameraElevation(camera.elevation),
    distance: Math.max(SHOT_CAMERA_ABSOLUTE_MIN_DISTANCE, distance),
    focusOffset: [
      finite(camera.focusOffset.x, 0),
      finite(camera.focusOffset.y, 0),
      finite(camera.focusOffset.z, 0)
    ]
  };
}

function aspectValueOfCamera(camera: InitialShotCamera): number {
  const raw = camera.aspect;
  if (typeof raw !== "string") return 16 / 9;
  const parts = raw.split(":");
  if (parts.length !== 2) return 16 / 9;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 16 / 9;
  return width / height;
}

/** 预览放置所需的画布矩形（绝对坐标）。 */
export type ShotPreviewBounds = { x: number; y: number; width: number; height: number };

export type ShotPreviewPlacement = { x: number; y: number; width: number; height: number };

/**
 * 确定性初始布局：把预览放在片场可见范围右侧留 `SHOT_PREVIEW_LAYOUT_GAP`，按镜头顺序竖排、
 * 卡片间距 `SHOT_PREVIEW_LAYOUT_SPACING`；与已占用矩形重叠时按固定步长沿同列继续寻找空位。
 *
 * 纯函数、无随机、不重排已放置节点：只计算**本次新增**预览的落点，输入顺序决定结果。
 */
export function planShotPreviewLayout(input: {
  filmSetBounds: ShotPreviewBounds;
  /** 按镜头顺序排列的待放置尺寸（宽、高）。 */
  sizes: readonly { width: number; height: number }[];
  /** 已占用矩形（绝对坐标；用于避免重叠）。 */
  occupied: readonly ShotPreviewBounds[];
}): ShotPreviewPlacement[] {
  return planCompositeChildLayout({ ownerBounds: input.filmSetBounds, sizes: input.sizes, occupied: input.occupied,
    gap: SHOT_PREVIEW_LAYOUT_GAP, spacing: SHOT_PREVIEW_LAYOUT_SPACING, step: SHOT_PREVIEW_LAYOUT_STEP, maxAttempts: SHOT_PREVIEW_LAYOUT_MAX_ATTEMPTS });
}

/**
 * 从源镜头集合派生出应存在的预览闭包（纯函数，供 reconciliation 与测试复用）。
 *
 * 每个镜头一个条目，顺序与 `clips` 一致；无镜头片场返回空数组。
 */
export type ShotPreviewTarget = {
  filmSetNodeId: string;
  clipId: string;
  nodeId: string;
  kind: FilmSetShotKind;
  name: string;
  timeline: AnimationTimeline;
  backdrop?: string;
  aspect: number;
  /** 零点封面相机（静态与非活动动态卡片使用；design D7）。 */
  coverCamera: ShotCoverCamera;
};

export function shotPreviewTargetsOf(filmSetNodeId: string, animation: { filmSetAnimations?: FilmSetAnimations }): ShotPreviewTarget[] {
  return filmSetAnimationsOf(animation).clips.map((clip) => ({
    filmSetNodeId,
    clipId: clip.id,
    nodeId: shotPreviewNodeId(filmSetNodeId, clip.id),
    kind: clip.kind,
    name: clip.name,
    timeline: { duration: clip.timeline.duration, loop: clip.timeline.loop },
    ...(clip.backdrop && clip.backdrop !== "theme" ? { backdrop: clip.backdrop } : {}),
    aspect: shotAspectValue(clip),
    coverCamera: shotCoverCamera(clip)
  }));
}

/** 从片场节点数据派生应存在的预览闭包。 */
export function shotPreviewTargetsForFilmSet(filmSetNodeId: string, data: FilmSetNodeData): ShotPreviewTarget[] {
  return shotPreviewTargetsOf(filmSetNodeId, data);
}

// ---------------------------------------------------------------------------
// 稳定 SHA-256（纯实现，浏览器/Node 一致；不依赖 crypto 全局或 Node 模块）
// ---------------------------------------------------------------------------

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

/** 计算字符串 UTF-8 字节的完整 SHA-256 摘要（32 字节）。 */
export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = bytes.length;
  const bitLenHi = Math.floor(length / 0x20000000);
  const bitLenLo = (length << 3) >>> 0;
  const paddedLength = ((length + 8) >> 6 << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLenHi, false);
  view.setUint32(paddedLength - 4, bitLenLo, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i], false);
  return out;
}

/** 完整 SHA-256 的小写 hex（64 位十六进制）。同步实现，供预览身份派生与向量测试使用。 */
export function shotPreviewSha256Hex(value: string): string {
  return Array.from(sha256Bytes(utf8Encode(value)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rotr(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

/** UTF-8 编码（与 TextEncoder 一致；不依赖全局可用性）。 */
export function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url（无填充）编码字节数组。 */
export function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    output += BASE64URL_ALPHABET[b0 >> 2];
    if (b1 === undefined) {
      output += BASE64URL_ALPHABET[(b0 & 0x03) << 4];
      break;
    }
    output += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (b2 === undefined) {
      output += BASE64URL_ALPHABET[(b1 & 0x0f) << 2];
      break;
    }
    output += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    output += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return output;
}
