import { describe, expect, it } from "vitest";
import { readBody } from "./render-scene/node-projection.js";
import type { CanvasNodeData } from "./domain/index.js";

describe("空视频节点正文", () => {
  it("没有产出时不显示额外状态或配置说明", () => {
    const cases: (CanvasNodeData | undefined)[] = [undefined, {}, { taskStatus: "idle" }];
    for (const data of cases) {
      expect(readBody("video", data, new Map())).toBe("");
    }
  });
});
