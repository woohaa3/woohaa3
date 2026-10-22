/**
 * 模型聚焦信息面板派生回归
 * （change: 2026-10-18-simplify-model-focus-panel）。
 *
 * ModelInfoPanel 本身依赖完整 Cordis Context 与 canvasRuntime，属集成路径；这里覆盖其
 * 纯派生与格式化逻辑，避免在单测中伪造整套宿主服务。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Context } from "@deepseek-ai/cordis";
import {
  modelSceneStatistics,
  type PreparedModelResource,
  type SceneV2Op
} from "@woohaa3/contracts";
import {
  ModelInfoPanel,
  formatCount,
  modelInfoRows,
  readModelInfo
} from "./model-info-panel.js";

const OPS: SceneV2Op[] = [
  {
    t: "box",
    id: "b",
    parent: null,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: null,
    color: "#ffffff",
    size: [1, 1, 1]
  },
  {
    t: "sphere",
    id: "s",
    parent: null,
    position: [0, 1, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: null,
    color: "#ffffff",
    radius: 0.5
  }
];

describe("formatCount / modelInfoRows", () => {
  it("千分位格式化大数字并兜底非法值", () => {
    expect(formatCount(528)).toBe("528");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(-3)).toBe("0");
  });

  it("基础行固定为对象/点数/面数，附加项按内容出现", () => {
    const plain = modelInfoRows(modelSceneStatistics(OPS));
    expect(plain.map((row) => row.label)).toEqual(["对象", "点数", "面数"]);
    expect(plain.find((row) => row.label === "对象")!.value).toBe("2");
    expect(plain.find((row) => row.label === "点数")!.value).toBe(formatCount(modelSceneStatistics(OPS).vertices));
    expect(plain.find((row) => row.label === "面数")!.value).toBe("540");

    const withExtras = modelInfoRows({ objects: 1, groups: 1, vertices: 8, triangles: 12, materials: 2, animations: 1 });
    expect(withExtras.map((row) => row.label)).toEqual(["对象", "点数", "面数", "分组", "材质", "动画"]);
  });

  it("没有内容时不产生行", () => {
    expect(modelInfoRows(null)).toEqual([]);
  });
});

describe("readModelInfo", () => {
  it("有内容时 ready 且统计与 contracts 同源", () => {
    const info = readModelInfo({ operations: OPS, loading: false, error: null });
    expect(info.ready).toBe(true);
    expect(info.stats).toEqual(modelSceneStatistics(OPS));
    expect(info.rows.length).toBe(3);
  });

  it("无内容但仍准备中时报告 loading 而不是 0", () => {
    const info = readModelInfo({ operations: null, loading: true, error: null });
    expect(info.ready).toBe(false);
    expect(info.loading).toBe(true);
    expect(info.rows).toEqual([]);
  });

  it("失败信息透传且不显示规模", () => {
    const info = readModelInfo({ operations: null, loading: false, error: "模型脚本执行失败" });
    expect(info.ready).toBe(false);
    expect(info.error).toBe("模型脚本执行失败");
    expect(info.rows).toEqual([]);
  });
});

/** 与 model-scene provider 的最小形状（仅信息面板需要的字段）。 */
function resource(key: string, ops: readonly SceneV2Op[]): PreparedModelResource {
  return {
    resourceVersion: "woohaa-prepared-model-resource-v1",
    sceneVersion: "woohaa-model-scene-ir-v2",
    signature: key,
    resourceKey: key,
    ops,
    aabb: null,
    extent: 2,
    payload: "{}"
  };
}

describe("聚焦面板移除镜头控制（结构约定）", () => {
  it("普通模型不再需要 prepared camera 资源即可展示规模", () => {
    // 规模只来自 Scene IR；模型节点无需 modelCameras 即可得到非零点数/面数。
    const info = readModelInfo({ operations: resource("k", OPS).ops, loading: false, error: null });
    expect(info.stats?.objects).toBe(2);
    expect(info.stats?.triangles).toBeGreaterThan(0);
  });
});

describe("ModelInfoPanel 渲染", () => {
  /** 最小 Context：只提供面板读取的 canvasState / canvasRuntime / modelScenes。 */
  function fakeContext(input: { resources: Map<string, PreparedModelResource>; override?: readonly SceneV2Op[]; nodeData?: Record<string, unknown> }) {
    return {
      canvasState: {
        subscribe: () => () => undefined,
        getWorkingCanvas: () => ({ nodeData: input.nodeData ?? {} }),
        getCanvas: () => null
      },
      canvasRuntime: { modelSceneOverride: () => (input.override ? { version: "v2", ops: input.override } : null) },
      get: () => ({
        getResources: () => input.resources,
        isLoading: () => false,
        subscribe: () => () => undefined
      })
    } as unknown as Context;
  }

  it("就绪时渲染对象/点数/面数并标注估算口径", () => {
    const resources = new Map([["m1", resource("k", OPS)]]);
    const html = renderToStaticMarkup(<ModelInfoPanel ctx={fakeContext({ resources })} nodeId="m1" />);
    expect(html).toContain("模型信息");
    expect(html).toContain("data-model-info-rows");
    expect(html).toContain("对象");
    expect(html).toContain("面数");
    expect(html).toContain("估算");
    expect(html).toContain("已就绪");
  });

  it("无内容时显示准备中文案而不显示 0", () => {
    const html = renderToStaticMarkup(<ModelInfoPanel ctx={fakeContext({ resources: new Map() })} nodeId="m1" />);
    expect(html).toContain("准备中");
    expect(html).not.toContain("data-model-info-rows");
  });

  it("历史 override 优先于当前资源", () => {
    const resources = new Map([["m1", resource("k", OPS)]]);
    const override: SceneV2Op[] = [OPS[0]!];
    const html = renderToStaticMarkup(<ModelInfoPanel ctx={fakeContext({ resources, override })} nodeId="m1" />);
    // override 只有一个对象：对象数 1，不再是 OPS 的 2。
    expect(html).toMatch(/对象<\/dt><dd>1</);
  });
});
