import { expect, it } from "vitest";
import { IMAGE_MODE_CAPABILITIES, IMAGE_MODE_COMMANDS, feature, featureCommands } from "./index.js";
import {
  PHOTOCRAFT_CAPABILITIES,
  PHOTOCRAFT_STAGE_CAPABILITIES,
  isPhotocraftCapabilityEnabled,
  photocraftFeatureDisabledReason
} from "../../image-project-editor.js";

/**
 * 本域协议声明回归（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 1.2 / 5.1）。
 *
 * 能力已在 P7 发布：这里锁定「本域清单 = 全局阶段清单 = 命令清单」三处一致，并断言六个
 * 模式命令确实落在已交付阶段（否则能力开放但命令门仍拒绝，界面会出现能点却必然失败的入口）。
 */

it("publishes the mode capabilities into the delivered P7 stage", () => {
  expect(feature.id).toBe("modes");
  expect(IMAGE_MODE_CAPABILITIES).toEqual(["image.modes", "image.color-table", "image.duotone"]);
  expect(feature.capabilities.map((entry) => entry.id)).toEqual([...IMAGE_MODE_CAPABILITIES]);
  for (const entry of feature.capabilities) expect(entry.stage).toBe("P7");

  // 全局阶段清单必须真的包含它们，且判定为已开放。
  const stageCaps: readonly string[] = PHOTOCRAFT_STAGE_CAPABILITIES.P7;
  for (const id of IMAGE_MODE_CAPABILITIES) {
    expect(stageCaps).toContain(id);
    expect(PHOTOCRAFT_CAPABILITIES).toContain(id);
    expect(isPhotocraftCapabilityEnabled(id)).toBe(true);
    expect(photocraftFeatureDisabledReason(id)).toBeNull();
  }
});

it("keeps the mode ids unique and namespaced", () => {
  expect(new Set(IMAGE_MODE_CAPABILITIES).size).toBe(IMAGE_MODE_CAPABILITIES.length);
  expect(new Set(IMAGE_MODE_COMMANDS).size).toBe(IMAGE_MODE_COMMANDS.length);
  for (const id of IMAGE_MODE_CAPABILITIES) expect(id).toMatch(/^image\./);
  for (const id of IMAGE_MODE_COMMANDS) expect(id).toMatch(/^image\.mode\./);
  // 每个能力 id 只能出现一次（重复登记会让握手顺序与归属含糊）。
  for (const id of IMAGE_MODE_CAPABILITIES) {
    expect(PHOTOCRAFT_CAPABILITIES.filter((candidate) => candidate === id)).toHaveLength(1);
  }
});

it("covers every mode target plus the color table command", () => {
  // 与内核 `mode::MODE_COMMANDS` 同一组 id；新增目标必须同时改两边。
  expect([...IMAGE_MODE_COMMANDS]).toEqual([
    "image.mode.rgb",
    "image.mode.grayscale",
    "image.mode.indexedColor",
    "image.mode.bitmap",
    "image.mode.duotone",
    "image.mode.colorTable"
  ]);
  expect(featureCommands.map((entry) => entry.id)).toEqual([...IMAGE_MODE_COMMANDS]);
  for (const entry of featureCommands) expect(entry.stage).toBe("P7");
});

it("keeps trap out of the published surface", () => {
  // 陷印需要 CMYK，属本次范围外；发布模式能力不能顺带承诺陷印。
  const trap = [...IMAGE_MODE_CAPABILITIES, ...IMAGE_MODE_COMMANDS].filter((id) => id.includes("trap"));
  expect(trap).toEqual([]);
});
