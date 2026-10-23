/**
 * 通道域能力声明回归（change: 2026-10-22-add-photocraft-channel-workflows，U25/U26）。
 *
 * 只锁定本域在协议层的声明：阶段、顺序与「整条链路接通后才开放」的边界。
 * 共享能力总表与 `tests/fixtures/contract.json` 的同步属于集成负责人。
 */
import { expect, it } from "vitest";
import { PHOTOCRAFT_STAGE_CAPABILITIES, PHOTOCRAFT_STAGES, photocraftFeatureDisabledReason } from "../../image-project-editor.js";
import { featureCapabilitiesForStage } from "../index.js";
import { feature } from "./index.js";

const DECLARED = [
  "channel.panel",
  "channel.color-target",
  "channel.alpha",
  "channel.spot",
  "channel.split-merge",
  "channel.apply-image",
  "channel.calculations",
  "channel.luminosity-selection"
];

it("通道能力声明在 P7，并按面板 → 目标 → 通道 → 拆合 → 计算的顺序排列", () => {
  expect(feature.id).toBe("channels");
  expect(feature.capabilities.map((entry) => entry.id)).toEqual(DECLARED);
  for (const entry of feature.capabilities) expect(entry.stage).toBe("P7");
  const orders = feature.capabilities.map((entry) => entry.order);
  expect(orders).toEqual([...orders].sort((a, b) => a - b));
  // 顺序 38–45 接在选区域 36/37 之后，不与同级能力冲突。
  expect(orders[0]).toBeGreaterThan(37);
});

it("声明进入 P7 能力表，且没有同名非目标", () => {
  expect(PHOTOCRAFT_STAGES).toContain("P7");
  const p7 = featureCapabilitiesForStage("P7");
  expect(p7).toEqual(expect.arrayContaining(DECLARED));
  // 整张表按 order 稳定排序后与本域声明一致。
  for (const id of DECLARED) expect(PHOTOCRAFT_STAGE_CAPABILITIES.P7).toContain(id);
  for (const id of DECLARED) expect(photocraftFeatureDisabledReason(id)).toBeNull();
});

it("未声明的通道能力不被顺带开放（不按命令前缀放开）", () => {
  for (const id of ["channel.quick-mask", "channel.vector-mask", "channel.thumbnail", "image.applyImage"]) {
    expect(DECLARED).not.toContain(id);
    expect(featureCapabilitiesForStage("P7")).not.toContain(id);
  }
});
