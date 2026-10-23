/**
 * 通道内容身份（change: 2026-10-22-add-photocraft-channel-workflows，任务 3.2）。
 *
 * 与 `rust/crates/editor-core/src/features/channels/content.rs` 逐字符一致：
 * 命名、种类、叠层颜色/不透明度、专色密度与平面像素摘要进入身份；查看态（目标/显隐）
 * 不进身份。没有通道时不写字段，旧工程身份保持逐字节不变。
 *
 * 接线由共享 `packages/protocol/src/features/shared/content.ts` 与
 * `rust/crates/editor-core/src/document_content.rs` 各加一处调用完成；未接线时本模块只被
 * 域内测试消费。
 */
import { fnv1a64Hex } from "../../content-hash.js";

/** 单个通道的身份行（由内核导出的摘要，不携带像素）。 */
export type ImageProjectChannelSummary = {
  name: string;
  kind: "alpha" | "spot";
  /** 叠层不透明度 0–1。 */
  opacity: number;
  /** 叠层表示：被蒙版区域 / 所选区域。 */
  indicates: "masked" | "selected";
  /** 叠层颜色 `#rrggbb`（Alpha）或专色墨色（spot）。 */
  color: string;
  /** 专色密度 0–1；非专色省略。 */
  solidity?: number;
  /** 完整稀疏平面内容摘要（16 位 hex）。 */
  contentHash: string;
};

/** 数值与内容指纹其它数值同精度（1e-4），`-0` 归一化为 `0`。 */
function round(value: number): string {
  const scaled = Math.round(value * 1e4) / 1e4;
  const normalized = Object.is(scaled, -0) ? 0 : scaled;
  return String(normalized);
}

/** UTF-16 长度（`String.length` 即此值；中文与 emoji 计数一致）。 */
function utf16Length(text: string): number {
  return text.length;
}

/**
 * 通道身份的规范文本；没有通道返回 `null`（调用方据此**不写**字段）。
 *
 * 文本形状：
 * ```text
 * channels:<count>
 * channel:<名称长度>:<名称>:<alpha|spot>:<opacity>:<masked|selected>:<color>:<solidity|->:<contentHash>
 * ```
 */
export function canonicalizeChannelContent(
  channels: readonly ImageProjectChannelSummary[]
): string | null {
  if (!Array.isArray(channels) || channels.length === 0) return null;
  const lines = [`channels:${channels.length}`];
  for (const channel of channels) {
    if (typeof channel.name !== "string") return null;
    if (channel.kind !== "alpha" && channel.kind !== "spot") return null;
    if (!Number.isFinite(channel.opacity)) return null;
    if (channel.indicates !== "masked" && channel.indicates !== "selected") return null;
    if (typeof channel.color !== "string" || !/^#[0-9a-f]{6}$/.test(channel.color)) return null;
    if (typeof channel.contentHash !== "string" || !/^[0-9a-f]{16}$/.test(channel.contentHash)) return null;
    if (channel.solidity !== undefined && !Number.isFinite(channel.solidity)) return null;
    const solidity = channel.kind === "spot"
      ? (channel.solidity === undefined ? null : round(channel.solidity))
      : "-";
    if (solidity === null) return null;
    lines.push(
      [
        "channel",
        utf16Length(channel.name),
        channel.name,
        channel.kind,
        round(channel.opacity),
        channel.indicates,
        channel.color,
        solidity,
        channel.contentHash
      ].join(":")
    );
  }
  return lines.join("\n");
}

/** 通道内容指纹；没有通道返回 `null`（旧身份兼容，不写字段）。 */
export function channelContentHash(
  channels: readonly ImageProjectChannelSummary[]
): string | null {
  const text = canonicalizeChannelContent(channels);
  return text === null ? null : fnv1a64Hex(text);
}
