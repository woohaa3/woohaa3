import { describe, expect, it, vi } from "vitest";
import type { EditorInstance } from "../../editor-wasm.js";
import type { FeatureHandleContext } from "../contracts.js";
import { beginFilter, filterCatalogue, filterDraftState, filterLast, filterLayerSources, filterMapSources, filterPathSources, repeatLastFilter } from "./wasm-handle.js";

/**
 * WASM 适配的端口缺失边界（U46–U49）。
 *
 * 清单/上次滤镜/重复/控制点是本 change 新加的 glue 导出：宿主或旧产物可能还没有它们。
 * 这里钉住「缺失即明确失败（`missing-port`）」，不静默回退成硬编码参数，也不假装成功。
 */

const DRAFT = { filter: "filter.blur.gaussianBlur", label: "高斯模糊", category: "模糊", kind: "Simple", layer: 1, params: { radius: 2 } };

/** 只提供草稿四步的内核替身：正是旧 glue 的形状。 */
function context(extra: Partial<Record<keyof EditorInstance, unknown>> = {}): FeatureHandleContext {
  const instance = {
    beginFilter: () => JSON.stringify(DRAFT),
    updateFilter: () => JSON.stringify(DRAFT),
    commitFilter: () => JSON.stringify({ changed: true }),
    cancelFilter: () => JSON.stringify({ cancelled: true }),
    ...extra
  } as unknown as EditorInstance;
  return {
    instance,
    call: <T>(run: (value: EditorInstance) => T) => {
      try {
        return { ok: true as const, value: run(instance) };
      } catch (error) {
        return { ok: false as const, code: "kernel-failed", message: String(error) };
      }
    }
  };
}

describe("滤镜 WASM 适配的端口缺失与解码", () => {
  it("新端口缺失时返回 missing-port，可读原因里点名是哪一项", () => {
    const ctx = context();
    for (const [run, label] of [
      [() => filterCatalogue.call(ctx), "滤镜清单"],
      [() => filterLast.call(ctx), "上次滤镜"],
      [() => repeatLastFilter.call(ctx), "重复上次滤镜"],
      [() => filterDraftState.call(ctx), "滤镜草稿状态"],
      [() => filterMapSources.call(ctx), "位移图来源"],
      [() => filterLayerSources.call(ctx), "粘贴图层来源"],
      [() => filterPathSources.call(ctx), "火焰路径来源"]
    ] as const) {
      const result = run();
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("不该成功");
      expect(result.code).toBe("missing-port");
      expect(result.message).toContain(label);
    }
  });

  it("端口存在时解码成域类型；畸形回执明确失败而不是当成空状态", () => {
    const catalogue = {
      filters: [{ id: "filter.blur.gaussianBlur", label: "高斯模糊", category: "模糊", kind: "simple", usesColours: false, needsMap: false, params: [{ key: "radius", kind: "number", min: 0.1, max: 1000, default: 1, choices: [] }] }],
      gallery: { categories: [], filters: [] },
      limits: { maxEffects: 32, maxPins: 16, maxPlanes: 8, maxParams: 96, maxResourcePoints: 64, seedMax: 4294967295 }
    };
    const ok = filterCatalogue.call(context({ filterCatalogueJson: () => JSON.stringify(catalogue) }));
    expect(ok.ok && ok.value.filters[0]!.id).toBe("filter.blur.gaussianBlur");

    expect(filterDraftState.call(context({ filterDraftStateJson: () => "null" }))).toEqual({ ok: true, value: null });
    // 有响应但解不出来：版本不匹配要报错，不能静默当作「没有草稿」。
    expect(filterDraftState.call(context({ filterDraftStateJson: () => JSON.stringify({ active: true }) })).ok).toBe(false);
    expect(filterCatalogue.call(context({ filterCatalogueJson: () => "{}" })).ok).toBe(false);
  });

  it("草稿回执解码为规范参数；重复上次只取 draft 字段", () => {
    const begun = beginFilter.call(context(), "filter.blur.gaussianBlur", { radius: 2 });
    expect(begun.ok && begun.value.params).toEqual({ radius: 2 });

    const repeated = repeatLastFilter.call(
      context({ repeatLastFilter: () => JSON.stringify({ repeated: true, draft: DRAFT }) })
    );
    expect(repeated.ok && repeated.value.filter).toBe("filter.blur.gaussianBlur");
    // 缺 draft 的回执视为无效，不把空对象当成功。
    expect(repeatLastFilter.call(context({ repeatLastFilter: () => JSON.stringify({ repeated: true }) })).ok).toBe(false);
  });

  it("图内控制点先校验再调用内核", async () => {
    const { filterNormalizePoint } = await import("./wasm-handle.js");
    expect(filterNormalizePoint.call(context(), 1, 1, 0, 10).ok).toBe(false);
    const normalize = vi.fn(() => JSON.stringify({ point: [0.5, 0.25] }));
    const result = filterNormalizePoint.call(context({ filterNormalizePoint: normalize }), 4, 2, 8, 8);
    expect(result).toEqual({ ok: true, value: [0.5, 0.25] });
    expect(normalize).toHaveBeenCalledWith(4, 2, 8, 8);
    // 内核回非有限值同样拒绝。
    expect(filterNormalizePoint.call(context({ filterNormalizePoint: () => JSON.stringify({ point: [0.5] }) }), 4, 2, 8, 8).ok).toBe(false);
  });

  it("位移图来源解码成文档列表与每份文档的图层；端口回非列表时明确失败", () => {
    const documents = {
      documents: [{
        index: 1,
        name: "位移图.pcraft",
        width: 800,
        height: 600,
        active: false,
        layers: [{ id: 7, name: "位移层" }]
      }]
    };
    expect(filterMapSources.call(context({ filterMapSourcesJson: () => JSON.stringify(documents) })))
      .toEqual({
        ok: true,
        value: [{ index: 1, name: "位移图.pcraft", width: 800, height: 600, active: false, layers: [{ id: 7, name: "位移层" }] }]
      });
    // 老端口不带 layers：文档仍可用，只是没有可选图层（退化成压平整份文档）。
    const legacy = { documents: [{ index: 1, name: "位移图.pcraft", width: 800, height: 600, active: false }] };
    expect(filterMapSources.call(context({ filterMapSourcesJson: () => JSON.stringify(legacy) })))
      .toEqual({ ok: true, value: [{ index: 1, name: "位移图.pcraft", width: 800, height: 600, active: false, layers: [] }] });
    expect(filterMapSources.call(context({ filterMapSourcesJson: () => "{}" })).ok).toBe(false);
  });

  it("粘贴图层来源解码成图层列表；端口回非列表时明确失败", () => {
    const layers = { layers: [{ id: 3, name: "图层 2", active: true, width: 800, height: 600 }] };
    expect(filterLayerSources.call(context({ filterLayerSourcesJson: () => JSON.stringify(layers) })))
      .toEqual({ ok: true, value: [{ id: 3, name: "图层 2", active: true, width: 800, height: 600 }] });
    // 没有 layers 字段意味着端口形状不对：要报错，不能当成「文档里没有图层」。
    expect(filterLayerSources.call(context({ filterLayerSourcesJson: () => "{}" })).ok).toBe(false);
  });

  it("火焰路径来源解码成路径名；端口回非列表时明确失败", () => {
    const paths = { paths: [{ name: "路径 1" }], hasWorkPath: true };
    expect(filterPathSources.call(context({ filterPathSourcesJson: () => JSON.stringify(paths) })))
      .toEqual({ ok: true, value: { paths: ["路径 1"], hasWorkPath: true } });
    expect(filterPathSources.call(context({ filterPathSourcesJson: () => "{}" })).ok).toBe(false);
  });
});
