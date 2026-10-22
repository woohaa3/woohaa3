/**
 * 视频生成模式约束（change: add-audio-video-generation-and-align-model-catalog，任务 3.3）。
 */
import { describe, expect, it } from "vitest";
import {
  readGenerationMode,
  validateGenerationModeInputs,
  type GenerationMode
} from "./generation-mode";
import type { CanvasTaskInputBinding } from "../../task/dto";

const BINDINGS: CanvasTaskInputBinding[] = [
  {
    field: "frames",
    semantic: "reference-image",
    roles: ["first_frame", "last_frame"],
    mediaKinds: ["image"],
    mediaTypes: ["image/png"],
    maxItems: 2,
    valueFormat: "url"
  },
  {
    field: "videoUrls",
    semantic: "reference-video",
    roles: ["edit_video"],
    mediaKinds: ["video"],
    mediaTypes: ["video/mp4"],
    maxItems: 1,
    valueFormat: "url"
  }
];

describe("readGenerationMode", () => {
  it("默认 omni_reference", () => {
    expect(readGenerationMode(undefined)).toBe("omni_reference");
    expect(readGenerationMode({})).toBe("omni_reference");
    expect(readGenerationMode({ generationMode: "bogus" })).toBe("omni_reference");
    expect(readGenerationMode({ generationMode: "first_last_frame" })).toBe("first_last_frame");
  });
});

describe("validateGenerationModeInputs", () => {
  it("first_last_frame 允许各一个首尾帧", () => {
    expect(
      validateGenerationModeInputs(
        "first_last_frame",
        [
          { role: "first_frame", mediaKind: "image" },
          { role: "last_frame", mediaKind: "image" }
        ],
        BINDINGS
      )
    ).toEqual([]);
  });

  it("first_last_frame 拒绝重复首帧", () => {
    const reasons = validateGenerationModeInputs(
      "first_last_frame",
      [
        { role: "first_frame", mediaKind: "image" },
        { role: "first_frame", mediaKind: "image" }
      ],
      BINDINGS
    );
    expect(reasons.some((reason) => reason.includes("最多允许一个 first_frame"))).toBe(true);
  });

  it("first_last_frame 拒绝视频引用", () => {
    const reasons = validateGenerationModeInputs(
      "first_last_frame",
      [{ role: "reference_video", mediaKind: "video" }],
      BINDINGS
    );
    expect(reasons.some((reason) => reason.includes("只接受图片引用"))).toBe(true);
  });

  it("edit_video 要求恰好一个视频", () => {
    expect(
      validateGenerationModeInputs("edit_video", [{ role: "edit_video", mediaKind: "video" }], BINDINGS)
    ).toEqual([]);
    expect(
      validateGenerationModeInputs("edit_video", [], BINDINGS).some((reason) => reason.includes("恰好一个"))
    ).toBe(true);
    expect(
      validateGenerationModeInputs(
        "edit_video",
        [
          { role: "edit_video", mediaKind: "video" },
          { role: "edit_video", mediaKind: "video" }
        ],
        BINDINGS
      ).some((reason) => reason.includes("恰好一个"))
    ).toBe(true);
  });

  it("edit_video 拒绝混入其它媒体", () => {
    const reasons = validateGenerationModeInputs(
      "edit_video",
      [
        { role: "edit_video", mediaKind: "video" },
        { role: "reference_image", mediaKind: "image" }
      ],
      BINDINGS
    );
    expect(reasons.some((reason) => reason.includes("不接受 reference_image"))).toBe(true);
  });

  it("omni_reference 不施加额外约束", () => {
    expect(
      validateGenerationModeInputs(
        "omni_reference",
        [
          { role: "reference_image", mediaKind: "image" },
          { role: "reference_video", mediaKind: "video" }
        ],
        BINDINGS
      )
    ).toEqual([]);
  });

  it("模型不接受该角色时阻止", () => {
    const reasons = validateGenerationModeInputs(
      "first_last_frame",
      [{ role: "first_frame", mediaKind: "image" }],
      [] // 无 bindings
    );
    expect(reasons.some((reason) => reason.includes("不接受 first_frame"))).toBe(true);
  });
});

void (null as unknown as GenerationMode);
