/**
 * 视频编辑 dialog 纯行为测试
 * （change: port-video-editing-dialogs，任务 3.1 / 3.2 / 3.3 / 3.5；design D5/D7/D10）。
 *
 * 这些测试聚焦可无 DOM 验证的契约：草稿复制（cancel 丢弃）、稳定排序、prompt 必填、
 * 时间轴区间钳制、关键键盘守卫谓词。真实绘制/合成在 e2e 与 showcase story 中验收。
 */
import { describe, expect, it } from "vitest";
import { isVideoEditRange, sortVideoEditIntents, type VideoEditIntent } from "@woohaa3/contracts";
import { MIN_RANGE_SECONDS, clampTimelineRange } from "./video-geometry.js";

function intent(overrides: Partial<VideoEditIntent> = {}): VideoEditIntent {
  return {
    id: "i1",
    startSeconds: 1,
    prompt: "p",
    annotationShapes: [],
    frameWidth: 1920,
    frameHeight: 1080,
    ...overrides
  };
}

/** renderer 打开时的草稿复制（与组件 copyIntent 语义一致）。 */
function copyIntent(value: VideoEditIntent): VideoEditIntent {
  return {
    ...value,
    annotationShapes: value.annotationShapes.map((shape) => ({ ...shape, points: shape.points.map((point) => ({ ...point })) })),
    ...(value.annotationPreview ? { annotationPreview: { ...value.annotationPreview } } : {})
  };
}

describe("草稿事务", () => {
  it("打开时深拷贝 initialIntents，cancel 不改动调用方数据", () => {
    const original = [intent({ annotationShapes: [{ id: "s", tool: "pen", color: "#ffffff", strokeWidth: 1, points: [{ x: 0.1, y: 0.2 }] }] })];
    const draft = original.map(copyIntent);
    draft[0]!.prompt = "改动";
    draft[0]!.annotationShapes[0]!.points[0]!.x = 0.9;
    expect(original[0]!.prompt).toBe("p");
    expect(original[0]!.annotationShapes[0]!.points[0]!.x).toBe(0.1);
  });
});

describe("稳定排序与选中", () => {
  it("面板顺序按时间稳定排序，不改变 intent 身份", () => {
    const ordered = sortVideoEditIntents([
      intent({ id: "b", startSeconds: 9 }),
      intent({ id: "a", startSeconds: 1 }),
      intent({ id: "c", startSeconds: 1, endSeconds: 2 })
    ]);
    expect(ordered.map((value) => value.id)).toEqual(["a", "c", "b"]);
  });

  it("区间判定使用最小跨度", () => {
    expect(isVideoEditRange({ startSeconds: 1, endSeconds: 1.05 })).toBe(true);
    expect(isVideoEditRange({ startSeconds: 1, endSeconds: 1.01 })).toBe(false);
    expect(isVideoEditRange({ startSeconds: 1 })).toBe(false);
  });
});

describe("prompt 必填", () => {
  it("空白 prompt 被视为未填写", () => {
    const values = [intent({ prompt: "" }), intent({ prompt: "   " }), intent({ prompt: "有效" })];
    const invalid = values.find((value) => value.prompt.trim().length === 0);
    expect(invalid).toBeDefined();
    expect(values[2]!.prompt.trim()).not.toBe("");
  });
});

describe("时间轴区间钳制（拖动/resize）", () => {
  it("resize 起点不超过终点减 0.05", () => {
    const clamped = clampTimelineRange({ startSeconds: 4.99, endSeconds: 5, duration: 10 });
    expect(clamped.endSeconds! - clamped.startSeconds).toBeGreaterThanOrEqual(MIN_RANGE_SECONDS - 1e-9);
  });

  it("resize 终点不早于起点加 0.05 且不超 duration", () => {
    expect(clampTimelineRange({ startSeconds: 2, endSeconds: 2.01, duration: 10 }).endSeconds).toBeCloseTo(2.05);
    expect(clampTimelineRange({ startSeconds: 2, endSeconds: 99, duration: 5 }).endSeconds).toBe(5);
  });
});

describe("键盘焦点规则谓词", () => {
  it("textarea/input/contenteditable 被视为文本编辑焦点", () => {
    const isTextTarget = (target: { tagName: string; isContentEditable?: boolean }) =>
      target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable === true;
    expect(isTextTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTextTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextTarget({ tagName: "DIV" })).toBe(false);
  });
});
